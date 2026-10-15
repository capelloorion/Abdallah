"""The retrieve → answer graph and its SSE streaming — with a fake model and retriever."""

from __future__ import annotations

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage

import app.ai.tools.retrieve as retrieve_mod
from app.ai.graph import (
    MAX_PREVIOUS_TURN_CHARS,
    ask,
    build_graph,
    citations_for,
    format_context,
    last_user_text,
    retrieval_query,
)
from app.ai.streaming import sse, sse_response, stream_answer
from app.ai.tools.retrieve import NullRetriever
from tests.ai.fakes import FakeRetriever, fake_chat_model

CHUNKS = [
    {
        "id": "1",
        "content": "The api listens on port 8000.",
        "source": "docs/api.md",
        "score": 0.9,
        "title": "The api service",
    },
    {
        "id": "2",
        "content": "The web app listens on 3000.",
        "source": "docs/web.md",
        "score": 0.8,
    },  # no title stored: the file name is used
    {
        "id": "3",
        "content": "Duplicate source chunk.",
        "source": "docs/api.md",
        "score": 0.7,
        "title": "A later chunk of the api doc",
    },
]

# chunk numbers are the [n] markers: CHUNKS[0] and CHUNKS[2] are from docs/api.md,
# CHUNKS[1] from docs/web.md
API_CITATION = {"title": "The api service", "path": "docs/api.md", "chunks": [1, 3]}
WEB_CITATION = {"title": "web.md", "path": "docs/web.md", "chunks": [2]}


@pytest.fixture(autouse=True)
def _reset():
    retrieve_mod._reset_for_tests()
    yield
    retrieve_mod._reset_for_tests()


def test_format_context_numbers_chunks_and_handles_empty() -> None:
    assert format_context([]) == "(no context available)"
    text = format_context(CHUNKS[:2])
    assert text.startswith("[1] (docs/api.md)")
    assert "[2] (docs/web.md)" in text


def test_last_user_text_picks_the_latest_human_turn() -> None:
    assert last_user_text([]) == ""
    assert last_user_text([HumanMessage(content="a"), HumanMessage(content="b")]) == "b"


def test_ask_runs_retrieval_then_model_and_collects_citations() -> None:
    retriever = FakeRetriever(CHUNKS)
    graph = build_graph(
        chat_model=fake_chat_model("Port 8000 [1]."),
        retriever=retriever,
        top_k=2,
        deployment_label="test",
    )
    answer = asyncio.run(ask(graph, "which port?"))
    assert answer.text == "Port 8000 [1]."
    assert retriever.calls == [("which port?", 2)]
    top_two = [{**API_CITATION, "chunks": [1]}, WEB_CITATION]  # only two chunks were retrieved
    assert answer.citations == top_two  # unique by path, retrieval order
    assert answer.input_tokens == 10 and answer.output_tokens == 5


def test_graph_without_retriever_falls_back_to_null_retriever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AZURE_SEARCH_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_SEARCH_INDEX", raising=False)
    assert isinstance(retrieve_mod.get_default_retriever(), NullRetriever)
    graph = build_graph(chat_model=fake_chat_model("I do not know."), deployment_label="test")
    answer = asyncio.run(ask(graph, "anything"))
    assert answer.text == "I do not know."
    assert answer.citations == [] and answer.context == []


def test_history_is_passed_through() -> None:
    model = fake_chat_model("second answer")
    graph = build_graph(chat_model=model, retriever=FakeRetriever(), deployment_label="test")
    answer = asyncio.run(ask(graph, "follow-up", history=[HumanMessage(content="first")]))
    assert answer.text == "second answer"


def test_graph_with_tools_compiles_a_tool_loop() -> None:
    from langchain_core.tools import tool

    @tool
    def echo(text: str) -> str:
        """Echo."""
        return text

    graph = build_graph(chat_model=fake_chat_model("x"), retriever=FakeRetriever(), tools=[echo])
    assert "tools" in graph.get_graph().nodes


def test_sse_frame_format() -> None:
    frame = sse("token", {"text": "héllo"})
    assert frame == 'event: token\ndata: {"text": "héllo"}\n\n'


def _collect(frames) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for frame in frames:
        event = frame.split("\n")[0].removeprefix("event: ")
        data = json.loads(frame.split("\n")[1].removeprefix("data: "))
        out.append((event, data))
    return out


def test_stream_answer_yields_sources_tokens_done() -> None:
    graph = build_graph(
        chat_model=fake_chat_model("alpha beta"),
        retriever=FakeRetriever(CHUNKS[:1]),
        deployment_label="test",
    )

    async def run() -> list[str]:
        return [f async for f in stream_answer(graph, "q")]

    events = _collect(asyncio.run(run()))
    kinds = [e for e, _ in events]
    assert kinds[0] == "sources"
    assert events[0][1] == {"citations": [{**API_CITATION, "chunks": [1]}], "count": 1}
    assert kinds[-1] == "done"
    tokens = "".join(d["text"] for e, d in events if e == "token")
    assert tokens == "alpha beta"
    assert events[-1][1]["citations"] == [{**API_CITATION, "chunks": [1]}]
    # Usage is provider-reported; a streaming fake aggregates chunks without it, so the
    # contract is "the keys are present, values may be None".
    assert set(events[-1][1]) == {"citations", "input_tokens", "output_tokens"}


def test_stream_answer_emits_bounded_error_frame() -> None:
    class Boom:
        async def retrieve(self, query: str, top_k: int = 5):
            raise TimeoutError("secret details must not leak")

    graph = build_graph(chat_model=fake_chat_model("x"), retriever=Boom(), deployment_label="test")

    async def run() -> list[str]:
        return [f async for f in stream_answer(graph, "q")]

    events = _collect(asyncio.run(run()))
    assert events[-1] == ("error", {"error_kind": "timeout"})
    assert "secret" not in json.dumps(events)


def test_sse_response_headers() -> None:
    async def frames():
        yield sse("done", {})

    response = sse_response(frames())
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"


# ── citations ────────────────────────────────────────────────────────────────


def test_citations_are_unique_by_path_in_retrieval_order_first_title_wins() -> None:
    assert citations_for(CHUNKS) == [API_CITATION, WEB_CITATION]
    assert citations_for([]) == []


def test_citations_skip_chunks_without_a_source() -> None:
    chunks = [
        {"id": "x", "content": "c", "source": "", "score": None, "title": "No path"},
        {"id": "y", "content": "c", "source": "docs/a.md", "score": None},
    ]
    assert citations_for(chunks) == [{"title": "a.md", "path": "docs/a.md", "chunks": [2]}]


def test_a_blank_title_falls_back_to_the_file_name() -> None:
    chunks = [{"id": "x", "content": "c", "source": "docs/guide/setup.md", "score": 1, "title": ""}]
    assert citations_for(chunks) == [
        {"title": "setup.md", "path": "docs/guide/setup.md", "chunks": [1]}
    ]


def test_a_windows_style_source_path_still_yields_a_file_name() -> None:
    chunks = [{"id": "x", "content": "c", "source": "docs\\a.md", "score": 1}]
    assert citations_for(chunks)[0]["title"] == "a.md"


def test_stream_sources_and_done_frames_carry_the_same_citations_for_several_documents() -> None:
    graph = build_graph(
        chat_model=fake_chat_model("ok"), retriever=FakeRetriever(CHUNKS), deployment_label="test"
    )

    async def run() -> list[str]:
        return [f async for f in stream_answer(graph, "q")]

    events = _collect(asyncio.run(run()))
    assert events[0] == ("sources", {"citations": [API_CITATION, WEB_CITATION], "count": 3})
    assert events[-1][1]["citations"] == [API_CITATION, WEB_CITATION]


def test_no_retrieval_means_empty_citations_in_both_frames() -> None:
    graph = build_graph(
        chat_model=fake_chat_model("I do not know."),
        retriever=FakeRetriever([]),
        deployment_label="test",
    )

    async def run() -> list[str]:
        return [f async for f in stream_answer(graph, "q")]

    events = _collect(asyncio.run(run()))
    assert events[0] == ("sources", {"citations": [], "count": 0})
    assert events[-1][1]["citations"] == []


# ---- follow-up-aware retrieval (roadmap api:2.3, decision Q3) ---------------------------------


def test_retrieval_query_is_the_question_alone_without_an_earlier_user_turn() -> None:
    assert retrieval_query([]) == ""
    assert retrieval_query([HumanMessage(content="which port?")]) == "which port?"
    # An assistant turn alone is not a user turn.
    assert retrieval_query([AIMessage(content="hello"), HumanMessage(content="which port?")]) == (
        "which port?"
    )


def test_retrieval_query_adds_the_previous_user_turn_never_the_assistants_answer() -> None:
    messages = [
        HumanMessage(content="How does tracing work?"),
        AIMessage(content="ASSISTANT-ANSWER mentions many things"),
        HumanMessage(content="And on the api side?"),
    ]
    assert retrieval_query(messages) == "How does tracing work?\nAnd on the api side?"


def test_retrieval_query_uses_only_the_turn_right_before_the_question() -> None:
    messages = [
        HumanMessage(content="oldest"),
        HumanMessage(content="previous"),
        HumanMessage(content="now"),
    ]
    assert retrieval_query(messages) == "previous\nnow"


def test_retrieval_query_cuts_a_long_previous_turn_but_not_the_question() -> None:
    long_turn = "x" * (MAX_PREVIOUS_TURN_CHARS + 500)
    query = retrieval_query([HumanMessage(content=long_turn), HumanMessage(content="and?")])
    assert query == "x" * MAX_PREVIOUS_TURN_CHARS + "\nand?"


def test_retrieval_query_with_only_a_blank_earlier_turn_is_the_question_alone() -> None:
    assert retrieval_query([HumanMessage(content="  \n"), HumanMessage(content="q")]) == "q"


def test_retrieval_query_looks_past_a_blank_turn_to_an_older_one() -> None:
    messages = [HumanMessage(content="topic"), HumanMessage(content=" "), HumanMessage(content="q")]
    assert retrieval_query(messages) == "topic\nq"


def test_a_question_asked_again_after_a_failed_answer_is_not_doubled() -> None:
    # The failed question stays stored with no answer, so a retry sees it as the previous turn.
    messages = [
        HumanMessage(content="How does tracing work?"),
        AIMessage(content="It adopts ids."),
        HumanMessage(content="And on the api side?"),  # asked, answer failed
        HumanMessage(content="And on the api side? "),  # asked again
    ]
    assert retrieval_query(messages) == "How does tracing work?\nAnd on the api side? "


def test_retrieval_query_reads_the_text_parts_of_block_content() -> None:
    blocks = [{"type": "text", "text": "How does "}, {"type": "text", "text": "tracing work?"}]
    query = retrieval_query([HumanMessage(content=blocks), HumanMessage(content="and the api?")])
    assert query == "How does tracing work?\nand the api?"


def test_a_follow_up_is_retrieved_with_the_previous_user_turn() -> None:
    retriever = FakeRetriever(CHUNKS)
    graph = build_graph(
        chat_model=fake_chat_model("ok"), retriever=retriever, top_k=2, deployment_label="test"
    )
    history = [HumanMessage(content="How does tracing work?"), AIMessage(content="It adopts ids.")]
    asyncio.run(ask(graph, "And on the api side?", history=history))
    assert retriever.calls == [("How does tracing work?\nAnd on the api side?", 2)]


def test_the_streaming_path_retrieves_the_same_query() -> None:
    retriever = FakeRetriever(CHUNKS)
    graph = build_graph(
        chat_model=fake_chat_model("ok"), retriever=retriever, top_k=2, deployment_label="test"
    )
    history = [HumanMessage(content="How does tracing work?")]

    async def run() -> None:
        [f async for f in stream_answer(graph, "And the api?", history=history)]

    asyncio.run(run())
    assert retriever.calls == [("How does tracing work?\nAnd the api?", 2)]


# ---- chunk numbers on citations (roadmap api:5.4) ----------------------------------------------


def test_each_citation_lists_the_numbers_of_its_chunks_in_the_context_block() -> None:
    citations = citations_for(CHUNKS)
    assert [c["chunks"] for c in citations] == [[1, 3], [2]]
    context = format_context(CHUNKS)
    # the numbers are the ones the model sees, and cites as [n]
    for citation in citations:
        for number in citation["chunks"]:
            assert f"[{number}] ({citation['path']})" in context


def test_a_chunk_with_no_source_still_takes_its_number_but_belongs_to_no_citation() -> None:
    chunks = [
        {"id": "x", "content": "c", "source": "", "score": None},
        {"id": "y", "content": "c", "source": "docs/a.md", "score": None},
        {"id": "z", "content": "c", "source": "docs/a.md", "score": None},
    ]
    assert citations_for(chunks) == [{"title": "a.md", "path": "docs/a.md", "chunks": [2, 3]}]
    assert "[1] (unknown)" in format_context(chunks)


def test_the_stream_frames_carry_the_chunk_numbers() -> None:
    graph = build_graph(
        chat_model=fake_chat_model("ok [1] [3]"),
        retriever=FakeRetriever(CHUNKS),
        deployment_label="test",
    )

    async def run() -> list[str]:
        return [f async for f in stream_answer(graph, "q")]

    events = _collect(asyncio.run(run()))
    assert events[0][1]["citations"][0]["chunks"] == [1, 3]
    assert events[-1][1]["citations"][0]["chunks"] == [1, 3]
