"""``/v1/conversations`` — create, list and read chat conversations (roadmap api:1.2).

Conversations are shared (ADR-0014): every caller sees every conversation. Titles and message
text are user content, so nothing here logs them — only ids' existence, counts and outcomes
(``.claude/rules/50-security.md``, rule 70).

Errors follow ``app/errors.py``: ``404 not_found`` for an unknown id, ``422 validation_error``
for a bad body, query or id (field details are logged by the handler, never returned).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, StringConstraints, TypeAdapter
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorBody, NotFound
from app.logging_config import get_logger
from app.models.conversation import TITLE_MAX_LENGTH, Message
from app.repositories import conversations as repo

router = APIRouter(prefix="/conversations", tags=["conversations"])
_log = get_logger("app.conversations")

DbSession = Annotated[AsyncSession, Depends(get_session)]


def _as_utc(value: datetime) -> datetime:
    """The columns hold naive UTC; the API always speaks timezone-aware UTC."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


def _fits_the_column(value: str) -> str:
    """``NVARCHAR(200)`` counts UTF-16 code units, not characters: an emoji is two.

    Without this check a title of 101-200 emoji would pass the length check, overflow the column
    and surface as a 500 instead of a 422.
    """
    if len(value.encode("utf-16-le")) // 2 > TITLE_MAX_LENGTH:
        raise ValueError(f"title is longer than {TITLE_MAX_LENGTH} UTF-16 code units")
    return value


Title = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=TITLE_MAX_LENGTH),
    AfterValidator(_fits_the_column),
]


class ConversationCreate(BaseModel):
    """Optional body of ``POST /v1/conversations``."""

    title: Title | None = None


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    created_at: UtcDatetime
    updated_at: UtcDatetime


class ConversationSummary(BaseModel):
    id: uuid.UUID
    title: str
    updated_at: UtcDatetime


class ConversationList(BaseModel):
    items: list[ConversationSummary]
    count: int


class Citation(BaseModel):
    title: str
    path: str


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    citations: list[Citation] | None
    created_at: UtcDatetime


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    truncated: bool


_citations_adapter = TypeAdapter(list[Citation])
# Stored citations are a short list of {title, path}; anything bigger is not parsed at all.
MAX_CITATIONS_JSON_CHARS = 64 * 1024


def _parse_citations(raw: str | None) -> list[Citation] | None:
    """The stored JSON as citations; ``None`` for no citations or a value of the wrong shape.

    The database only checks ``ISJSON``; a malformed value must not break reading the whole
    conversation, so it is dropped and only the fact is logged (never the content).
    """
    if raw is None:
        return None
    if len(raw) > MAX_CITATIONS_JSON_CHARS:
        _log.warning("message citations unreadable", outcome="dropped", reason="too_large")
        return None
    try:
        return _citations_adapter.validate_python(json.loads(raw))
    except ValueError, RecursionError:  # ValidationError is a ValueError; deep nesting recurses
        _log.warning("message citations unreadable", outcome="dropped", reason="invalid")
        return None


def _message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        role=message.role,
        content=message.content,
        citations=_parse_citations(message.citations),
        created_at=message.created_at,
    )


@router.post("", status_code=201, response_model=ConversationOut)
async def create_conversation(
    session: DbSession, body: ConversationCreate | None = None
) -> ConversationOut:
    """Start a conversation. A missing or blank title becomes "New conversation"."""
    conversation = await repo.create_conversation(session, body.title if body else None)
    _log.info("conversation created")
    return ConversationOut.model_validate(conversation, from_attributes=True)


@router.get("", response_model=ConversationList)
async def list_conversations(
    session: DbSession,
    limit: Annotated[int, Query(ge=1, le=repo.MAX_LIST_LIMIT)] = repo.DEFAULT_LIST_LIMIT,
) -> ConversationList:
    """The most recently updated conversations, newest first."""
    rows = await repo.list_conversations(session, limit)
    items = [ConversationSummary.model_validate(row, from_attributes=True) for row in rows]
    _log.info("conversations listed", count=len(items))
    return ConversationList(items=items, count=len(items))


@router.get(
    "/{conversation_id}",
    response_model=ConversationDetail,
    responses={404: {"model": ErrorBody, "description": "Unknown conversation (`not_found`)"}},
)
async def get_conversation(session: DbSession, conversation_id: uuid.UUID) -> ConversationDetail:
    """One conversation with its messages, oldest first.

    At most the most recent ``MAX_MESSAGES_PER_READ`` messages are returned;
    ``truncated`` is true when older ones were left out.
    """
    found = await repo.get_conversation_with_messages(session, conversation_id)
    if found is None:
        raise NotFound()
    _log.info("conversation read", messages=len(found.messages), truncated=found.truncated)
    conversation = found.conversation
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[_message_out(m) for m in found.messages],
        truncated=found.truncated,
    )
