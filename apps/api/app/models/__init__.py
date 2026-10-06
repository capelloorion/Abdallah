"""ORM models (ADR-0004). Every model module is imported below so it registers on
``Base.metadata`` — Alembic autogenerate only sees imported models.

Models today: ``Conversation`` and ``Message`` (``conversation.py``, roadmap api:1.1). Their
revision lives in ``alembic/versions/``; migrations are NOT run by this project — applying one
is the Environment-gated ``migrate.yml`` workflow or a named human.

HOW TO EXTEND:
  1. Add a module here (e.g. ``app/models/widget.py``) with a 2.0-style model
     subclassing ``app.db.Base`` and import it below so it registers on
     ``Base.metadata`` (Alembic autogenerate only sees imported models).
  2. With a reachable dev database, generate a revision (needs a human + DB):
         uv run alembic revision --autogenerate -m "add widget"
     Review the generated ``upgrade()``/``downgrade()``; offline SQL for review:
         uv run alembic upgrade head --sql
  3. Applying it (``alembic upgrade head``) is a deliberate, confirmed human step —
     never run from an agent (``.claude/rules/25-sqlalchemy.md``).

Example model (uncomment and adapt)::

    # app/models/widget.py
    from datetime import datetime
    from uuid import UUID, uuid4

    from sqlalchemy import func
    from sqlalchemy.orm import Mapped, mapped_column

    from app.db import Base


    class Widget(Base):
        __tablename__ = "widgets"

        id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
        name: Mapped[str]
        created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    # then, here:
    # from app.models.widget import Widget  # noqa: F401
"""

from __future__ import annotations

from app.models.conversation import Conversation, Message

__all__ = ["Conversation", "Message"]
