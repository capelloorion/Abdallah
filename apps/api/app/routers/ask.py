"""``POST /v1/conversations/{id}/ask`` — ask a question in a conversation (roadmap api:2.2).

Flow: validate → find the conversation → read the last ``HISTORY_MESSAGES`` stored messages →
**store the question** → run ``app.ai.graph.ask`` (retrieve → answer) → store the answer.

* The question is stored before retrieval, so a model or search failure keeps it (and answers
  ``503 ai_unavailable``); no assistant message is stored for a failed answer.
* ``token_count`` is the answer's **output** tokens (decision Q6); ``None`` if the model did not
  report usage. A question over ``MAX_QUESTION_CHARS`` is ``413 payload_too_large`` (Q5).
* Conversations are shared (ADR-0014), so the history sent to the model contains other users'
  turns. It goes only as human/assistant messages — never as a system message (threat model A1).
* Stored text is bounded (``MAX_ANSWER_CHARS``) and ``citations`` are validated before they are
  stored: they come only from retrieval, with a ``path`` that is a plain relative path, because
  the web renders them to every user (threat model T3/T5).
* Nothing here logs a question, an answer, a title or a path — counts and outcomes only (rule 70).
"""

from __future__ import annotations

import asyncio
import functools
import json
import re
import unicodedata
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from pydantic import AfterValidator, BaseModel, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.graph import Citation as RetrievedCitation
from app.ai.graph import ask, build_graph
from app.ai.streaming import sse, sse_response, stream_events
from app.ai.telemetry import error_kind
from app.ai.tools.retrieve import clean_title, fallback_title
from app.db import get_session
from app.errors import AIUnavailable, ApiError, ErrorBody, NotFound
from app.logging_config import get_logger
from app.models.conversation import TITLE_MAX_LENGTH, Conversation, Message
from app.repositories import conversations as repo
from app.routers.conversations import Citation

router = APIRouter(prefix="/conversations", tags=["conversations"])
_log = get_logger("app.ask")

DbSession = Annotated[AsyncSession, Depends(get_session)]

# Decision Q5: longer is ``413 payload_too_large`` (counted in characters = code points).
MAX_QUESTION_CHARS = 4000
# ``messages.content`` is NVARCHAR(max): the database has no limit, so this one is the bound.
MAX_ANSWER_CHARS = 20_000
# Older turns are cut to this when sent to the model (stored text is unchanged); cost control.
MAX_HISTORY_MESSAGE_CHARS = 4000
# The whole retrieve + model round trip; the web BFF's hop timeout is longer (300 s).
ASK_TIMEOUT_SECONDS = 60.0
MAX_CITATIONS = 20
MAX_CITATION_PATH_CHARS = 500


_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def _plain_text(value: str) -> str:
    """Reject a lone surrogate (JSON can carry one; it cannot be stored or sent as UTF-8) and
    control characters other than tab, newline and carriage return (a NUL can truncate or break
    what the database, the model or the search service receives).
    """
    value.encode("utf-8")  # UnicodeEncodeError is a ValueError → 422
    if _CONTROL_CHARS.search(value):
        raise ValueError("control characters are not allowed")
    return value


Question = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
    AfterValidator(_plain_text),
]


class AskRequest(BaseModel):
    question: Question


class AskResponse(BaseModel):
    message_id: uuid.UUID
    answer: str
    citations: list[Citation]


@functools.cache
def _default_graph() -> Any:
    # Compiling connects to nothing; the model and the retriever are built on the first run.
    return build_graph()


def get_ask_graph() -> Any:
    """The compiled ``retrieve → answer`` graph. Tests override this dependency."""
    return _default_graph()


AskGraph = Annotated[Any, Depends(get_ask_graph)]

# ---- what is stored and returned -------------------------------------------------------------

_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")
# Unicode categories that let a path read differently from what it is: control (Cc, incl. C1),
# format (Cf: bidi marks/embedding/override/isolate, zero-width, BOM), line/paragraph separators
# (Zl, Zp) and surrogates (Cs). Plus characters that are markup or separators in other contexts.
_BAD_PATH_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})
_BAD_PATH_CHARS = frozenset("\\<>\"'")


def is_safe_citation_path(path: str) -> bool:
    """A plain relative path: no scheme, not rooted, no ``..`` segment, no control, format
    (bidi, zero-width) or markup
    characters, bounded length. Still shown as text only; this keeps a stored path from ever
    being a ``javascript:``/``file:`` link or a traversal if a client links it (threat model T5).
    """
    return bool(
        path
        and path == path.strip()
        and len(path) <= MAX_CITATION_PATH_CHARS
        and not any(
            c in _BAD_PATH_CHARS or unicodedata.category(c) in _BAD_PATH_CATEGORIES for c in path
        )
        and not path.startswith("/")
        and not _SCHEME.match(path)
        and ".." not in path.split("/")
    )


def sanitize_citations(citations: list[RetrievedCitation]) -> list[Citation]:
    """Retrieval's citations that are safe to store and show, at most ``MAX_CITATIONS``.

    A citation whose path fails the check is dropped (the count is logged, never the value);
    the title is re-cleaned and falls back to the file name.
    """
    safe: list[Citation] = []
    for item in citations:
        path = item.get("path", "")
        if not is_safe_citation_path(path):
            continue
        raw_title = (
            (item.get("title") or "").encode("utf-8", "replace").decode("utf-8")
        )  # no lone surrogate
        title = clean_title(raw_title) or clean_title(fallback_title(path)) or path
        safe.append(Citation(title=title, path=path))
        if len(safe) == MAX_CITATIONS:
            break
    return safe


def _storable(text: str) -> str:
    """The answer as it is stored and returned: valid UTF-8, trimmed, at most
    ``MAX_ANSWER_CHARS`` characters.
    """
    return text.encode("utf-8", "replace").decode("utf-8").strip()[:MAX_ANSWER_CHARS]


def title_from_question(question: str) -> str | None:
    """The first question as a title: control/bidi characters out, whitespace collapsed, at most
    200 characters — and at most 200 UTF-16 code units, which is what ``NVARCHAR(200)`` counts.
    """
    title = clean_title(question)
    while title and len(title.encode("utf-16-le")) // 2 > TITLE_MAX_LENGTH:
        title = title[:-1]
    return title.strip() or None


def _history(stored: list[Message]) -> list[AnyMessage]:
    """Stored turns as human/assistant messages only (never a system message), each bounded."""
    turns: list[AnyMessage] = []
    for message in stored:
        text = message.content[:MAX_HISTORY_MESSAGE_CHARS]
        if message.role == "user":
            turns.append(HumanMessage(content=text))
        elif message.role == "assistant":
            turns.append(AIMessage(content=text))
    return turns


async def _run_ask(graph: Any, question: str, history: list[AnyMessage]) -> Any:
    async with asyncio.timeout(ASK_TIMEOUT_SECONDS):
        return await ask(graph, question, history=history)


def _citations_json(citations: list[Citation]) -> str | None:
    """The validated citations as the JSON stored in ``messages.citations``; ``NULL`` for none."""
    if not citations:
        return None
    return json.dumps([c.model_dump() for c in citations], ensure_ascii=False)


async def _begin(
    session: AsyncSession, conversation_id: uuid.UUID, question: str
) -> tuple[Conversation, list[AnyMessage]]:
    """What both ask routes do before the model runs: check the question's length, find the
    conversation, read the history, then **store the question**.
    """
    if len(question) > MAX_QUESTION_CHARS:
        raise ApiError("payload_too_large", status_code=413)
    conversation = await repo.get_conversation(session, conversation_id)
    if conversation is None:
        raise NotFound()
    history = _history(await repo.recent_messages(session, conversation_id))
    await repo.add_user_message(
        session, conversation, question, new_title=title_from_question(question)
    )
    return conversation, history


@router.post(
    "/{conversation_id}/ask",
    response_model=AskResponse,
    responses={
        404: {"model": ErrorBody, "description": "Unknown conversation (`not_found`)"},
        413: {
            "model": ErrorBody,
            "description": f"Question over {MAX_QUESTION_CHARS} characters (`payload_too_large`)",
        },
        503: {
            "model": ErrorBody,
            "description": "The model or search did not answer, or took over 60 s "
            "(`ai_unavailable`). The question is kept; no answer is stored.",
        },
    },
)
async def ask_question(
    session: DbSession,
    graph: AskGraph,
    conversation_id: uuid.UUID,
    body: AskRequest,
) -> AskResponse:
    """Answer a question from the knowledge base, with the conversation's last 10 messages as
    history, and store both turns.

    A conversation still called "New conversation" is titled with its first question.
    """
    conversation, history = await _begin(session, conversation_id, body.question)

    try:
        answer = await _run_ask(graph, body.question, history)
    except Exception as exc:  # noqa: BLE001 — any model/search failure is the same bounded 503
        _log.warning("ask failed", outcome="error", error_kind=error_kind(exc))
        raise AIUnavailable() from None
    text = _storable(answer.text)
    if not text:
        _log.warning("ask failed", outcome="empty_answer")
        raise AIUnavailable()

    citations = sanitize_citations(answer.citations)
    stored = await repo.add_assistant_message(
        session,
        conversation,
        text,
        citations_json=_citations_json(citations),
        token_count=answer.output_tokens,
    )
    _log.info(
        "question answered",
        history=len(history),
        citations=len(citations),
        dropped_citations=len(answer.citations) - len(citations),
        output_tokens=answer.output_tokens,
    )
    return AskResponse(message_id=stored.id, answer=text, citations=citations)


# ---- the streaming variant (roadmap api:3.1) --------------------------------------------------

_STREAM_DOC = (
    "Server-Sent Events, one `event:` and one JSON `data:` line per frame: "
    '`sources` `{"citations": [{"title", "path"}], "count"}` once retrieval is done, then '
    '`token` `{"text"}` for each piece of the answer, then `done` `{"citations", "input_tokens", '
    '"output_tokens"}`. The answer is stored before `done` is sent. A failure after the first '
    'frame is `error` `{"error_kind"}` and the stream ends (the question is kept, no answer is '
    "stored); a failure before the first frame is the normal JSON error (`503 ai_unavailable`). "
    "The `x-trace-id` header is on the response; the `error` frame carries no trace id."
)

Events = AsyncIterator[tuple[str, dict[str, Any]]]

# What ``app.ai.telemetry.error_kind`` can return; anything else is shown as plain "error".
_ERROR_KINDS = frozenset({"timeout", "rate_limited", "auth", "network", "error"})


def _bounded_kind(value: object) -> str:
    """An ``error_kind`` that is safe to put in a frame or a log line (never free text)."""
    return value if isinstance(value, str) and value in _ERROR_KINDS else "error"


class EventStreamResponse(StreamingResponse):
    """Only so OpenAPI says ``text/event-stream`` instead of an extra ``application/json``."""

    media_type = "text/event-stream"


async def _next_event(events: Events, deadline: float) -> Any:
    """The next ``(event, data)`` pair; ``StopAsyncIteration`` at the end, ``TimeoutError`` once
    the whole round trip has taken ``ASK_TIMEOUT_SECONDS``. The deadline is wall-clock for the whole
    stream: it bounds the waits for the model and search (not the writes to the client), but time
    spent suspended at a ``yield`` counts against it.
    """
    async with asyncio.timeout_at(deadline):
        return await anext(events)


async def _close(events: Events) -> None:
    aclose = getattr(events, "aclose", None)
    if aclose is not None:
        try:
            await aclose()
        except Exception as exc:  # noqa: BLE001 — cleanup must not mask the real outcome
            _log.debug("ask stream cleanup failed", kind=type(exc).__name__)


async def _stream_frames(
    session: AsyncSession,
    conversation: Conversation,
    events: Events,
    deadline: float,
    *,
    retrieved: int,
    raw_citations: int,
    citations: list[Citation],
    history_size: int,
    is_disconnected: Callable[[], Awaitable[bool]],
) -> AsyncIterator[str]:
    """``sources`` → ``token``* → ``done`` — the answer is stored before ``done`` is yielded, so a
    client that leaves earlier (or a failure) stores no assistant message. One window stays: a
    client that leaves while the answer is being written may still get it stored (it is checked
    just before the write, not during it).
    """
    shown = [c.model_dump() for c in citations]
    parts: list[str] = []
    size = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    try:
        yield sse("sources", {"citations": shown, "count": retrieved})
        while True:
            try:
                event, data = await _next_event(events, deadline)
            except StopAsyncIteration:
                _log.warning("ask stream failed", outcome="no_terminal_frame")
                yield sse("error", {"error_kind": "error"})
                return
            except Exception as exc:  # noqa: BLE001 — the frame carries a bounded kind only
                kind = error_kind(exc)
                _log.warning("ask stream failed", outcome="error", error_kind=kind)
                yield sse("error", {"error_kind": kind})
                return
            if event == "token":
                # Valid UTF-8 (a lone surrogate would break the encoder mid-stream), then the cap.
                text = str(data.get("text", "")).encode("utf-8", "replace").decode("utf-8")
                room = MAX_ANSWER_CHARS - size
                capped = len(text) > room
                text = text[:room]
                size += len(text)
                parts.append(text)
                if text:
                    yield sse("token", {"text": text})
                if capped:  # past the cap: stop here, so the stored text is what was streamed
                    break
            elif event == "done":
                input_tokens, output_tokens = data.get("input_tokens"), data.get("output_tokens")
                break
            elif event == "error":
                kind = _bounded_kind(data.get("error_kind"))
                _log.warning("ask stream failed", outcome="error", error_kind=kind)
                yield sse("error", {"error_kind": kind})
                return

        text = _storable("".join(parts))
        if not text:
            _log.warning("ask stream failed", outcome="empty_answer")
            yield sse("error", {"error_kind": "error"})
            return
        if await is_disconnected():  # the client is gone: do not store an answer it never got
            _log.info("ask stream ended by the client", outcome="client_disconnected")
            return
        try:
            await repo.add_assistant_message(
                session,
                conversation,
                text,
                citations_json=_citations_json(citations),
                token_count=output_tokens,
            )
        except Exception as exc:  # noqa: BLE001 — a failed write is a failed answer, never `done`
            _log.error("ask stream failed", outcome="store_failed", kind=type(exc).__name__)
            yield sse("error", {"error_kind": "error"})
            return
        _log.info(
            "question streamed",
            history=history_size,
            citations=len(citations),
            dropped_citations=raw_citations - len(citations),
            output_tokens=output_tokens,
        )
        yield sse(
            "done",
            {"citations": shown, "input_tokens": input_tokens, "output_tokens": output_tokens},
        )
    except asyncio.CancelledError, GeneratorExit:
        _log.info("ask stream ended by the client", outcome="client_disconnected")
        raise
    finally:
        await _close(events)


@router.post(
    "/{conversation_id}/ask/stream",
    response_model=None,
    response_class=EventStreamResponse,
    responses={
        200: {
            "description": _STREAM_DOC,
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
        404: {"model": ErrorBody, "description": "Unknown conversation (`not_found`)"},
        413: {
            "model": ErrorBody,
            "description": f"Question over {MAX_QUESTION_CHARS} characters (`payload_too_large`)",
        },
        503: {
            "model": ErrorBody,
            "description": "The model or search failed, or took over 60 s, before the first "
            "frame (`ai_unavailable`). The question is kept; no answer is stored.",
        },
    },
)
async def ask_question_stream(
    session: DbSession,
    graph: AskGraph,
    conversation_id: uuid.UUID,
    body: AskRequest,
    request: Request,
) -> StreamingResponse:
    """Like `/ask`, but streams the answer as Server-Sent Events. Same validation, history,
    title rule, bounds and citation checks; the difference is how the answer is delivered.
    """
    conversation, history = await _begin(session, conversation_id, body.question)

    events = stream_events(graph, body.question, history=history)
    deadline = asyncio.get_running_loop().time() + ASK_TIMEOUT_SECONDS
    try:
        event, data = await _next_event(events, deadline)
    except asyncio.CancelledError:
        await _close(events)
        raise
    except Exception as exc:  # noqa: BLE001 — before the first frame this is a plain JSON 503
        await _close(events)
        _log.warning("ask stream failed", outcome="error", error_kind=error_kind(exc))
        raise AIUnavailable() from None
    if event != "sources":  # an `error` frame (retrieval failed) or anything unexpected
        await _close(events)
        _log.warning(
            "ask stream failed",
            outcome="error",
            error_kind=_bounded_kind(data.get("error_kind")) if event == "error" else "protocol",
        )
        raise AIUnavailable()

    retrieved_citations = data.get("citations", [])
    return sse_response(
        _stream_frames(
            session,
            conversation,
            events,
            deadline,
            retrieved=int(data.get("count", 0)),
            raw_citations=len(retrieved_citations),
            citations=sanitize_citations(retrieved_citations),
            history_size=len(history),
            is_disconnected=request.is_disconnected,
        )
    )
