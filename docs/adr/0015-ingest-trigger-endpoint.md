# ADR-0015: Re-indexing is triggered by `POST /v1/admin/ingest` (202, background, single-flight)

|        |            |
| ------ | ---------- |
| Status | Proposed   |
| Date   | 2026-10-06 |

## Context

Re-indexing the corpus today is a CLI run (`uv run python -m app.ai.ingest <path>`,
[ADR-0009](0009-ai-runtime-langchain-langgraph-foundry.md)). The feature map (F3) asks for "one
command/endpoint". An endpoint is a mutating, cost-bearing action (embedding calls, writes to the
shared AI Search index) on a platform with no auth. The api runs 1–2 replicas in dev and 2–6 in
prod (`main.<env>.bicepparam`).

## Decision

The api exposes `POST /v1/admin/ingest`: no request body, returns `202 {"status":"started"}`, runs
the ingestion in the background, and returns `409 ingest_running` while one is running.

**Open before this is accepted:** `docs/architecture.md` says the BFF mirrors every route. This ADR
recommends the BFF does **not** mirror this one (see Consequences); the team decides.

## Consequences

- Good: one trigger for both local and deployed use; the job stays idempotent (stable chunk ids).
- Bad: "single-flight" held in process memory only holds **per replica**. With more than one
  replica two ingests can run at once; they are idempotent, so the result is correct but the cost
  doubles. A real guard (a SQL row lock, or a lease in storage) is needed before prod scales out.
- Bad: a background task dies with its replica on scale-in or restart; the next call re-runs it.
- Bad: with no auth, anyone who can reach the route can start a re-index. If the BFF mirrors it,
  that is every browser user; not mirroring it keeps the browser out. Either way a threat model for
  F3 is required.

## Alternatives considered

- **CLI / Container Apps Job only** — rejected for now: no endpoint to call from a pipeline, but it
  is the safer fallback if the single-flight problem is not worth solving.
- **Mirror the route in the BFF with an admin page** — the architecture doc's current plan; not
  recommended here: it exposes a mutating admin action to the browser with no auth.

## References

- Related ADRs: ADR-0009, ADR-0013, ADR-0014
- Docs: `docs/architecture.md` (B3, B4a, B8 #2), `.claude/rules/70-ai.md`
