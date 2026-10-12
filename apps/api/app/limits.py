"""Request-size and stream limits (roadmap api:5.2; threat model D2/D4/A7).

The api is reached only by the web BFF, so it cannot tell users apart: **per-client rate limiting
belongs in the BFF**. What the api can bound is what one request or one stream costs *it*:

* ``RequestSizeLimitMiddleware`` — a ``POST``/``PUT``/``PATCH`` body to a ``/v1`` route over
  ``API_MAX_REQUEST_BODY_BYTES`` is ``413 payload_too_large`` before the route reads it, whether the
  size is declared (``Content-Length``) or counted while a chunked body arrives.
* ``StreamSlots`` — at most ``API_MAX_CONCURRENT_STREAMS`` ``/ask/stream`` responses per process
  (with several replicas the cap multiplies). Each holds a socket, a graph run, a model stream and
  a DB session; over the cap is ``429 rate_limited`` before anything is stored.
* ``API_STREAM_WRITE_STALL_SECONDS`` — how long one write to a stream's client may block.

Values are read when needed (never cached at import), like ``app.ai.config``. Nothing here logs a
body, a question or a client address — counts and outcomes only (rules 50, 60, 70).
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import error_response
from app.logging_config import get_logger

_log = get_logger("app.limits")

DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024
DEFAULT_MAX_CONCURRENT_STREAMS = 20
DEFAULT_STREAM_WRITE_STALL_SECONDS = 30.0

_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})
_LIMITED_PREFIX = "/v1"


@dataclass(frozen=True)
class Limits:
    """A snapshot of the limit settings."""

    max_request_body_bytes: int
    max_concurrent_streams: int
    stream_write_stall_seconds: float


def _positive_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_float(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


def get_limits() -> Limits:
    """The current limits; an invalid or non-positive value uses the default."""
    return Limits(
        max_request_body_bytes=_positive_int(
            "API_MAX_REQUEST_BODY_BYTES", DEFAULT_MAX_REQUEST_BODY_BYTES
        ),
        max_concurrent_streams=_positive_int(
            "API_MAX_CONCURRENT_STREAMS", DEFAULT_MAX_CONCURRENT_STREAMS
        ),
        stream_write_stall_seconds=_positive_float(
            "API_STREAM_WRITE_STALL_SECONDS", DEFAULT_STREAM_WRITE_STALL_SECONDS
        ),
    )


def _is_limited_path(path: str) -> bool:
    """``/v1`` and everything under it — not ``/v10`` or ``/v1foo``."""
    return path == _LIMITED_PREFIX or path.startswith(_LIMITED_PREFIX + "/")


class _BodyTooLarge(BaseException):
    """Raised from the wrapped ``receive`` once a chunked body passes the limit.

    A ``BaseException`` on purpose: the catch-all in ``UnhandledErrorMiddleware`` (just inside this
    middleware) turns every ``Exception`` into a ``500``, and this must become a ``413``.
    """


class RequestSizeLimitMiddleware:
    """Reject an oversized request body on ``/v1`` writes with ``413 payload_too_large``.

    Pure ASGI, placed inside ``TraceMiddleware`` so the error carries the request's trace id.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") not in _BODY_METHODS
            or not _is_limited_path(str(scope.get("path", "")))
        ):
            await self.app(scope, receive, send)
            return

        limit = get_limits().max_request_body_bytes
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None:
            try:
                too_large = int(declared) > limit
            except ValueError:
                too_large = False  # a malformed header is the server's to reject, not ours
            if too_large:
                _log.warning("request body too large", outcome="rejected", reason="declared")
                await error_response("payload_too_large", 413)(scope, receive, send)
                return

        seen = 0
        started = False

        async def counting_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _BodyTooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _BodyTooLarge:
            _log.warning("request body too large", outcome="rejected", reason="counted")
            if started:
                raise  # the response is already on the wire; nothing honest can still be sent
            await error_response("payload_too_large", 413)(scope, receive, send)


class StreamSlot:
    """One reserved stream. ``release()`` is idempotent, so every exit path can call it."""

    def __init__(self, slots: StreamSlots) -> None:
        self._slots: StreamSlots | None = slots

    def release(self) -> None:
        slots, self._slots = self._slots, None
        if slots is not None:
            slots._release()  # noqa: SLF001 — the slot and its pool are one unit


class StreamSlots:
    """A per-process counter of open streams. Single-threaded (one event loop), so no lock."""

    def __init__(self) -> None:
        self.in_use = 0

    def try_acquire(self) -> StreamSlot | None:
        """A slot, or ``None`` when ``API_MAX_CONCURRENT_STREAMS`` streams are already open."""
        if self.in_use >= get_limits().max_concurrent_streams:
            _log.warning("stream cap reached", outcome="rejected", open_streams=self.in_use)
            return None
        self.in_use += 1
        return StreamSlot(self)

    def _release(self) -> None:
        self.in_use = max(0, self.in_use - 1)


# The one pool for ``/ask/stream`` in this process.
stream_slots = StreamSlots()
