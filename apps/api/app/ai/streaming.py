"""Streamed answers as Server-Sent Events (ADR-0009).

Wire format (one ``event:`` + one JSON ``data:`` line per event, blank-line terminated):

    event: sources   data: {"citations": [{"title": "A", "path": "docs/a.md"}], "count": 3}
                                                                    — after retrieval
    event: token     data: {"text": "partial "}                     — per model token chunk
    event: done      data: {"citations": [...], "input_tokens": 12, "output_tokens": 40}
    event: error     data: {"error_kind": "timeout"}                — then the stream ends

``citations`` are unique by path, in retrieval order; ``count`` is the number of retrieved chunks.

Use from a ``/v1`` route::

    @router.post("/chat/stream")
    async def chat_stream(body: ChatIn) -> StreamingResponse:
        graph = build_graph()
        return sse_response(stream_answer(graph, body.question))

The BFF forwards it with the streaming pass-through helper (``apps/web/src/lib/stream.ts``),
not ``fetchUpstream`` (which forces a JSON accept header and a 10 s timeout).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessageChunk, AnyMessage, HumanMessage

from app.ai.graph import Citation, GraphState, _message_text, citations_for
from app.ai.telemetry import error_kind, extract_usage

SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def sse(event: str, data: dict[str, Any]) -> str:
    """Format one SSE frame."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def stream_events(
    graph: Any,
    question: str,
    *,
    history: list[AnyMessage] | None = None,
    config: dict[str, Any] | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Run the graph and yield ``(event, data)`` pairs: ``sources`` → ``token``* → ``done`` (or
    ``error``). The typed form of ``stream_answer``: a route that must act between events (store the
    answer before ``done``) consumes this and formats the frames itself with ``sse``.
    """
    inputs: GraphState = {
        "messages": [*(history or []), HumanMessage(content=question)],
        "context": [],
    }
    citations: list[Citation] = []
    input_tokens: int | None = None
    output_tokens: int | None = None
    stream = graph.astream(inputs, config, stream_mode=["updates", "messages"])
    try:
        async for mode, payload in stream:
            if mode == "updates":
                for node, update in (payload or {}).items():
                    if node == "retrieve":
                        context = (update or {}).get("context", []) or []
                        citations = citations_for(context)
                        yield "sources", {"citations": citations, "count": len(context)}
                    elif node == "answer":
                        for message in (update or {}).get("messages", []) or []:
                            i, o = extract_usage(message)
                            input_tokens = i if i is not None else input_tokens
                            output_tokens = o if o is not None else output_tokens
            elif mode == "messages":
                chunk, metadata = payload
                if (
                    isinstance(chunk, AIMessageChunk)
                    and (metadata or {}).get("langgraph_node") == "answer"
                    and not getattr(chunk, "tool_call_chunks", None)
                ):
                    text = _message_text(chunk)
                    if text:
                        yield "token", {"text": text}
    except Exception as exc:  # noqa: BLE001 - the frame carries a bounded kind, never the message
        yield "error", {"error_kind": error_kind(exc)}
        return
    finally:
        # Close the graph run now (not at garbage collection) so a consumer that stops early,
        # or a failure, also stops the model and search work behind it.
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            await aclose()
    yield (
        "done",
        {
            "citations": citations,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    )


async def stream_answer(
    graph: Any,
    question: str,
    *,
    history: list[AnyMessage] | None = None,
    config: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Run the graph and yield SSE frames: ``sources`` → ``token``* → ``done`` (or ``error``)."""
    async for event, data in stream_events(graph, question, history=history, config=config):
        yield sse(event, data)


def sse_response(frames: AsyncIterator[str]) -> StreamingResponse:
    """A FastAPI response that streams SSE frames without proxy buffering."""
    return StreamingResponse(
        frames,
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )
