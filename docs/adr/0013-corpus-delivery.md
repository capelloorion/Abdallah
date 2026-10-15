# ADR-0013: Knowledge-base corpus comes from the repo's `docs/`, baked into the api image when deployed

|        |            |
| ------ | ---------- |
| Status | Proposed   |
| Date   | 2026-10-06 |

## Context

Team Assistant answers from the team's own documentation (`docs/**/*.md`) indexed in Azure AI Search
(index `team-assistant-docs`, [ADR-0009](0009-ai-runtime-langchain-langgraph-foundry.md)). The ingestion job
(`app/ai/ingest.py`) reads a local path. Locally that path is the repo's `docs/`; in a deployed
container there is no repo. `apps/api` builds from its own context (`docker-compose.yml`:
`context: ./apps/api`), so the repo-root `docs/` is outside the image build today.

## Decision

We use the repo's `docs/` as the corpus. Deployed runs read it from `/app/corpus` inside the api
image; locally the ingest path is `docs/`. The build copies `docs/` into the api image at build time.

## Consequences

- Good: the corpus is versioned with the code; a deploy always carries the docs it was built from.
- Good: no extra storage account or upload step to operate.
- Bad: the api image must be built with a context that includes `docs/` (or a pre-build copy step
  into `apps/api`), which changes the "each app builds from its own folder" layout — the Dockerfile,
  compose file and CI build step all change.
- Bad: a docs-only change needs an image rebuild and a re-ingest to reach the index.
- Bad: everything under `docs/` is searchable by every user, including design drafts and
  architecture notes (no access control until auth lands).

## Alternatives considered

- **Corpus in Blob Storage, ingest reads from the container** — rejected for the first release: one
  more resource and an upload pipeline; revisit if docs change faster than releases.
- **Ingest from CI (GitHub Action runs `python -m app.ai.ingest docs/` against the index)** — not
  rejected, just not chosen; it avoids baking docs into the image but needs a pipeline identity on
  the shared Search service.

## References

- Related ADRs: ADR-0009, ADR-0012
- Docs: `docs/architecture.md` (B3, B8 #1), `apps/api/CLAUDE.md`
