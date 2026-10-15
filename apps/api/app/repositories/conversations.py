"""Conversation and message queries (roadmap api:1.2).

Conversations are shared (ADR-0014): no query here filters by an owner.

Ordering notes:

* The list is newest ``updated_at`` first (``created_at`` then ``id`` break ties so paging is
  stable). Paging is keyset, not offset: a page starts strictly after the last row of the
  previous one, so conversations added or updated in between never repeat or skip a row that was
  already in place. The cursor is the last row's sort key, ``base64url`` encoded.
* A conversation's messages are read newest-first (so the cap keeps the most recent turns) and
  reversed, giving oldest-first to the caller. Two turns of one exchange can share a
  ``created_at`` millisecond; ``role`` ascending in the newest-first read (``assistant`` before
  ``user``) makes the reversed result put the ``user`` message first; ``id`` is the last key, so
  the cap boundary is deterministic.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Conversation, Message
from app.models.conversation import DEFAULT_CONVERSATION_TITLE

# The ask route sends this many of the newest stored messages to the model as history.
HISTORY_MESSAGES = 10
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 100
# A read returns at most this many messages (the most recent); the response says when it cut.
MAX_MESSAGES_PER_READ = 500


# A cursor is ``<updated_at>|<created_at>|<id>`` (naive UTC, millisecond ISO, hyphenated UUID),
# base64url without padding: about 80 characters, so anything longer is refused before decoding.
MAX_CURSOR_LENGTH = 120
_CURSOR_CHARS = re.compile(r"[A-Za-z0-9_-]+")
_STAMP = "%Y-%m-%dT%H:%M:%S.%f"


class InvalidCursor(ValueError):
    """The text is not a cursor this api issued (malformed, altered or from another format)."""


@dataclass(frozen=True)
class Cursor:
    """The sort key of the last row on a page: the next page starts strictly after it."""

    updated_at: datetime
    created_at: datetime
    id: uuid.UUID

    def encode(self) -> str:
        raw = "|".join((_stamp(self.updated_at), _stamp(self.created_at), str(self.id)))
        return base64.urlsafe_b64encode(raw.encode("ascii")).decode("ascii").rstrip("=")

    @classmethod
    def decode(cls, text: str) -> Cursor:
        """Parse a cursor, or raise ``InvalidCursor``. Only the exact text ``encode`` produces is
        accepted, so a sloppy variant (padding, case, extra digits) cannot be a second spelling of
        the same position.
        """
        if not text or len(text) > MAX_CURSOR_LENGTH or not _CURSOR_CHARS.fullmatch(text):
            raise InvalidCursor
        try:
            raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode("ascii")
            updated, created, ident = raw.split("|")
            cursor = cls(
                updated_at=datetime.strptime(updated, _STAMP),
                created_at=datetime.strptime(created, _STAMP),
                id=uuid.UUID(ident),
            )
        except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
            raise InvalidCursor from exc
        if cursor.encode() != text:
            raise InvalidCursor
        return cursor


def _stamp(value: datetime) -> str:
    """Millisecond ISO text of a naive UTC time (the column keeps three decimals)."""
    return value.strftime(_STAMP)[:-3] + "000"


@dataclass(frozen=True)
class ConversationPage:
    conversations: list[Conversation]
    next_cursor: str | None


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


async def list_conversations(
    session: AsyncSession, limit: int, after: Cursor | None = None
) -> ConversationPage:
    """One page of at most ``limit`` conversations, newest ``updated_at`` first, starting strictly
    after ``after`` when given. One extra row is read to know whether another page exists.
    """
    statement = select(Conversation)
    if after is not None:
        statement = statement.where(
            or_(
                Conversation.updated_at < after.updated_at,
                and_(
                    Conversation.updated_at == after.updated_at,
                    or_(
                        Conversation.created_at < after.created_at,
                        and_(
                            Conversation.created_at == after.created_at,
                            Conversation.id > after.id,
                        ),
                    ),
                ),
            )
        )
    statement = statement.order_by(
        Conversation.updated_at.desc(),
        Conversation.created_at.desc(),
        Conversation.id,
    ).limit(limit + 1)
    rows = list((await session.scalars(statement)).all())
    page = rows[:limit]
    more = len(rows) > limit
    last = page[-1] if more else None
    next_cursor = (
        Cursor(updated_at=last.updated_at, created_at=last.created_at, id=last.id).encode()
        if last is not None
        else None
    )
    return ConversationPage(conversations=page, next_cursor=next_cursor)


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
