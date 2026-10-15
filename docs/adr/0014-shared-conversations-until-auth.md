# ADR-0014: Conversations are shared (no owner) until auth lands

|        |            |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-10-06 |

## Context

Team Assistant stores conversations and messages in Azure SQL. The platform has no user auth
(team decision D8; Okta is planned later and needs its own ADR and threat model). Without an
identity there is nothing to own a conversation by, and no user identifier may enter logs, spans
or metrics ([rule 70](../../.claude/rules/70-ai.md)).

## Decision

`conversations` and `messages` carry no owner column. Every user can list, open and continue
every conversation. When Okta lands, ownership is added by a migration and a new ADR.

## Consequences

- Good: no identity plumbing before auth exists; the schema stays simple.
- Bad: anything one user types is readable by every other user of the app, indefinitely
  (retention is "keep forever" in this release). Users must not enter personal or confidential data.
- Bad: adding an owner later means backfilling existing rows (to a placeholder owner, or deleting
  them) — a data migration on a populated table.
- Bad: no per-user delete or rename; both are out of scope for this release.

## Alternatives considered

- **Anonymous per-browser id (cookie) as the owner** — rejected: it looks like ownership but is not
  security, and it creates a user identifier that rule 70 keeps out of telemetry.
- **Add a nullable `owner` column now** — rejected: unused column, and its semantics are decided
  by the auth ADR, not by guessing.

## References

- Related ADRs: ADR-0008 (Azure SQL), ADR-0009
- Docs: `docs/architecture.md` (B7), `.claude/rules/50-security.md`
