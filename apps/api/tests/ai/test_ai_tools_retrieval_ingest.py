"""Tools (allow-listed read-only SQL), Azure AI Search retrieval, and the ingestion job —
all against fakes; ``pyodbc.connect`` and the network are never touched."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

import app.ai.tools as registry
import app.ai.tools.queries as queries
from app.ai import ingest
from app.ai.tools.queries import InvalidQueryParams, QueryNotAllowed, register_query
from app.ai.tools.query_external_db import (
    TextToSqlDisabled,
    describe_queries,
    query_external_db,
    run_allowed_query,
    run_readonly_sql,
)
from app.ai.tools.retrieve import (
    CONTENT_FIELD,
    ID_FIELD,
    SOURCE_FIELD,
    TITLE_FIELD,
    VECTOR_FIELD,
    AzureSearchRetriever,
    NullRetriever,
    chunk_title,
    clean_title,
    fallback_title,
)
from tests.ai.fakes import FakeEmbeddings, FakeSearchClient, FakeSession, fake_session_factory


@pytest.fixture(autouse=True)
def _reset_registries():
    queries._reset_for_tests()
    yield
    queries._reset_for_tests()


# ── allow-listed queries ─────────────────────────────────────────────────────


def test_register_query_refuses_non_select_and_unknown_types() -> None:
    with pytest.raises(ValueError, match="SELECT/WITH"):
        register_query("bad", sql="DELETE FROM t")
    with pytest.raises(ValueError, match="unsupported param type"):
        register_query("bad2", sql="SELECT 1", params={"x": "date"})


def test_run_allowed_query_binds_validated_params() -> None:
    register_query(
        "orders",
        sql="SELECT TOP (:limit) id FROM dbo.orders WHERE customer_id = :customer_id",
        params={"customer_id": "int", "limit": "int"},
        max_rows=2,
    )
    session = FakeSession(rows=[{"id": 1}, {"id": 2}, {"id": 3}])
    rows = asyncio.run(
        run_allowed_query(
            "orders", {"customer_id": 7, "limit": 5}, session_factory=fake_session_factory(session)
        )
    )
    assert rows == [{"id": 1}, {"id": 2}]  # capped at max_rows
    statement, params = session.executed[0]
    assert "customer_id = :customer_id" in statement
    assert params == {"customer_id": 7, "limit": 5}


def test_param_validation_is_strict() -> None:
    register_query("q", sql="SELECT :a AS a", params={"a": "int"})
    session = FakeSession()
    factory = fake_session_factory(session)
    with pytest.raises(InvalidQueryParams):
        asyncio.run(run_allowed_query("q", {"a": "1"}, session_factory=factory))  # wrong type
    with pytest.raises(InvalidQueryParams):
        asyncio.run(run_allowed_query("q", {"a": 1, "b": 2}, session_factory=factory))  # unknown
    with pytest.raises(InvalidQueryParams):
        asyncio.run(run_allowed_query("q", {"a": True}, session_factory=factory))  # bool ≠ int
    with pytest.raises(QueryNotAllowed):
        asyncio.run(run_allowed_query("missing", {}, session_factory=factory))
    assert session.executed == []


def test_text_to_sql_is_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AI_ALLOW_TEXT_TO_SQL", raising=False)
    session = FakeSession()
    with pytest.raises(TextToSqlDisabled):
        asyncio.run(run_readonly_sql("SELECT 1", session_factory=fake_session_factory(session)))
    monkeypatch.setenv("AI_ALLOW_TEXT_TO_SQL", "true")
    with pytest.raises(PermissionError):
        asyncio.run(run_readonly_sql("DROP TABLE t", session_factory=fake_session_factory(session)))
    asyncio.run(run_readonly_sql("SELECT 1", session_factory=fake_session_factory(session)))
    assert session.executed[0][0].strip() == "SELECT 1"


def test_langchain_tool_returns_json_and_safe_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    register_query("ping", sql="SELECT 1 AS one", description="health")
    session = FakeSession(rows=[{"one": 1}])
    import app.ai.tools.query_external_db as tool_mod

    monkeypatch.setattr(tool_mod, "get_external_sessionmaker", fake_session_factory(session))
    assert query_external_db.name == "query_external_db"
    assert any(t.name == "query_external_db" for t in registry.get_tools())

    ok = asyncio.run(query_external_db.ainvoke({"query_name": "ping", "params": "{}"}))
    assert json.loads(ok) == [{"one": 1}]
    bad = json.loads(asyncio.run(query_external_db.ainvoke({"query_name": "nope", "params": "{}"})))
    assert "not in the allow-list" in bad["error"]
    assert "ping" in bad["available"]
    malformed = json.loads(
        asyncio.run(query_external_db.ainvoke({"query_name": "ping", "params": "{"}))
    )
    assert "JSON" in malformed["error"]
    assert "ping(" in describe_queries()


# ── retrieval ────────────────────────────────────────────────────────────────


def test_null_retriever_returns_nothing() -> None:
    assert asyncio.run(NullRetriever().retrieve("q")) == []


def test_azure_search_retriever_runs_hybrid_query() -> None:
    client = FakeSearchClient(
        rows=[
            {
                ID_FIELD: "a",
                CONTENT_FIELD: "text a",
                SOURCE_FIELD: "docs/s1.md",
                TITLE_FIELD: "Setup guide",
                "@search.score": 1.5,
            }
        ]
    )
    embeddings = FakeEmbeddings(dimensions=3)
    retriever = AzureSearchRetriever(client, embeddings)
    chunks = asyncio.run(retriever.retrieve("hello", top_k=3))
    assert chunks == [
        {
            "id": "a",
            "content": "text a",
            "source": "docs/s1.md",
            "score": 1.5,
            "title": "Setup guide",
        }
    ]
    assert embeddings.queries == ["hello"]
    call = client.search_calls[0]
    assert call["search_text"] == "hello" and call["top"] == 3
    assert call["select"] == [ID_FIELD, CONTENT_FIELD, SOURCE_FIELD, TITLE_FIELD]
    vq = call["vector_queries"][0]
    assert (
        vq.fields == VECTOR_FIELD and vq.k_nearest_neighbors == 3 and vq.vector == [5.0, 0.0, 0.0]
    )


# ── ingestion ────────────────────────────────────────────────────────────────


def test_chunk_text_windows_with_overlap() -> None:
    assert ingest.chunk_text("") == []
    chunks = ingest.chunk_text("abcdefghij", size=4, overlap=1)
    assert chunks == ["abcd", "defg", "ghij"]
    with pytest.raises(ValueError):
        ingest.chunk_text("x", size=4, overlap=4)


def test_build_index_matches_the_retriever_contract() -> None:
    index = ingest.build_index("docs", dimensions=8)
    names = {f.name: f for f in index.fields}
    assert names[ID_FIELD].key is True
    assert names[CONTENT_FIELD].searchable is True
    assert names[TITLE_FIELD].searchable is True  # the field the retriever selects
    assert names[VECTOR_FIELD].vector_search_dimensions == 8
    assert names[VECTOR_FIELD].vector_search_profile_name == ingest.VECTOR_PROFILE
    assert index.vector_search.profiles[0].algorithm_configuration_name == ingest.HNSW_CONFIG


def test_ingest_documents_embeds_and_uploads_in_batches() -> None:
    client = FakeSearchClient()
    embeddings = FakeEmbeddings(dimensions=2)
    docs = [ingest.IngestDocument(source="a.md", text="one two three four five six")]
    report = asyncio.run(
        ingest.ingest_documents(
            docs,
            embeddings=embeddings,
            search_client=client,
            chunk_size=10,
            overlap=2,
            batch_size=2,
        )
    )
    assert report.documents == 1 and report.chunks == report.uploaded > 1 and report.failed == 0
    assert len(client.uploaded) == -(-report.chunks // 2)  # ceil(chunks / batch_size)
    first = client.uploaded[0][0]
    assert set(first) == {
        ID_FIELD,
        CONTENT_FIELD,
        SOURCE_FIELD,
        TITLE_FIELD,
        ingest.CHUNK_INDEX_FIELD,
        VECTOR_FIELD,
    }
    assert first[ID_FIELD] == ingest.chunk_id("a.md", 0)
    assert first[TITLE_FIELD] == "a.md"  # no heading: the file name
    assert len(first[VECTOR_FIELD]) == 2


def test_load_path_reads_text_files_only(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("alpha", encoding="utf-8")
    (tmp_path / "b.txt").write_text("beta", encoding="utf-8")
    (tmp_path / "c.bin").write_bytes(b"\x00")
    docs = ingest.load_path(tmp_path)
    assert [d.text for d in docs] == ["alpha", "beta"]
    assert ingest.load_path(tmp_path / "a.md")[0].source.endswith("a.md")


# ── titles ───────────────────────────────────────────────────────────────────


def test_azure_search_retriever_tolerates_chunks_indexed_without_a_title() -> None:
    client = FakeSearchClient(
        rows=[{ID_FIELD: "a", CONTENT_FIELD: "t", SOURCE_FIELD: "docs/old.md", TITLE_FIELD: None}]
    )
    chunks = asyncio.run(AzureSearchRetriever(client, FakeEmbeddings(2)).retrieve("q"))
    assert chunks[0]["title"] == ""
    assert chunk_title(chunks[0]) == "old.md"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("# Tracing\n\nbody", "Tracing"),
        ("intro\n\n# Late heading\n", "Late heading"),
        ("# Closed #\n", "Closed"),
        ("#   Padded   \n", "Padded"),
        ("## Not level one\n\ntext", "guide.md"),
        ("#NoSpace\n", "guide.md"),
        ("# \n\ntext", "guide.md"),
        ("plain text", "guide.md"),
        ("", "guide.md"),
        ("```bash\n# a shell comment\n```\n# Real title\n", "Real title"),
        ("~~~\n# also code\n~~~\n", "guide.md"),
        ("# First\n# Second\n", "First"),
    ],
)
def test_document_title_is_the_first_h1_outside_code_else_the_file_name(
    text: str, expected: str
) -> None:
    assert ingest.document_title("docs/guide.md", text) == expected


def test_document_title_is_capped() -> None:
    title = ingest.document_title("a.md", "# " + "x" * 500)
    assert len(title) == ingest.TITLE_MAX_CHARS


def test_fallback_title_is_the_file_name() -> None:
    assert fallback_title("docs/a/b.md") == "b.md"
    assert fallback_title("b.md") == "b.md"
    assert fallback_title("") == ""


def test_every_chunk_of_a_document_carries_its_heading_as_title() -> None:
    client = FakeSearchClient()
    docs = [ingest.IngestDocument(source="docs/x.md", text="# Heading X\n" + "word " * 60)]
    asyncio.run(
        ingest.ingest_documents(
            docs, embeddings=FakeEmbeddings(2), search_client=client, chunk_size=50, overlap=5
        )
    )
    uploaded = [d for batch in client.uploaded for d in batch]
    assert len(uploaded) > 1
    assert {d[TITLE_FIELD] for d in uploaded} == {"Heading X"}


# ── title extraction: the cases real Markdown has ───────────────────────────


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # a '#' that belongs to the word is kept; only a closing sequence is dropped
        ("# Learning C#\n", "Learning C#"),
        ("# F# and C#\n", "F# and C#"),
        ("# Issue #\n", "Issue"),
        ("# Issue ##   \n", "Issue"),
        ("# #\n", "guide.md"),  # an empty heading is not a title
        ("#\n# Real\n", "Real"),  # a bare '#' line is skipped
        # indentation: up to three spaces is a heading, four is code
        ("   # Indented\n", "Indented"),
        ("    # four spaces\n", "guide.md"),
        # file encodings and line endings
        ("\ufeff# With BOM\n", "With BOM"),
        ("# CRLF title\r\nbody\r\n", "CRLF title"),
        # YAML front matter is skipped; an unclosed one is ordinary text
        ("---\ntitle: x\n# a yaml comment\n---\n# Real\n", "Real"),
        ("---\n# unclosed\n", "unclosed"),
        # fences: a fence closes only on the same character with at least as many characters
        ("~~~\n```\n# x\n~~~\n# Real\n", "Real"),
        ("````\n```\n# x\n````\n# Real\n", "Real"),
        ("```\n# x\n~~~\n# y\n```\n# Z\n", "Z"),
        ("```code``` is not a fence\n# Real\n", "Real"),
        ("```\n# never closed\n", "guide.md"),
        # other languages and symbols survive
        ("# مرحبا بالعالم\n", "مرحبا بالعالم"),
        ("# Release \U0001f680\n", "Release \U0001f680"),
    ],
)
def test_document_title_handles_real_markdown(text: str, expected: str) -> None:
    assert ingest.document_title("docs/guide.md", text) == expected


def test_document_title_removes_bidi_overrides_and_control_characters() -> None:
    assert ingest.document_title("a.md", "# a\u202eb\x07c\u2066d\n") == "ab cd"


def test_a_long_title_is_cut_and_not_left_with_trailing_whitespace() -> None:
    title = ingest.document_title("a.md", "# " + "x" * 199 + " y")
    assert len(title) <= ingest.TITLE_MAX_CHARS
    assert title == "x" * 199  # the cut falls on the space, which is then dropped


@pytest.mark.parametrize(
    "text",
    [
        "# a" + " " * 1_000_000 + "b\n",
        "# " + "#" * 1_000_000 + "\n",
        "x" * 1_000_000,
        "# \t" * 100_000,
    ],
    ids=["long-spaces", "long-hashes", "one-long-line", "many-short-lines"],
)
def test_document_title_is_fast_on_hostile_documents(text: str) -> None:
    started = time.perf_counter()
    ingest.document_title("a.md", text)
    assert time.perf_counter() - started < 2.0  # linear, not quadratic


# ── title cleaning on read ───────────────────────────────────────────────────


def test_clean_title_caps_collapses_and_strips() -> None:
    assert clean_title("  a \t b\n c  ") == "a b c"
    assert len(clean_title("x" * 500)) == ingest.TITLE_MAX_CHARS
    assert clean_title("\u202e\u202c") == ""


def test_retriever_titles_are_cleaned_and_capped_on_read() -> None:
    client = FakeSearchClient(
        rows=[
            {ID_FIELD: "a", CONTENT_FIELD: "t", SOURCE_FIELD: "docs/a.md", TITLE_FIELD: "t" * 500},
            {ID_FIELD: "b", CONTENT_FIELD: "t", SOURCE_FIELD: "docs/b.md", TITLE_FIELD: "x\u202ey"},
            {ID_FIELD: "c", CONTENT_FIELD: "t", SOURCE_FIELD: "docs/c.md"},  # no title key at all
        ]
    )
    chunks = asyncio.run(AzureSearchRetriever(client, FakeEmbeddings(2)).retrieve("q", top_k=3))
    assert [chunk_title(c) for c in chunks] == ["t" * 200, "xy", "c.md"]


def test_load_path_drops_a_utf8_bom(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_bytes(b"\xef\xbb\xbf# Titled\n")
    assert ingest.load_path(tmp_path)[0].text == "# Titled\n"
