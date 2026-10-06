"""Alembic wiring and the revision history (ADR-0004 / ADR-0008): no hard-coded URL, a single
linear revision chain, and the async ``env.py`` runs in OFFLINE mode with no database and no
connection — rendering for the SQL Server dialect. The models and the migration must describe
the SAME schema (parity test below), since autogenerate needs a database that tests never have.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Any

import pyodbc
import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.dialects import mssql
from sqlalchemy.schema import CreateIndex, CreateTable

import app.models  # noqa: F401  — registers the models on Base.metadata
from app.db.base import Base

SERVICE_ROOT = Path(__file__).resolve().parents[1]
INI = SERVICE_ROOT / "alembic.ini"
ENV_PY = SERVICE_ROOT / "alembic" / "env.py"
VERSIONS = SERVICE_ROOT / "alembic" / "versions"

TEST_URL = (
    "mssql+aioodbc://u:p@db.invalid:1433/app"
    "?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no"
)


def _config(output: io.StringIO | None = None) -> Config:
    return Config(str(INI), output_buffer=output, stdout=io.StringIO())


@pytest.fixture()
def _restore_logging():
    """env.py applies alembic.ini's CLI logging via fileConfig; undo it afterwards
    so the service's stdlib logging setup is untouched for the rest of the run."""
    root = logging.getLogger()
    saved = (root.level, list(root.handlers))
    yield
    root.setLevel(saved[0])
    root.handlers[:] = saved[1]
    for name in ("alembic", "sqlalchemy.engine"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.setLevel(logging.NOTSET)
        logger.propagate = True


def test_ini_has_no_hardcoded_database_url() -> None:
    assert "sqlalchemy.url" not in INI.read_text(encoding="utf-8")


def test_script_location_resolves_to_the_alembic_dir() -> None:
    script = ScriptDirectory.from_config(_config())
    assert Path(script.dir).resolve() == (SERVICE_ROOT / "alembic").resolve()
    assert (SERVICE_ROOT / "alembic" / "script.py.mako").is_file()


def test_versions_dir_holds_one_linear_revision() -> None:
    assert VERSIONS.is_dir()
    script = ScriptDirectory.from_config(_config())
    assert script.get_heads() == ["0001"]
    revisions = list(script.walk_revisions())
    assert [r.revision for r in revisions] == ["0001"]
    assert revisions[0].down_revision is None  # the first revision; no branches


def test_env_py_reads_url_from_settings_and_targets_base_metadata() -> None:
    source = ENV_PY.read_text(encoding="utf-8")
    compile(source, str(ENV_PY), "exec")  # syntactically valid
    assert "get_settings().database_url" in source
    assert "target_metadata = Base.metadata" in source
    assert "import app.models" in source
    assert 'config.get_main_option("sqlalchemy.url")' not in source


def _offline_sql(monkeypatch: pytest.MonkeyPatch, *, upgrade: bool) -> str:
    """The SQL ``alembic upgrade head --sql`` / ``downgrade head:base --sql`` would emit.

    Asserts on the way that offline mode never opens a database connection.
    """
    attempts: list[tuple[Any, ...]] = []

    def fake_connect(*args: Any, **kwargs: Any) -> None:
        attempts.append((args, kwargs))
        raise AssertionError("offline mode must never connect")

    monkeypatch.setattr(pyodbc, "connect", fake_connect)
    monkeypatch.setenv("DATABASE_URL", TEST_URL)

    output = io.StringIO()
    if upgrade:
        command.upgrade(_config(output), "head", sql=True)
    else:
        command.downgrade(_config(output), "head:base", sql=True)
    assert attempts == []
    return output.getvalue()


def _normalise(sql: str) -> str:
    """Collapse whitespace and drop statement terminators so renderings can be compared."""
    return " ".join(sql.replace(";", " ").split())


@pytest.mark.usefixtures("_restore_logging")
def test_offline_upgrade_creates_both_tables_without_a_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sql = _offline_sql(monkeypatch, upgrade=True)
    assert "CREATE TABLE conversations" in sql
    assert "CREATE TABLE messages" in sql
    assert "CREATE INDEX ix_messages_conversation_id ON messages (conversation_id)" in sql
    assert "INSERT INTO alembic_version" in sql  # the revision is stamped
    # The destructive statements belong to the downgrade only.
    assert "DROP " not in sql


@pytest.mark.usefixtures("_restore_logging")
def test_offline_downgrade_undoes_the_upgrade_in_reverse_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sql = _offline_sql(monkeypatch, upgrade=False)
    drops = [line.strip() for line in sql.splitlines() if line.strip().startswith("DROP ")]
    assert drops == [
        "DROP INDEX ix_messages_conversation_id ON messages;",
        "DROP TABLE messages;",
        "DROP TABLE conversations;",
    ]
    assert "DELETE FROM alembic_version" in sql  # the stamp is removed


@pytest.mark.usefixtures("_restore_logging")
def test_migration_matches_the_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Parity: every statement the models would create appears, unchanged, in the migration SQL.

    ``alembic check`` (autogenerate drift) needs a reachable database; this is the offline
    equivalent for the tables the models define.
    """
    migration_sql = _normalise(_offline_sql(monkeypatch, upgrade=True))
    dialect = mssql.dialect()
    expected: list[str] = []
    for table in Base.metadata.sorted_tables:
        expected.append(_normalise(str(CreateTable(table).compile(dialect=dialect))))
        expected.extend(
            _normalise(str(CreateIndex(index).compile(dialect=dialect))) for index in table.indexes
        )
    assert len(expected) == 3  # conversations, messages, ix_messages_conversation_id
    for statement in expected:
        assert statement in migration_sql, statement
