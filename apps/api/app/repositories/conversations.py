"""Conversation and message queries (roadmap api:1.2).

Conversations are shared (ADR-0014): no query here filters by an owner.

Ordering notes:

* The list is newest ``updated_at`` first (``created_at`` then ``id`` break ties so paging is
  stable).
* A conversation's messages are read newest-first (so the cap keeps the most recent turns) and
  reversed, giving oldest-first to the caller. Two turns of one exchange can share a
  ``created_at`` millisecond; ``role`` ascending in the newest-first read (``assistant`` before
  ``user``) makes the reversed result put the ``user`` message first; ``id`` is the last key, so
  the cap boundary is deterministic.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Conversation, Message
from app.models.conversation import DEFAULT_CONVERSATION_TITLE

# The ask route sends this many of the newest stored messages to the model as history.
HISTORY_MESSAGES = 10
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 100
# A read returns at most this many messages (the most recent); the response says when it cut.
MAX_MESSAGES_PER_READ = 500


@dataclass(frozen=True)
class ConversationWithMessages:
    conversation: Conversation
    messages: list[Message]
    truncated: bool


def _utc_now() -> datetime:
    """Naive UTC at millisecond precision, matching the ``DATETIME2(3)`` columns.

    Truncating here means the value returned by ``POST`` equals what a later ``GET`` reads back
    (the database would otherwise round the microseconds). The application clock is used so the
    response needs no read-back; the server defaults only cover inserts made outside the api.
    """
    now = datetime.now(UTC).replace(tzinfo=None)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


async def create_conversation(session: AsyncSession, title: str | None) -> Conversation:
    """Insert a conversation and return it with every field populated (no refresh needed)."""
    now = _utc_now()
    conversation = Conversation(
        id=uuid.uuid4(),
        title=title or DEFAULT_CONVERSATION_TITLE,
        created_at=now,
        updated_at=now,
    )
    session.add(conversation)
    await session.commit()
    return conversation


async def list_conversations(session: AsyncSession, limit: int) -> list[Conversation]:
    """The ``limit`` most recently updated conversations, newest first."""
    statement = (
        select(Conversation)
        .order_by(
            Conversation.updated_at.desc(),
            Conversation.created_at.desc(),
            Conversation.id,
        )
        .limit(limit)
    )
    return list((await session.scalars(statement)).all())


async def get_conversation_with_messages(
    session: AsyncSession, conversation_id: uuid.UUID
) -> ConversationWithMessages | None:
    """The conversation and its messages (oldest first, capped), or ``None`` if unknown."""
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        return None
    statement = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc(), Message.role.asc(), Message.id)
        .limit(MAX_MESSAGES_PER_READ + 1)  # one extra row tells us the history was cut
    )
    rows = list((await session.scalars(statement)).all())
    truncated = len(rows) > MAX_MESSAGES_PER_READ
    newest_first = rows[:MAX_MESSAGES_PER_READ]
    return ConversationWithMessages(
        conversation=conversation, messages=list(reversed(newest_first)), truncated=truncated
    )


async def get_conversation(
    session: AsyncSession, conversation_id: uuid.UUID
) -> Conversation | None:
    """The conversation row alone (no messages), or ``None`` if unknown."""
    return await session.get(Conversation, conversation_id)


async def recent_messages(
    session: AsyncSession, conversation_id: uuid.UUID, limit: int = HISTORY_MESSAGES
) -> list[Message]:
    """The ``limit`` newest messages, oldest first — what the model gets as history.

    Same ordering keys as ``get_conversation_with_messages``, so a question and its answer that
    share a millisecond still come back in the order they were asked.
    """
    statement = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc(), Message.role.asc(), Message.id)
        .limit(limit)
    )
    return list(reversed((await session.scalars(statement)).all()))


async def add_user_message(
    session: AsyncSession,
    conversation: Conversation,
    content: str,
    *,
    new_title: str | None = None,
) -> Message:
    """Store a question, bump ``updated_at`` and, while the chat is still called "New
    conversation", give it ``new_title``. One commit, so the changes land together.
    """
    now = _utc_now()
    message = Message(
        id=uuid.uuid4(),
        conversation_id=conversation.id,
        role="user",
        content=content,
        citations=None,
        token_count=None,
        created_at=now,
    )
    session.add(message)
    conversation.updated_at = now
    if new_title and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = new_title
    await session.commit()
    return message


async def add_assistant_message(
    session: AsyncSession,
    conversation: Conversation,
    content: str,
    *,
    citations_json: str | None,
    token_count: int | None,
) -> Message:
    """Store an answer (``citations_json`` is already validated) and bump ``updated_at``."""
    now = _utc_now()
    message = Message(
        id=uuid.uuid4(),
        conversation_id=conversation.id,
        role="assistant",
        content=content,
        citations=citations_json,
        token_count=token_count,
        created_at=now,
    )
    session.add(message)
    conversation.updated_at = now
    await session.commit()
    return message
