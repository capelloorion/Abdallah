"""``/v1/conversations`` (roadmap api:1.2): contract, ordering, limits, errors, no content in logs.

No database: ``get_session`` is overridden by a fake that records what the repository runs.
The recorded statements are compiled for SQL Server so ordering and ``TOP`` limits are asserted,
not assumed.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pyodbc
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import mssql

import app.routers.conversations as conversations_router
from app.db import get_session
from app.main import app
from app.models import Conversation, Message
from app.repositories.conversations import MAX_MESSAGES_PER_READ, Cursor, InvalidCursor

TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
INBOUND = "0eb01" + "c" * 27
EMOJI = chr(0x1F600)  # one character, two UTF-16 code units
T0 = datetime(2026, 10, 6, 9, 0, 0)  # naive UTC, as stored


class _Scalars:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return list(self._rows)


class FakeSession:
    """Just enough of ``AsyncSession`` for the repository: add/commit/get/scalars."""

    def __init__(
        self, *, found: Conversation | None = None, results: list[list[Any]] | None = None
    ):
        self.found = found
        self.results = list(results or [])
        self.added: list[Any] = []
        self.commits = 0
        self.get_calls: list[tuple[Any, Any]] = []
        self.statements: list[Any] = []

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def commit(self) -> None:
        self.commits += 1

    async def get(self, model: Any, key: Any) -> Any:
        self.get_calls.append((model, key))
        return self.found

    async def scalars(self, statement: Any) -> _Scalars:
        self.statements.append(statement)
        return _Scalars(self.results.pop(0))

    def sql(self, index: int = 0) -> str:
        compiled = self.statements[index].compile(
            dialect=mssql.dialect(), compile_kwargs={"literal_binds": True}
        )
        return " ".join(str(compiled).split())


@pytest.fixture(autouse=True)
def _no_database(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    attempts: list[tuple[Any, ...]] = []

    def fake_connect(*args: Any, **kwargs: Any) -> None:
        attempts.append((args, kwargs))
        raise AssertionError("route tests must never open a database connection")

    monkeypatch.setattr(pyodbc, "connect", fake_connect)
    yield
    assert attempts == [], "a route test tried to open a database connection"


@pytest.fixture()
def use_session() -> Iterator[Any]:
    def install(session: FakeSession) -> TestClient:
        async def override() -> Any:
            yield session

        app.dependency_overrides[get_session] = override
        return TestClient(app)

    yield install
    app.dependency_overrides.pop(get_session, None)


def _conversation(title: str = "Trace ids", *, minutes: int = 0) -> Conversation:
    return Conversation(
        id=uuid.uuid4(),
        title=title,
        created_at=T0,
        updated_at=T0 + timedelta(minutes=minutes),
    )


def _message(
    conversation_id: uuid.UUID,
    role: str,
    content: str,
    *,
    seconds: int = 0,
    citations: str | None = None,
) -> Message:
    return Message(
        id=uuid.uuid4(),
        conversation_id=conversation_id,
        role=role,
        content=content,
        citations=citations,
        token_count=None,
        created_at=T0 + timedelta(seconds=seconds),
    )


def _is_error(body: dict[str, Any], code: str) -> bool:
    return body["error"] == code and bool(TRACE_RE.match(body["trace_id"]))


# --- POST /v1/conversations --------------------------------------------------------------


def test_create_without_a_body_uses_the_default_title(use_session: Any) -> None:
    session = FakeSession()
    res = use_session(session).post("/v1/conversations")
    assert res.status_code == 201
    body = res.json()
    assert set(body) == {"id", "title", "created_at", "updated_at"}
    assert body["title"] == "New conversation"
    uuid.UUID(body["id"])
    for key in ("created_at", "updated_at"):
        assert datetime.fromisoformat(body[key]).utcoffset() == timedelta(0)  # always UTC
    assert len(session.added) == 1
    assert session.commits == 1


def test_create_with_a_title_trims_it(use_session: Any) -> None:
    session = FakeSession()
    res = use_session(session).post("/v1/conversations", json={"title": "  Trace ids  "})
    assert res.status_code == 201
    assert res.json()["title"] == "Trace ids"
    assert session.added[0].title == "Trace ids"


@pytest.mark.parametrize("payload", [{}, {"title": None}, {"title": "   "}, {"title": ""}])
def test_create_with_a_missing_or_blank_title_uses_the_default(
    use_session: Any, payload: dict[str, Any]
) -> None:
    res = use_session(FakeSession()).post("/v1/conversations", json=payload)
    assert res.status_code == 201
    assert res.json()["title"] == "New conversation"


def test_create_accepts_a_title_of_exactly_200_characters(use_session: Any) -> None:
    res = use_session(FakeSession()).post("/v1/conversations", json={"title": "x" * 200})
    assert res.status_code == 201


@pytest.mark.parametrize("payload", [{"title": "x" * 201}, {"title": 123}, {"title": ["a"]}])
def test_create_rejects_a_bad_title_without_storing_anything(
    use_session: Any, payload: dict[str, Any]
) -> None:
    session = FakeSession()
    res = use_session(session).post("/v1/conversations", json=payload)
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")
    assert session.added == []
    assert session.commits == 0


# --- GET /v1/conversations ---------------------------------------------------------------


def test_list_returns_the_rows_in_query_order_as_summaries_with_a_count(use_session: Any) -> None:
    # Ordering itself is proven by the compiled SQL in the next test; this one is the shape.
    newer, older = _conversation("Newer", minutes=5), _conversation("Older")
    session = FakeSession(results=[[newer, older]])
    res = use_session(session).get("/v1/conversations")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 2
    assert [i["title"] for i in body["items"]] == ["Newer", "Older"]
    assert set(body["items"][0]) == {"id", "title", "updated_at"}  # no created_at in the list


def test_list_orders_by_updated_at_and_defaults_to_50(use_session: Any) -> None:
    session = FakeSession(results=[[]])
    use_session(session).get("/v1/conversations")
    sql = session.sql()
    assert "TOP 51" in sql  # one extra row tells whether another page exists
    assert "ORDER BY conversations.updated_at DESC, conversations.created_at DESC" in sql


@pytest.mark.parametrize("limit", [1, 100])
def test_list_honours_the_limit_bounds(use_session: Any, limit: int) -> None:
    session = FakeSession(results=[[]])
    res = use_session(session).get("/v1/conversations", params={"limit": limit})
    assert res.status_code == 200
    assert f"TOP {limit + 1}" in session.sql()


@pytest.mark.parametrize("limit", ["0", "101", "-1", "abc"])
def test_list_rejects_a_limit_outside_1_to_100(use_session: Any, limit: str) -> None:
    session = FakeSession(results=[[]])
    res = use_session(session).get("/v1/conversations", params={"limit": limit})
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")
    assert session.statements == []


def test_list_with_nothing_stored_is_empty_not_an_error(use_session: Any) -> None:
    res = use_session(FakeSession(results=[[]])).get("/v1/conversations")
    assert res.status_code == 200
    assert res.json() == {"items": [], "count": 0, "next_cursor": None}


# --- GET /v1/conversations paging (roadmap api:5.6) ---------------------------------------


def _cursor_for(conversation: Conversation) -> str:
    return Cursor(conversation.updated_at, conversation.created_at, conversation.id).encode()


def test_a_full_page_with_more_behind_it_returns_a_cursor_for_its_last_row(
    use_session: Any,
) -> None:
    rows = [_conversation(f"c{i}", minutes=10 - i) for i in range(4)]  # limit 3 reads 4
    res = use_session(FakeSession(results=[rows])).get("/v1/conversations", params={"limit": 3})
    body = res.json()
    assert [i["title"] for i in body["items"]] == ["c0", "c1", "c2"]  # the extra row is not shown
    assert body["count"] == 3
    assert body["next_cursor"] == _cursor_for(rows[2])


def test_the_last_page_has_no_cursor_even_when_it_is_exactly_full(use_session: Any) -> None:
    rows = [_conversation(f"c{i}") for i in range(3)]
    res = use_session(FakeSession(results=[rows])).get("/v1/conversations", params={"limit": 3})
    assert res.json()["next_cursor"] is None
    assert res.json()["count"] == 3


def test_the_first_page_has_no_keyset_condition(use_session: Any) -> None:
    session = FakeSession(results=[[]])
    use_session(session).get("/v1/conversations")
    assert "WHERE" not in session.sql()


def test_a_cursor_starts_the_page_strictly_after_its_row(use_session: Any) -> None:
    last = _conversation("last", minutes=5)
    session = FakeSession(results=[[]])
    res = use_session(session).get("/v1/conversations", params={"cursor": _cursor_for(last)})
    assert res.status_code == 200
    sql = session.sql()
    u, c, i = "2026-10-06 09:05:00", "2026-10-06 09:00:00", str(last.id)
    # updated_at older, or tied and created_at older, or tied on both and a later id: the same
    # order as ORDER BY, so a row is never repeated or skipped.
    assert f"conversations.updated_at < '{u}'" in sql
    assert f"conversations.updated_at = '{u}' AND (conversations.created_at < '{c}'" in sql
    assert f"conversations.created_at = '{c}' AND conversations.id > '{i}'" in sql
    assert sql.index("WHERE") < sql.index("ORDER BY")


def test_walking_the_cursors_visits_every_row_once_in_list_order() -> None:
    # (Id order is dialect-specific; SQL Server compares the same column in WHERE and ORDER BY.)
    # The keyset condition is run for real on an in-memory SQLite table (SQL Server is not
    # available here): many rows tie on updated_at and on created_at, and for every page size
    # the walk must equal the plain ordered list, with no row repeated or skipped.
    import asyncio
    import random

    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    from app.repositories.conversations import list_conversations

    random.seed(7)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "create table conversations "
            "(id char(32) primary key, title text, created_at datetime, updated_at datetime)"
        )
    rows = [
        Conversation(
            id=uuid.uuid4(),
            title=f"c{i}",
            created_at=T0 + timedelta(minutes=random.randint(0, 3)),
            updated_at=T0 + timedelta(minutes=random.randint(0, 3)),
        )
        for i in range(40)
    ]
    with Session(engine) as db:
        db.add_all(rows)
        db.commit()

        class Async:
            async def scalars(self, statement: Any) -> Any:
                return db.scalars(statement)

        async def walk(limit: int) -> list[uuid.UUID]:
            seen: list[uuid.UUID] = []
            after = None
            for _ in range(100):  # a wrong condition must fail, not loop for ever
                page = await list_conversations(Async(), limit, after)  # type: ignore[arg-type]
                seen += [c.id for c in page.conversations]
                if page.next_cursor is None:
                    return seen
                after = Cursor.decode(page.next_cursor)
            raise AssertionError("the walk never reached the last page")

        expected = [
            c.id
            for c in db.scalars(
                select(Conversation).order_by(
                    Conversation.updated_at.desc(), Conversation.created_at.desc(), Conversation.id
                )
            )
        ]
        for limit in (1, 3, 7, 39, 40, 41):
            assert asyncio.run(walk(limit)) == expected, limit


def test_cursor_round_trips_and_is_url_safe() -> None:
    conversation = _conversation("x", minutes=3)
    text = _cursor_for(conversation)
    assert re.fullmatch(r"[A-Za-z0-9_-]+", text)
    cursor = Cursor.decode(text)
    assert (cursor.updated_at, cursor.created_at, cursor.id) == (
        conversation.updated_at,
        conversation.created_at,
        conversation.id,
    )


@pytest.mark.parametrize(
    "text",
    [
        "",
        "not a cursor",
        "!!!!",
        "a" * 121,
        "abcd",  # valid base64, not a cursor
        "e30",  # "{}"
    ],
)
def test_cursor_decode_refuses_text_it_did_not_issue(text: str) -> None:
    with pytest.raises(InvalidCursor):
        Cursor.decode(text)


def test_cursor_decode_refuses_altered_and_non_canonical_spellings() -> None:
    text = _cursor_for(_conversation("x"))
    other = "A" if text[10] != "A" else "B"
    with pytest.raises(InvalidCursor):
        Cursor.decode(text[:10] + other + text[11:])  # one character changed
    with pytest.raises(InvalidCursor):
        Cursor.decode(text[:-4])  # cut short
    with pytest.raises(InvalidCursor):
        Cursor.decode(text + "=")  # padding is not part of the issued text
    import base64

    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode()
    updated, created, ident = raw.split("|")
    for variant in (
        f"{updated}|{created}|{ident.upper()}",  # same id, other spelling
        f"{updated}+00:00|{created}|{ident}",  # a time zone
        f"{updated}|{created}|{ident}|x",  # extra field
        f"{updated}|{created}|{ident.replace('-', '')}",  # unhyphenated id
    ):
        spelled = base64.urlsafe_b64encode(variant.encode()).decode().rstrip("=")
        with pytest.raises(InvalidCursor):
            Cursor.decode(spelled)


@pytest.mark.parametrize("cursor", ["", "garbage!", "a" * 121, "e30", "%00"])
def test_list_rejects_a_bad_cursor_with_422_before_touching_the_database(
    use_session: Any, cursor: str
) -> None:
    session = FakeSession(results=[[]])
    res = use_session(session).get("/v1/conversations", params={"cursor": cursor})
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")
    assert set(res.json()) == {"error", "trace_id"}  # the value is never echoed back
    assert session.statements == []


def test_a_cursor_is_not_logged_whether_valid_or_refused(
    use_session: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    text = _cursor_for(_conversation("x"))
    client = use_session(FakeSession(results=[[]]))
    assert client.get("/v1/conversations", params={"cursor": text}).status_code == 200
    bad = "refused" + "Q" * 20
    assert client.get("/v1/conversations", params={"cursor": bad}).status_code == 422
    out = capsys.readouterr().out
    assert "conversations listed" in out  # logs do reach stdout, so the absence below means it
    assert text not in out
    assert bad not in out


# --- GET /v1/conversations/{id} ----------------------------------------------------------


def test_get_returns_the_conversation_with_messages_oldest_first(use_session: Any) -> None:
    conversation = _conversation()
    cid = conversation.id
    citations = json.dumps([{"title": "Tracing", "path": "docs/tracing.md"}])
    answer = _message(cid, "assistant", "It is minted by the BFF.", seconds=2, citations=citations)
    question = _message(cid, "user", "How does trace_id work?", seconds=1)
    session = FakeSession(found=conversation, results=[[answer, question]])  # newest first
    res = use_session(session).get(f"/v1/conversations/{cid}")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == str(cid)
    assert body["truncated"] is False
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
    assert set(body["messages"][0]) == {"id", "role", "content", "citations", "created_at"}
    assert body["messages"][0]["citations"] is None
    # a row stored before `chunks` existed reads back with `chunks: null` (unknown)
    assert body["messages"][1]["citations"] == [
        {"title": "Tracing", "path": "docs/tracing.md", "chunks": None}
    ]
    assert session.get_calls == [(Conversation, cid)]


def test_get_reads_newest_first_with_a_cap_and_a_stable_tie_break(use_session: Any) -> None:
    conversation = _conversation()
    session = FakeSession(found=conversation, results=[[]])
    use_session(session).get(f"/v1/conversations/{conversation.id}")
    sql = session.sql()
    assert f"TOP {MAX_MESSAGES_PER_READ + 1}" in sql  # one extra row detects truncation
    assert "ORDER BY messages.created_at DESC, messages.role ASC, messages.id" in sql
    assert "messages.conversation_id" in sql


def test_get_puts_the_user_message_first_when_a_turn_shares_a_timestamp(use_session: Any) -> None:
    conversation = _conversation()
    cid = conversation.id
    # The read is newest-first with role ASC, so within one timestamp 'assistant' comes first.
    answer = _message(cid, "assistant", "a", seconds=1)
    question = _message(cid, "user", "q", seconds=1)
    session = FakeSession(found=conversation, results=[[answer, question]])
    body = use_session(session).get(f"/v1/conversations/{cid}").json()
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]


def test_get_marks_a_cut_history_and_keeps_the_newest_messages(use_session: Any) -> None:
    conversation = _conversation()
    cid = conversation.id
    rows = [
        _message(cid, "user", f"m{n}", seconds=1000 - n) for n in range(MAX_MESSAGES_PER_READ + 1)
    ]
    session = FakeSession(found=conversation, results=[rows])  # newest first, one extra
    body = use_session(session).get(f"/v1/conversations/{cid}").json()
    assert body["truncated"] is True
    assert len(body["messages"]) == MAX_MESSAGES_PER_READ
    assert body["messages"][-1]["content"] == "m0"  # the newest turn is kept, last
    assert all(m["content"] != f"m{MAX_MESSAGES_PER_READ}" for m in body["messages"])


def test_get_is_not_truncated_at_exactly_the_cap(use_session: Any) -> None:
    conversation = _conversation()
    cid = conversation.id
    rows = [_message(cid, "user", f"m{n}", seconds=n) for n in range(MAX_MESSAGES_PER_READ)]
    body = (
        use_session(FakeSession(found=conversation, results=[rows]))
        .get(f"/v1/conversations/{cid}")
        .json()
    )
    assert body["truncated"] is False
    assert len(body["messages"]) == MAX_MESSAGES_PER_READ


@pytest.mark.parametrize(
    "stored", ['{"title": "x"}', '[{"title": "no path"}]', "not json", '"str"']
)
def test_get_drops_unreadable_citations_instead_of_failing(use_session: Any, stored: str) -> None:
    conversation = _conversation()
    message = _message(conversation.id, "assistant", "ok", citations=stored)
    session = FakeSession(found=conversation, results=[[message]])
    res = use_session(session).get(f"/v1/conversations/{conversation.id}")
    assert res.status_code == 200
    assert res.json()["messages"][0]["citations"] is None


def test_get_an_unknown_conversation_is_404_and_runs_no_message_query(use_session: Any) -> None:
    session = FakeSession(found=None)
    res = use_session(session).get(f"/v1/conversations/{uuid.uuid4()}")
    assert res.status_code == 404
    assert _is_error(res.json(), "not_found")
    assert session.statements == []


@pytest.mark.parametrize("bad", ["abc", "123", "not-a-uuid"])
def test_get_a_malformed_id_is_422_not_404(use_session: Any, bad: str) -> None:
    session = FakeSession()
    res = use_session(session).get(f"/v1/conversations/{bad}")
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")
    assert session.get_calls == []


# --- cross-cutting -----------------------------------------------------------------------


def test_every_route_echoes_the_inbound_trace_id(use_session: Any) -> None:
    conversation = _conversation()
    session = FakeSession(found=conversation, results=[[], [], []])
    client = use_session(session)
    headers = {"x-trace-id": INBOUND}
    responses = [
        client.post("/v1/conversations", headers=headers),
        client.get("/v1/conversations", headers=headers),
        client.get(f"/v1/conversations/{conversation.id}", headers=headers),
        client.get(f"/v1/conversations/{uuid.uuid4()}", headers=headers),  # fake finds any id
        client.get("/v1/conversations/bad", headers=headers),
    ]
    assert [r.headers["x-trace-id"] for r in responses] == [INBOUND] * len(responses)


def test_error_bodies_carry_the_same_trace_id_as_the_header(use_session: Any) -> None:
    res = use_session(FakeSession(found=None)).get(
        f"/v1/conversations/{uuid.uuid4()}", headers={"x-trace-id": INBOUND}
    )
    assert res.json()["trace_id"] == INBOUND == res.headers["x-trace-id"]


def test_the_routes_exist_under_v1_only(use_session: Any) -> None:
    client = use_session(FakeSession())
    assert client.get("/conversations").status_code == 404
    assert client.post("/conversations").status_code == 404


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, level: str) -> Any:
        def record(*args: Any, **kwargs: Any) -> None:
            self.calls.append((level, args, kwargs))

        return record


def test_titles_and_message_text_never_reach_the_logs(
    use_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder = _Recorder()
    monkeypatch.setattr(conversations_router, "_log", recorder)
    secret_title, secret_text = "TITLE-SENTINEL-4711", "BODY-SENTINEL-4711"
    conversation = _conversation(secret_title)
    message = _message(conversation.id, "user", secret_text, citations="not json")
    session = FakeSession(found=conversation, results=[[conversation], [message]])
    client = use_session(session)
    client.post("/v1/conversations", json={"title": secret_title})
    client.get("/v1/conversations")
    client.get(f"/v1/conversations/{conversation.id}")
    assert recorder.calls  # something was logged ...
    logged = json.dumps(recorder.calls, default=str)
    assert secret_title not in logged and secret_text not in logged  # ... but no user content


def test_openapi_documents_the_three_routes_and_the_404() -> None:
    schema = app.openapi()
    assert set(schema["paths"]["/v1/conversations"]) == {"get", "post"}
    assert schema["paths"]["/v1/conversations"]["post"]["responses"]["201"]
    get_one = schema["paths"]["/v1/conversations/{conversation_id}"]["get"]
    assert "404" in get_one["responses"] and "422" in get_one["responses"]


# --- review follow-ups ------------------------------------------------------------------


def test_create_returns_the_id_that_was_stored(use_session: Any) -> None:
    session = FakeSession()
    body = use_session(session).post("/v1/conversations", json={"title": "Mine"}).json()
    assert body["id"] == str(session.added[0].id)


def test_create_stores_naive_utc_at_millisecond_precision(use_session: Any) -> None:
    session = FakeSession()
    body = use_session(session).post("/v1/conversations").json()
    stored = session.added[0]
    assert stored.created_at.tzinfo is None  # the DATETIME2(3) columns hold no offset
    assert stored.created_at.microsecond % 1000 == 0  # so POST and a later GET agree
    assert stored.created_at == stored.updated_at
    assert datetime.fromisoformat(body["created_at"]).replace(tzinfo=None) == stored.created_at


def test_create_rejects_a_title_longer_than_200_utf16_code_units(use_session: Any) -> None:
    # 150 emoji are 150 characters but 300 UTF-16 code units: NVARCHAR(200) would overflow.
    session = FakeSession()
    res = use_session(session).post("/v1/conversations", json={"title": EMOJI * 150})
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")
    assert session.added == []


def test_create_accepts_100_emoji_which_fill_the_column_exactly(use_session: Any) -> None:
    res = use_session(FakeSession()).post("/v1/conversations", json={"title": EMOJI * 100})
    assert res.status_code == 201


@pytest.mark.parametrize("raw", ["{not json", "[1, 2"])
def test_create_with_malformed_json_is_422(use_session: Any, raw: str) -> None:
    res = use_session(FakeSession()).post(
        "/v1/conversations", content=raw, headers={"content-type": "application/json"}
    )
    assert res.status_code == 422
    assert _is_error(res.json(), "validation_error")


def test_create_with_a_json_null_body_uses_the_default_title(use_session: Any) -> None:
    res = use_session(FakeSession()).post(
        "/v1/conversations", content="null", headers={"content-type": "application/json"}
    )
    assert res.status_code == 201
    assert res.json()["title"] == "New conversation"


def test_as_utc_handles_naive_and_aware_datetimes() -> None:
    naive = datetime(2026, 10, 6, 9, 0, 0)
    aware = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone(timedelta(hours=3)))
    assert conversations_router._as_utc(naive) == datetime(2026, 10, 6, 9, 0, tzinfo=UTC)
    assert conversations_router._as_utc(aware) == datetime(2026, 10, 6, 9, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "stored",
    ["[" * 5000 + "]" * 5000, json.dumps([{"title": "t", "path": "p" * 70_000}])],
    ids=["deeply-nested", "too-large"],
)
def test_get_survives_hostile_stored_citations(use_session: Any, stored: str) -> None:
    conversation = _conversation()
    message = _message(conversation.id, "assistant", "ok", citations=stored)
    session = FakeSession(found=conversation, results=[[message]])
    res = use_session(session).get(f"/v1/conversations/{conversation.id}")
    assert res.status_code == 200  # not a 500 for the whole conversation
    assert res.json()["messages"][0]["citations"] is None


# --- chunk numbers on stored citations (roadmap api:5.4) ---------------------------------------


def _read_citations(use_session: Any, stored: Any) -> Any:
    conversation = _conversation()
    cid = conversation.id
    message = _message(cid, "assistant", "x", seconds=1, citations=json.dumps(stored))
    session = FakeSession(found=conversation, results=[[message]])
    res = use_session(session).get(f"/v1/conversations/{cid}")
    assert res.status_code == 200
    return res.json()["messages"][0]["citations"]


def test_stored_chunk_numbers_are_read_back(use_session: Any) -> None:
    stored = [{"title": "T", "path": "docs/t.md", "chunks": [1, 3]}]
    assert _read_citations(use_session, stored) == stored


def test_odd_chunk_values_never_make_a_stored_row_unreadable(use_session: Any) -> None:
    stored = [
        {"title": "A", "path": "docs/a.md", "chunks": ["x", 1, 2.5, True, 0, -1, 2, 2]},
        {"title": "B", "path": "docs/b.md", "chunks": "1,2"},
        {"title": "C", "path": "docs/c.md", "chunks": None},
        {"title": "D", "path": "docs/d.md", "chunks": list(range(1, 500))},
    ]
    read = _read_citations(use_session, stored)
    assert [c["path"] for c in read] == ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]
    assert read[0]["chunks"] == [1, 2]  # only whole numbers from 1 up, unique, ascending
    assert read[1]["chunks"] is None and read[2]["chunks"] is None  # unknown
    assert read[3]["chunks"] == list(range(1, 51))  # capped


def test_the_citation_schema_documents_chunks_as_optional(use_session: Any) -> None:
    schema = app.openapi()["components"]["schemas"]["Citation"]
    assert set(schema["properties"]) == {"title", "path", "chunks"}
    assert schema["required"] == ["title", "path"]  # an old shape (no chunks) stays valid
    assert "[n]" in schema["properties"]["chunks"]["description"]
