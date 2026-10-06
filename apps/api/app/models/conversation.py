"""Conversation and Message — the chat history aggregate (roadmap api:1.1, ADR-0014).

``conversations`` holds one row per chat; ``messages`` holds its turns. Conversations are
SHARED: there is no owner column until auth lands (ADR-0014), so every user can list and read
every conversation.

SQL Server notes (``.claude/rules/25-sqlalchemy.md``):

* Text is ``Unicode`` (``NVARCHAR``) — plain ``String``/``Text`` would render ``VARCHAR`` and lose
  non-ASCII characters in questions and answers. ``UnicodeText`` is avoided: offline (``--sql``)
  it renders the deprecated ``NTEXT``; ``Unicode()`` with no length renders ``NVARCHAR(max)``.
* ``content`` and ``citations`` are ``NVARCHAR(max)`` BY DESIGN: an answer has no useful upper
  bound. This is the documented exception to "a length on every string column"
  (``docs/design/db-design.md``).
* Timestamps are ``DATETIME2(3)`` in UTC, defaulted by the server with ``SYSUTCDATETIME()``
  (the legacy ``DATETIME`` that ``DateTime`` renders on SQL Server is not used).
* Both ``CheckConstraint``s carry an explicit ``name=`` (the naming convention's ``ck`` template
  needs it); the foreign key is ``NO ACTION`` — deleting a conversation is out of scope.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Unicode, Uuid, func, text
from sqlalchemy.dialects.mssql import DATETIME2
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

DEFAULT_CONVERSATION_TITLE = "New conversation"
TITLE_MAX_LENGTH = 200
ROLE_MAX_LENGTH = 20


class Conversation(Base):
    """One chat. ``updated_at`` orders the list, so it must be bumped when a message is added."""

    __tablename__ = "conversations"

    id: Mapped[UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid4, server_default=text("NEWID()")
    )
    title: Mapped[str] = mapped_column(
        Unicode(TITLE_MAX_LENGTH), nullable=False, server_default=DEFAULT_CONVERSATION_TITLE
    )
    created_at: Mapped[datetime] = mapped_column(
        DATETIME2(precision=3), nullable=False, server_default=func.sysutcdatetime()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DATETIME2(precision=3),
        nullable=False,
        server_default=func.sysutcdatetime(),
        onupdate=func.sysutcdatetime(),
    )


class Message(Base):
    """One turn of a conversation: the user's question or the assistant's answer."""

    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint("role IN ('user','assistant')", name="role_valid"),
        CheckConstraint("citations IS NULL OR ISJSON(citations)=1", name="citations_is_json"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid4, server_default=text("NEWID()")
    )
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="NO ACTION"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(Unicode(ROLE_MAX_LENGTH), nullable=False)
    content: Mapped[str] = mapped_column(Unicode(), nullable=False)
    # JSON array of {title, path}; NULL for user messages and for answers with no sources.
    citations: Mapped[str | None] = mapped_column(Unicode(), nullable=True)
    token_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DATETIME2(precision=3), nullable=False, server_default=func.sysutcdatetime()
    )
