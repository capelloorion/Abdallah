"""create conversations and messages

Revision ID: 0001
Revises:
Create Date: 2026-10-06 12:32:51.225735

Roadmap api:1.1. Two NEW tables, so nothing here rewrites or locks existing data: the index and
the foreign key are created together with an empty ``messages`` table (the ``ONLINE``/``NOCHECK``
patterns in ``.claude/rules/25-sqlalchemy.md`` are for populated tables).

Names go through ``op.f(...)`` because ``Base.metadata`` carries a naming convention (a plain name
would be wrapped in the convention a second time). ``downgrade()`` DROPS both tables and every
message in them — applying it to a database that holds conversations is destructive and needs
explicit human confirmation.

Rules (.claude/rules/25-sqlalchemy.md): ``downgrade()`` is MANDATORY and must undo
``upgrade()`` exactly; destructive operations (drop table/column, data loss) need explicit
human confirmation. SQL Server has no ``CONCURRENTLY`` / ``NOT VALID`` — see the rule for the
patterns to use on populated tables.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create ``conversations`` and ``messages`` (shared chat history, ADR-0014)."""
    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("NEWID()"), nullable=False),
        sa.Column(
            "title", sa.Unicode(length=200), server_default="New conversation", nullable=False
        ),
        sa.Column(
            "created_at",
            mssql.DATETIME2(precision=3),
            server_default=sa.func.sysutcdatetime(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            mssql.DATETIME2(precision=3),
            server_default=sa.func.sysutcdatetime(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_conversations")),
    )
    op.create_table(
        "messages",
        sa.Column("id", sa.Uuid(), server_default=sa.text("NEWID()"), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.Unicode(length=20), nullable=False),
        sa.Column("content", sa.Unicode(), nullable=False),
        sa.Column("citations", sa.Unicode(), nullable=True),
        sa.Column("token_count", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            mssql.DATETIME2(precision=3),
            server_default=sa.func.sysutcdatetime(),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('user','assistant')", name=op.f("ck_messages_role_valid")),
        sa.CheckConstraint(
            "citations IS NULL OR ISJSON(citations)=1", name=op.f("ck_messages_citations_is_json")
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_messages_conversation_id_conversations"),
            ondelete="NO ACTION",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_messages")),
    )
    op.create_index(op.f("ix_messages_conversation_id"), "messages", ["conversation_id"])


def downgrade() -> None:
    """Drop both tables in reverse order (destructive — see the module docstring)."""
    op.drop_index(op.f("ix_messages_conversation_id"), table_name="messages")
    op.drop_table("messages")
    op.drop_table("conversations")
