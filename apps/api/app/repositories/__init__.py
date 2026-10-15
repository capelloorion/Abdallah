"""Query functions for the project database — SQL stays out of the routers.

Each module takes an ``AsyncSession`` (from ``Depends(get_session)`` in a route, a fake in a
test) and uses ORM constructs only (``select(...)``, ``session.add``) — never string-built SQL
(``.claude/rules/25-sqlalchemy.md``).
"""

from __future__ import annotations
