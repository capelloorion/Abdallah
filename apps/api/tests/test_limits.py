"""Request-size and stream limits (roadmap api:5.2).

Offline: the session and graph are the fakes from ``test_ask_api.py`` / ``test_ask_stream_api.py``.
What is asserted: a body over the limit is ``413`` before the route reads it (declared or chunked),
the stream cap refuses with ``429`` before anything is stored and every exit frees its slot, and a
client that stops reading cannot hold a stream open.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.routers.ask as ask_router
import tests.test_ask_stream_api as _stream_tests
from app.db import get_session
from app.limits import (
    DEFAULT_MAX_CONCURRENT_STREAMS,
    DEFAULT_MAX_REQUEST_BODY_BYTES,
    DEFAULT_STREAM_WRITE_STALL_SECONDS,
    StreamSlots,
    get_limits,
    stream_slots,
)
from app.main import app
from tests.test_ask_api import FakeSession, _conversation, _no_database  # noqa: F401
from tests.test_ask_stream_api import ClosingSession, StreamingModel, _post, frames, names

stream_setup = _stream_tests.stream_setup  # the fixture, re-registered for this module


@pytest.fixture(autouse=True)
def _slots_are_free() -> Iterator[None]:
    """No test may leak a slot, and each starts from an empty pool."""
    stream_slots.in_use = 0
    yield
    assert stream_slots.in_use == 0, "a stream slot was never released"
    stream_slots.in_use = 0


@pytest.fixture()
def session_client() -> Iterator[Any]:
    def install(session: FakeSession) -> TestClient:
        async def override() -> Any:
            yield session

        app.dependency_overrides[get_session] = override
        return TestClient(app, raise_server_exceptions=False)

    yield install
    app.dependency_overrides.pop(get_session, None)


# ---- the settings -----------------------------------------------------------------------------


def test_defaults() -> None:
    limits = get_limits()
    assert limits.max_request_body_bytes == DEFAULT_MAX_REQUEST_BODY_BYTES == 64 * 1024
    assert limits.max_concurrent_streams == DEFAULT_MAX_CONCURRENT_STREAMS == 20
    assert limits.stream_write_stall_seconds == DEFAULT_STREAM_WRITE_STALL_SECONDS == 30.0


def test_values_are_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", "1000")
    monkeypatch.setenv("API_MAX_CONCURRENT_STREAMS", "3")
    monkeypatch.setenv("API_STREAM_WRITE_STALL_SECONDS", "2.5")
    limits = get_limits()
    assert (limits.max_request_body_bytes, limits.max_concurrent_streams) == (1000, 3)
    assert limits.stream_write_stall_seconds == 2.5


@pytest.mark.parametrize("bad", ["", "lots", "0", "-4", "nan"])
def test_a_bad_value_uses_the_default(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    for name in (
        "API_MAX_REQUEST_BODY_BYTES",
        "API_MAX_CONCURRENT_STREAMS",
        "API_STREAM_WRITE_STALL_SECONDS",
    ):
        monkeypatch.setenv(name, bad)
    limits = get_limits()
    assert limits.max_request_body_bytes == DEFAULT_MAX_REQUEST_BODY_BYTES
    assert limits.max_concurrent_streams == DEFAULT_MAX_CONCURRENT_STREAMS
    assert limits.stream_write_stall_seconds == DEFAULT_STREAM_WRITE_STALL_SECONDS


# ---- request body size ------------------------------------------------------------------------


def test_a_declared_body_over_the_limit_is_413_and_the_route_never_runs(
    session_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", "200")
    session = FakeSession(found=_conversation())
    res = session_client(session).post(
        "/v1/conversations", json={"title": "t" * 500}, headers={"x-trace-id": "0eb01" + "c" * 27}
    )
    assert res.status_code == 413
    assert res.json() == {"error": "payload_too_large", "trace_id": "0eb01" + "c" * 27}
    assert res.headers["x-trace-id"] == "0eb01" + "c" * 27
    assert session.added == [] and session.commits == 0


def test_a_chunked_body_over_the_limit_is_413_without_a_content_length(
    session_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", "200")
    session = FakeSession(found=_conversation())

    def body() -> Iterator[bytes]:
        for _ in range(10):  # 10 x 60 bytes, sent as a chunked body: no length is declared
            yield b'{"title": "' + b"t" * 40 + b'"}'

    res = session_client(session).post(
        "/v1/conversations", content=body(), headers={"content-type": "application/json"}
    )
    assert res.status_code == 413 and res.json()["error"] == "payload_too_large"
    assert session.added == [] and session.commits == 0


def test_a_body_at_the_limit_is_accepted(
    session_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = json.dumps({"title": "ok"}).encode()
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", str(len(payload)))
    res = session_client(FakeSession(found=_conversation())).post(
        "/v1/conversations", content=payload, headers={"content-type": "application/json"}
    )
    assert res.status_code == 201


def test_an_oversized_question_is_413_before_the_ask_route_runs(
    session_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", "1000")
    conversation = _conversation()
    session = FakeSession(found=conversation)
    client = session_client(session)
    for path in ("ask", "ask/stream"):
        res = client.post(
            f"/v1/conversations/{conversation.id}/{path}", json={"question": "a" * 5000}
        )
        assert res.status_code == 413 and res.json()["error"] == "payload_too_large"
    assert session.added == [] and session.statements == []


async def _run_middleware(
    method: str, path: str, body: bytes, limit: int, monkeypatch: pytest.MonkeyPatch
) -> tuple[int | None, bool]:
    """(status the middleware answered with, whether the wrapped app ran) for one request."""
    from app.limits import RequestSizeLimitMiddleware

    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", str(limit))
    ran = False

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        nonlocal ran
        ran = True
        while (await receive()).get("more_body"):
            pass
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [(b"content-length", str(len(body)).encode())],
    }
    status: list[int] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            status.append(message["status"])

    await RequestSizeLimitMiddleware(inner)(scope, receive, send)
    return (status[0] if status else None), ran


@pytest.mark.parametrize(
    ("method", "path", "limited"),
    [
        ("POST", "/v1/conversations", True),
        ("PUT", "/v1/anything/else", True),
        ("PATCH", "/v1", True),
        ("GET", "/v1/conversations", False),  # no body is read on a GET
        ("DELETE", "/v1/conversations/x", False),
        ("POST", "/ping", False),  # not a /v1 route
        ("POST", "/v10/conversations", False),  # a different prefix, not /v1
        ("POST", "/v1foo", False),
    ],
)
def test_the_size_limit_applies_to_v1_writes_only(
    monkeypatch: pytest.MonkeyPatch, method: str, path: str, limited: bool
) -> None:
    status, ran = asyncio.run(_run_middleware(method, path, b"x" * 500, 100, monkeypatch))
    assert (status, ran) == ((413, False) if limited else (204, True))


def test_the_limit_applies_to_put_and_patch_too(
    session_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_MAX_REQUEST_BODY_BYTES", "10")
    client = session_client(FakeSession(found=_conversation()))
    for method in ("put", "patch"):
        res = getattr(client, method)("/v1/conversations", content=b"x" * 100)
        assert res.status_code == 413, method


# ---- the stream slots -------------------------------------------------------------------------


def test_slots_are_handed_out_up_to_the_cap_and_come_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_MAX_CONCURRENT_STREAMS", "2")
    slots = StreamSlots()
    first, second = slots.try_acquire(), slots.try_acquire()
    assert first and second and slots.try_acquire() is None
    first.release()
    first.release()  # idempotent: a second release must not free someone else's slot
    assert slots.in_use == 1
    third = slots.try_acquire()
    assert third and slots.try_acquire() is None
    second.release()
    third.release()
    assert slots.in_use == 0


def test_a_request_over_the_stream_cap_is_429_and_stores_nothing(
    stream_setup: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_MAX_CONCURRENT_STREAMS", "1")
    held = stream_slots.try_acquire()  # another stream is open
    assert held is not None
    outcomes: list[tuple[str, str]] = []
    monkeypatch.setattr(ask_router, "record_ask_outcome", lambda r, o: outcomes.append((r, o)))
    conversation = _conversation()
    session = ClosingSession(found=conversation)
    res = _post(stream_setup(session), conversation)
    assert res.status_code == 429 and res.headers["content-type"] == "application/json"
    assert res.json() == {"error": "rate_limited", "trace_id": res.headers["x-trace-id"]}
    assert session.added == [] and session.statements == [] and session.commits == 0
    assert outcomes == [("ask_stream", "rejected")]
    held.release()
    # With the slot back, the same request streams normally.
    again = ClosingSession(found=conversation)
    assert names(frames(_post(stream_setup(again), conversation).text))[-1] == "done"


def test_the_slot_is_freed_when_a_stream_finishes_fails_or_is_refused(
    stream_setup: Any,
) -> None:
    conversation = _conversation()
    for model in (StreamingModel(), StreamingModel(fail_at=1)):  # finished, failed mid-stream
        _post(stream_setup(ClosingSession(found=conversation), model=model), conversation)
        assert stream_slots.in_use == 0
    _post(stream_setup(ClosingSession(found=None)), conversation)  # 404 before streaming
    _post(stream_setup(ClosingSession(found=conversation)), conversation, "   ")  # 422
    assert stream_slots.in_use == 0


def test_the_slot_is_freed_when_search_fails_before_the_first_frame(stream_setup: Any) -> None:
    from tests.test_ask_api import Boom

    conversation = _conversation()
    res = _post(
        stream_setup(
            ClosingSession(found=conversation), retriever=Boom(ConnectionError("search down"))
        ),
        conversation,
    )
    assert res.status_code == 503 and stream_slots.in_use == 0


# ---- driving the whole app with a hand-made ASGI client ---------------------------------------


def _scope(conversation: Any) -> dict[str, Any]:
    path = f"/v1/conversations/{conversation.id}/ask/stream"
    payload = json.dumps({"question": "q?"}).encode()
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode()),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
        "_payload": payload,
    }


def test_a_client_that_stops_reading_is_cut_off_and_everything_is_released(
    stream_setup: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("API_STREAM_WRITE_STALL_SECONDS", "0.3")
    conversation = _conversation()
    session = ClosingSession(found=conversation)
    model = StreamingModel(chunks=["one ", "two ", "three ", "four"])
    stream_setup(session, model=model)
    scope = _scope(conversation)
    payload = scope.pop("_payload")
    sent: list[dict[str, Any]] = []

    async def drive() -> None:
        delivered_request = False

        async def receive() -> dict[str, Any]:
            nonlocal delivered_request
            if not delivered_request:
                delivered_request = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await asyncio.Event().wait()  # the client never disconnects, it just stops reading
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)
            if message["type"] == "http.response.body" and b"event: token" in message["body"]:
                await asyncio.Event().wait()  # the socket is full: this write never completes

        await asyncio.wait_for(app(scope, receive, send), timeout=10)

    started = time.monotonic()
    asyncio.run(drive())
    assert time.monotonic() - started < 5  # ended by the stall timeout, not by the 60 s deadline
    assert not any(b"event: done" in m.get("body", b"") for m in sent)
    assert [m.role for m in session.added] == [
        "user"
    ]  # no answer was stored for a reader that left
    assert model.closed
    assert stream_slots.in_use == 0


def test_the_slot_is_freed_when_the_client_disconnects_mid_stream(
    stream_setup: Any,
) -> None:
    conversation = _conversation()
    session = ClosingSession(found=conversation)
    model = StreamingModel(chunks=["one ", "two ", "three"], stall_at=1)
    stream_setup(session, model=model)
    scope = _scope(conversation)
    payload = scope.pop("_payload")

    async def drive() -> int:
        delivered_request = False
        gone = asyncio.Event()
        seen_open = 0

        async def receive() -> dict[str, Any]:
            nonlocal delivered_request
            if not delivered_request:
                delivered_request = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await gone.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            nonlocal seen_open
            if message["type"] == "http.response.body" and b"event: token" in message["body"]:
                seen_open = stream_slots.in_use  # a slot is held while the stream is open
                gone.set()

        await asyncio.wait_for(app(scope, receive, send), timeout=10)
        return seen_open

    assert asyncio.run(drive()) == 1
    assert stream_slots.in_use == 0
    assert [m.role for m in session.added] == ["user"]


def test_a_non_finite_or_non_positive_stall_setting_uses_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for bad in ("inf", "-inf", "nan", "0", "-1"):
        monkeypatch.setenv("API_STREAM_WRITE_STALL_SECONDS", bad)
        assert get_limits().stream_write_stall_seconds == DEFAULT_STREAM_WRITE_STALL_SECONDS


def test_a_stall_on_the_very_first_write_still_releases_the_model_run_and_the_slot(
    stream_setup: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The generator never started, so its own cleanup never runs: the response must release what
    ``_open_stream`` opened. (CPython would also collect it promptly; this pins the property.)"""
    monkeypatch.setenv("API_STREAM_WRITE_STALL_SECONDS", "0.3")
    closed: list[bool] = []

    async def events(*args: Any, **kwargs: Any) -> Any:
        try:
            yield "sources", {"citations": [], "count": 0}
            await asyncio.Event().wait()
        finally:
            closed.append(True)  # the graph run behind the stream was released

    monkeypatch.setattr(ask_router, "stream_events", events)
    conversation = _conversation()
    session = ClosingSession(found=conversation)
    stream_setup(session)
    scope = _scope(conversation)
    payload = scope.pop("_payload")

    async def drive() -> None:
        delivered_request = False

        async def receive() -> dict[str, Any]:
            nonlocal delivered_request
            if not delivered_request:
                delivered_request = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            await asyncio.Event().wait()  # even the response start cannot be written

        await asyncio.wait_for(app(scope, receive, send), timeout=10)
        # Checked here, before the loop shuts down and garbage-collects async generators on its own.
        assert closed == [True], "the graph run opened for the first frame was left running"

    asyncio.run(drive())
    assert [m.role for m in session.added] == ["user"]
    assert stream_slots.in_use == 0


def test_a_stalled_reader_is_counted_as_write_stalled_not_as_a_disconnect(
    stream_setup: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    outcomes: list[tuple[str, str]] = []
    monkeypatch.setattr(ask_router, "record_ask_outcome", lambda r, o: outcomes.append((r, o)))
    monkeypatch.setenv("API_STREAM_WRITE_STALL_SECONDS", "0.3")
    conversation = _conversation()
    stream_setup(ClosingSession(found=conversation), model=StreamingModel(chunks=["a ", "b ", "c"]))
    scope = _scope(conversation)
    payload = scope.pop("_payload")

    async def drive() -> None:
        delivered_request = False

        async def receive() -> dict[str, Any]:
            nonlocal delivered_request
            if not delivered_request:
                delivered_request = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.body" and b"event: token" in message["body"]:
                await asyncio.Event().wait()

        await asyncio.wait_for(app(scope, receive, send), timeout=10)

    asyncio.run(drive())
    assert outcomes == [("ask_stream", "write_stalled")]
