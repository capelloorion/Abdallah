"""The chat-history models (roadmap api:1.1): shape, constraints and defaults.

No database is involved — the models are inspected through SQLAlchemy metadata and rendered
with the SQL Server dialect. ``test_alembic.py`` proves the migration matches them.
"""

from __future__ import annotations

from typing import Any

import pyodbc
import pytest
from sqlalchemy import CheckConstraint, Column, ForeignKeyConstraint, Integer, MetaData, Table
from sqlalchemy import exc as sa_exc
from sqlalchemy.dialects import mssql
from sqlalchemy.schema import CreateTable

from app.db.base import NAMING_CONVENTION, Base
from app.models import Conversation, Message
from app.models.conversation import DEFAULT_CONVERSATION_TITLE, TITLE_MAX_LENGTH

DIALECT = mssql.dialect()


def _columns(model: type[Base]) -> dict[str, tuple[str, bool]]:
    """column name -> (SQL Server type, nullable)."""
    return {
        c.name: (c.type.compile(dialect=DIALECT), bool(c.nullable))
        for c in model.__table__.columns  # type: ignore[attr-defined]
    }


def test_models_register_exactly_two_tables_on_the_shared_metadata() -> None:
    assert set(Base.metadata.tables) == {"conversations", "messages"}
    assert Conversation.__tablename__ == "conversations"
    assert Message.__tablename__ == "messages"


def test_conversation_columns_match_the_design() -> None:
    assert _columns(Conversation) == {
        "id": ("UNIQUEIDENTIFIER", False),
        "title": ("NVARCHAR(200)", False),
        "created_at": ("DATETIME2(3)", False),
        "updated_at": ("DATETIME2(3)", False),
    }
    assert TITLE_MAX_LENGTH == 200


def test_message_columns_match_the_design() -> None:
    assert _columns(Message) == {
        "id": ("UNIQUEIDENTIFIER", False),
        "conversation_id": ("UNIQUEIDENTIFIER", False),
        "role": ("NVARCHAR(20)", False),
        # NVARCHAR(max), never the deprecated NTEXT: an answer has no useful upper bound.
        "content": ("NVARCHAR(max)", False),
        "citations": ("NVARCHAR(max)", True),
        "token_count": ("INTEGER", True),
        "created_at": ("DATETIME2(3)", False),
    }


def test_there_is_no_owner_column_until_auth_lands() -> None:
    # ADR-0014: conversations are shared. Adding an owner is a new migration + a new ADR.
    for model in (Conversation, Message):
        assert not {"owner", "owner_id", "user_id", "user"} & set(model.__table__.columns.keys())  # type: ignore[attr-defined]


def test_primary_keys_are_uuids_with_client_and_server_defaults() -> None:
    for model in (Conversation, Message):
        pk = list(model.__table__.primary_key.columns)  # type: ignore[attr-defined]
        assert [c.name for c in pk] == ["id"]
        assert pk[0].default is not None  # uuid4 in the ORM
        assert str(pk[0].server_default.arg) == "NEWID()"  # and for inserts outside the ORM


def test_timestamps_default_to_utc_on_the_server() -> None:
    for model in (Conversation, Message):
        created = model.__table__.c.created_at  # type: ignore[attr-defined]
        assert "sysutcdatetime" in str(created.server_default.arg.compile(dialect=DIALECT))
    # updated_at is also refreshed by the ORM whenever the conversation row is updated.
    assert Conversation.__table__.c.updated_at.onupdate is not None


def test_title_defaults_to_new_conversation_on_the_server() -> None:
    assert DEFAULT_CONVERSATION_TITLE == "New conversation"
    assert Conversation.__table__.c.title.server_default.arg == DEFAULT_CONVERSATION_TITLE


def test_message_foreign_key_is_no_action_and_indexed() -> None:
    table = Message.__table__  # type: ignore[attr-defined]
    fks = [c for c in table.constraints if isinstance(c, ForeignKeyConstraint)]
    assert len(fks) == 1
    fk = fks[0]
    assert fk.name == "fk_messages_conversation_id_conversations"
    assert [e.target_fullname for e in fk.elements] == ["conversations.id"]
    assert fk.ondelete == "NO ACTION"  # deleting a conversation is out of scope
    indexes = {i.name: [c.name for c in i.columns] for i in table.indexes}
    assert indexes == {"ix_messages_conversation_id": ["conversation_id"]}


def test_message_check_constraints_are_named_and_restrict_values() -> None:
    # Offline we can pin the names and the exact predicate text; whether SQL Server accepts or
    # rejects a given value (ISJSON, the role list) can only be proven against a database.
    checks = {
        c.name: str(c.sqltext)
        for c in Message.__table__.constraints  # type: ignore[attr-defined]
        if isinstance(c, CheckConstraint)
    }
    assert checks == {
        "ck_messages_role_valid": "role IN ('user','assistant')",
        "ck_messages_citations_is_json": "citations IS NULL OR ISJSON(citations)=1",
    }


def test_ddl_renders_for_sql_server_without_touching_a_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[tuple[Any, ...]] = []
    monkeypatch.setattr(pyodbc, "connect", lambda *a, **k: attempts.append((a, k)))
    for table in Base.metadata.sorted_tables:
        assert str(CreateTable(table).compile(dialect=DIALECT)).startswith("\nCREATE TABLE")
    assert attempts == []


def test_an_unnamed_check_constraint_is_rejected_under_the_naming_convention() -> None:
    # The rule-25 gotcha the models avoid: the `ck` template needs an explicit name, and
    # SQLAlchemy raises as soon as the constraint is attached to a table.
    with pytest.raises(sa_exc.InvalidRequestError, match="explicitly named"):
        Table(
            "scratch",
            MetaData(naming_convention=NAMING_CONVENTION),
            Column("n", Integer),
            CheckConstraint("n > 0"),
        )
