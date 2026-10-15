"""``/v1/conversations`` — create, list and read chat conversations (roadmap api:1.2).

Conversations are shared (ADR-0014): every caller sees every conversation. Titles and message
text are user content, so nothing here logs them — only ids' existence, counts and outcomes
(``.claude/rules/50-security.md``, rule 70).

Errors follow ``app/errors.py``: ``404 not_found`` for an unknown id, ``422 validation_error``
for a bad body, query or id (field details are logged by the handler, never returned).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import (
    AfterValidator,
    BaseModel,
    Field,
    StringConstraints,
    TypeAdapter,
    field_validator,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorBody, NotFound
from app.logging_config import get_logger
from app.models.conversation import TITLE_MAX_LENGTH, Message
from app.repositories import conversations as repo

router = APIRouter(prefix="/conversations", tags=["conversations"])
_log = get_logger("app.conversations")

DbSession = Annotated[AsyncSession, Depends(get_session)]


def _as_utc(value: datetime) -> datetime:
    """The columns hold naive UTC; the API always speaks timezone-aware UTC."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


def _fits_the_column(value: str) -> str:
    """``NVARCHAR(200)`` counts UTF-16 code units, not characters: an emoji is two.

    Without this check a title of 101-200 emoji would pass the length check, overflow the column
    and surface as a 500 instead of a 422.
    """
    if len(value.encode("utf-16-le")) // 2 > TITLE_MAX_LENGTH:
        raise ValueError(f"title is longer than {TITLE_MAX_LENGTH} UTF-16 code units")
    return value


Title = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=TITLE_MAX_LENGTH),
    AfterValidator(_fits_the_column),
]


class ConversationCreate(BaseModel):
    """Optional body of ``POST /v1/conversations``."""

    title: Title | None = None


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    created_at: UtcDatetime
    updated_at: UtcDatetime


class ConversationSummary(BaseModel):
    id: uuid.UUID
    title: str
    updated_at: UtcDatetime


class ConversationList(BaseModel):
    items: list[ConversationSummary]
    count: int = Field(description="How many conversations are on this page.")
    next_cursor: str | None = Field(
        default=None,
        description=(
            "Opaque. Pass it as `cursor` to get the next page; `null` when this is the last one."
        ),
    )


# A citation covers at most this many chunks (retrieval returns a handful).
MAX_CITATION_CHUNKS = 50


def clean_chunks(value: object, *, retrieved: int | None = None) -> list[int] | None:
    """Chunk numbers made safe to store and show: whole numbers from 1 up to the number retrieved
    (or ``MAX_CITATION_CHUNKS`` when that is not known), unique, ascending, at most
    ``MAX_CITATION_CHUNKS``. A value that is not a list is ``None`` (unknown); odd entries inside a
    list are dropped, so one bad value never makes a stored row unreadable.
    """
    if not isinstance(value, list):
        return None
    ceiling = MAX_CITATION_CHUNKS if retrieved is None else min(retrieved, MAX_CITATION_CHUNKS)
    numbers = sorted({n for n in value if type(n) is int and 1 <= n <= ceiling})
    # A list that held entries but none usable is unknown, not "covers no chunks".
    return numbers if numbers or not value else None


class Citation(BaseModel):
    title: str
    path: str
    chunks: list[int] | None = Field(
        default=None,
        max_length=MAX_CITATION_CHUNKS,
        description=(
            "Numbers of the retrieved chunks (the `[n]` markers in the answer) that came from this "
            "document, ascending. `null` when unknown (an answer stored before this field existed)."
        ),
    )

    @field_validator("chunks", mode="before")
    @classmethod
    def _tolerant_chunks(cls, value: object) -> list[int] | None:
        return clean_chunks(value)


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    citations: list[Citation] | None
    created_at: UtcDatetime


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    truncated: bool


_citations_adapter = TypeAdapter(list[Citation])
# Stored citations are a short list of {title, path}; anything bigger is not parsed at all.
MAX_CITATIONS_JSON_CHARS = 64 * 1024


def _parse_citations(raw: str | None) -> list[Citation] | None:
    """The stored JSON as citations; ``None`` for no citations or a value of the wrong shape.

    The database only checks ``ISJSON``; a malformed value must not break reading the whole
    conversation, so it is dropped and only the fact is logged (never the content).
    """
    if raw is None:
        return None
    if len(raw) > MAX_CITATIONS_JSON_CHARS:
        _log.warning("message citations unreadable", outcome="dropped", reason="too_large")
        return None
    try:
        return _citations_adapter.validate_python(json.loads(raw))
    except ValueError, RecursionError:  # ValidationError is a ValueError; deep nesting recurses
        _log.warning("message citations unreadable", outcome="dropped", reason="invalid")
        return None


def _message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        role=message.role,
        content=message.content,
        citations=_parse_citations(message.citations),
        created_at=message.created_at,
    )


@router.post("", status_code=201, response_model=ConversationOut)
async def create_conversation(
    session: DbSession, body: ConversationCreate | None = None
) -> ConversationOut:
    """Start a conversation. A missing or blank title becomes "New conversation"."""
    conversation = await repo.create_conversation(session, body.title if body else None)
    _log.info("conversation created")
    return ConversationOut.model_validate(conversation, from_attributes=True)


def _check_cursor(value: str) -> str:
    """Refuse text that is not a cursor this api issued (a `ValueError` becomes a 422)."""
    try:
        repo.Cursor.decode(value)
    except repo.InvalidCursor:
        raise ValueError("not a cursor") from None
    return value


@router.get("", response_model=ConversationList)
async def list_conversations(
    session: DbSession,
    limit: Annotated[int, Query(ge=1, le=repo.MAX_LIST_LIMIT)] = repo.DEFAULT_LIST_LIMIT,
    cursor: Annotated[
        str | None,
        Query(
            max_length=repo.MAX_CURSOR_LENGTH,
            description="The `next_cursor` of the previous page. Omit it for the first page.",
        ),
        AfterValidator(lambda v: v if v is None else _check_cursor(v)),
    ] = None,
) -> ConversationList:
    """The most recently updated conversations, newest first, one page at a time.

    A malformed or altered `cursor` is `422 validation_error`.
    """
    after = repo.Cursor.decode(cursor) if cursor is not None else None
    page = await repo.list_conversations(session, limit, after)
    items = [
        ConversationSummary.model_validate(row, from_attributes=True) for row in page.conversations
    ]
    _log.info(
        "conversations listed",
        count=len(items),
        paged=cursor is not None,
        more=page.next_cursor is not None,
    )
    return ConversationList(items=items, count=len(items), next_cursor=page.next_cursor)


@router.get(
    "/{conversation_id}",
    response_model=ConversationDetail,
    responses={404: {"model": ErrorBody, "description": "Unknown conversation (`not_found`)"}},
)
async def get_conversation(session: DbSession, conversation_id: uuid.UUID) -> ConversationDetail:
    """One conversation with its messages, oldest first.

    At most the most recent ``MAX_MESSAGES_PER_READ`` messages are returned;
    ``truncated`` is true when older ones were left out.
    """
    found = await repo.get_conversation_with_messages(session, conversation_id)
    if found is None:
        raise NotFound()
    _log.info("conversation read", messages=len(found.messages), truncated=found.truncated)
    conversation = found.conversation
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[_message_out(m) for m in found.messages],
        truncated=found.truncated,
    )
