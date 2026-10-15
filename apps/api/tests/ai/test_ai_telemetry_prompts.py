"""Model-call telemetry (content-free by construction) and the prompt loader."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage

import app.ai.telemetry as telemetry
from app.ai.prompts import PromptNotFound, load_prompt, render_prompt


class _Span:
    def __init__(self) -> None:
        self.attributes: dict[str, Any] = {}

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def __enter__(self) -> _Span:
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _Tracer:
    def __init__(self) -> None:
        self.spans: list[tuple[str, _Span]] = []
        self.span_kwargs: list[dict[str, Any]] = []

    def start_as_current_span(self, name: str, **kwargs: Any) -> _Span:
        span = _Span()
        self.span_kwargs.append(kwargs)
        self.spans.append((name, span))
        return span


@pytest.fixture()
def tracer(monkeypatch: pytest.MonkeyPatch) -> _Tracer:
    t = _Tracer()
    monkeypatch.setattr(telemetry.trace, "get_tracer", lambda _name: t)
    telemetry._reset_for_tests()
    return t


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    seen: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        telemetry, "track_event", lambda name, attrs=None: seen.append((name, attrs or {}))
    )
    return seen


def test_extract_usage_and_error_kind() -> None:
    msg = AIMessage(
        content="x", usage_metadata={"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}
    )
    assert telemetry.extract_usage(msg) == (3, 4)
    assert telemetry.extract_usage(AIMessage(content="x")) == (None, None)
    assert telemetry.error_kind(TimeoutError()) == "timeout"
    assert telemetry.error_kind(PermissionError()) == "auth"
    assert telemetry.error_kind(ConnectionError()) == "network"
    assert telemetry.error_kind(RuntimeError("anything")) == "error"


def test_model_call_span_records_success_without_content(tracer: _Tracer, events) -> None:
    with telemetry.model_call_span("gpt-4o-mini") as call:
        call.set_usage(
            AIMessage(
                content="THE SECRET ANSWER",
                usage_metadata={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
            )
        )
    name, span = tracer.spans[0]
    assert name == "gen_ai.chat"
    assert span.attributes["gen_ai.system"] == "azure_openai"
    assert span.attributes["gen_ai.request.model"] == "gpt-4o-mini"
    assert span.attributes["gen_ai.usage.input_tokens"] == 1
    assert span.attributes["ai.outcome"] == "ok"
    assert "SECRET" not in repr(span.attributes)
    assert events[0][0] == "ai.model_call"
    assert events[0][1]["outcome"] == "ok" and events[0][1]["output_tokens"] == 2
    assert "SECRET" not in repr(events)


def test_model_call_span_records_failure_and_reraises(tracer: _Tracer, events) -> None:
    with pytest.raises(TimeoutError):
        with telemetry.model_call_span("gpt-4o-mini"):
            raise TimeoutError("boom")
    _, span = tracer.spans[0]
    assert span.attributes["ai.outcome"] == "error"
    assert span.attributes["ai.error_kind"] == "timeout"
    assert events[0][1]["error_kind"] == "timeout"


def test_record_retrieval_never_raises(events) -> None:
    telemetry.record_retrieval(12.3, "ok", hits=2)
    telemetry.record_retrieval(1.0, "error")


def test_prompts_are_files_with_placeholders() -> None:
    system = load_prompt("system")
    assert "{context}" in system
    rendered = render_prompt("system", context="[1] (a) hello")
    assert "[1] (a) hello" in rendered and "{context}" not in rendered
    with pytest.raises(PromptNotFound):
        load_prompt("does-not-exist")
    with pytest.raises(KeyError):
        render_prompt("system")  # missing placeholder must fail loudly


def test_model_call_span_never_records_the_exception_text(tracer: _Tracer, events) -> None:
    """An upstream error message can quote the question; the span keeps only the bounded kind."""
    with pytest.raises(RuntimeError):
        with telemetry.model_call_span("gpt-4o-mini"):
            raise RuntimeError("rejected: QUESTION-CANARY-77")
    assert tracer.span_kwargs == [{"record_exception": False, "set_status_on_exception": False}]
    _, span = tracer.spans[0]
    assert "CANARY" not in repr(span.attributes) and "CANARY" not in repr(events)


def test_record_ask_outcome_uses_only_bounded_values(monkeypatch: pytest.MonkeyPatch) -> None:
    added: list[tuple[int, dict[str, Any]]] = []

    class _Counter:
        def add(self, value: int, attributes: dict[str, Any]) -> None:
            added.append((value, attributes))

    class _Meter:
        def create_counter(self, name: str, **kwargs: Any) -> _Counter:
            assert name == "team-assistant.ai.ask.outcomes"
            return _Counter()

    monkeypatch.setattr(telemetry, "get_meter", lambda _scope: _Meter())
    telemetry._reset_for_tests()
    telemetry.record_ask_outcome("ask_stream", "cut")
    telemetry.record_ask_outcome("ask", "ok")
    # Anything outside the fixed sets (an id, a question, a message) is dropped, never a series.
    telemetry.record_ask_outcome("ask", "QUESTION-CANARY-77")
    telemetry.record_ask_outcome("/v1/conversations/42/ask", "ok")
    assert added == [
        (1, {"route_class": "ask_stream", "outcome": "cut"}),
        (1, {"route_class": "ask", "outcome": "ok"}),
    ]
    telemetry._reset_for_tests()


def test_record_ask_outcome_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(_scope: str) -> Any:
        raise RuntimeError("no meter")

    monkeypatch.setattr(telemetry, "get_meter", broken)
    telemetry._reset_for_tests()
    telemetry.record_ask_outcome("ask", "ok")  # must not raise into the request path
    telemetry._reset_for_tests()
