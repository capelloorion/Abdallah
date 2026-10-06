# API roadmap — Team Assistant

Schema: [`../README.md`](../README.md). Backend (`apps/api`): models, migrations, `/v1`
endpoints, AI graphs/tools, ingestion.

**Planned from (2026-10-06):** the team's draft Part B in `docs/architecture.md` (F1 chat with
citations · F2 conversation history · F3 knowledge base) and the `/chat` wireframe in
`docs/wireframe.md`, reviewed by `/architecture-review` the same day. `ARCHITECTURE.md` Part B and
`docs/design/db-design.md` have **not** been updated yet — when the team applies them, re-run
`/plan-roadmap api` and reconcile. The template already ships the `retrieve → answer` graph, SSE
streaming (`app/ai/streaming.py`), the ingestion job, the error contract and an empty `/v1`
router; these items only add what is missing.

**Authoring never waits for Azure.** Models, hand-written migrations, endpoints and the AI graph
changes are all testable offline (fake sessions, `GenericFakeChatModel`, `FakeRetriever`). Only
_applying_ the migration, _running_ ingestion and a _real_ model answer need `infra:1.1` and the
human steps listed on each item.

## Open decisions (from the architecture review — they gate the items marked `blocked`)

| #   | Decision                                                                                                                                   | Gates          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Q1  | Is `POST /v1/admin/ingest` mirrored by the web BFF, or CLI/server-only? **Decided: server/CLI-only**                                       | 4.1, 4.2, web  |
| Q2  | Corpus delivery: different build context, pre-build copy of `docs/` into `apps/api`, or CI ingest? **Decided: pre-build copy**             | 4.3 (ADR-0013) |
| Q3  | Follow-up retrieval: last question only, previous turn + question, or a condense step? **Decided: previous turn + question**               | 2.3            |
| Q4  | Corpus scope: only `docs/**/*.md`, or also `README.md` / `.claude/rules/`? Any off-limits files? **Decided: `docs/**/\*.md` allow-list\*\* | 4.2            |
| Q5  | Over-long question: `413 payload_too_large` (draft B4a) or `422 validation_error` (template)? **Decided: 413**                             | 2.2, 3.1       |
| Q6  | `messages.token_count`: input tokens, output tokens, or the sum? **Decided: output tokens**                                                | 2.2, 3.1       |

**Decisions recorded 2026-10-06 by Abdallah Ahmed (developer):**

- **Q1** — the web BFF does not mirror ingest; it is server/CLI-only (endpoint off by default; a web test asserts there is no route under `apps/web/src/app/api/v1/admin/`).
- **Q4** — corpus = an explicit allow-list of `docs/**/*.md`, default deny; `docs/security/` and design drafts excluded unless opted in.
- **Q3** — a follow-up retrieves on the previous user turn plus the new question (no extra model call). **Q5** — a question over 4,000 characters is `413 payload_too_large`. **Q6** — `messages.token_count` is the output (completion) tokens. **Q2** — the corpus is copied from `docs/` into `apps/api` at build time. These four are the recommended defaults, accepted in bulk; each can be changed later.
- **Accepted:** the shared-conversations threat model (R1–R6) and the notice wording shipped in web 4.1; ADR-0014 is `Accepted`. **Not yet accepted:** the ingest residual risks R1–R7 and ADR-0015 (to confirm before 4.2 ships).

## Phase 1 — Conversations (F2)

### 1.1 — Conversation and Message models + migration

- **status:** done
- **depends_on:** []
- **layers:** [model, migration, docs]
- **acceptance:**
  - `conversations` (`id`, `title nvarchar(200)`, `created_at`, `updated_at`) and `messages` (`id`, `conversation_id`, `role`, `content`, `citations`, `token_count`, `created_at`) exist exactly as specified in `docs/architecture.md` B4; UUID keys (`uniqueidentifier`), `datetime2(3)` UTC timestamps with server defaults
  - `messages.conversation_id` is a foreign key to `conversations.id` with `NO ACTION`, indexed; `role` has a named `CHECK (role IN ('user','assistant'))`; `citations` is nullable with a named `CHECK (citations IS NULL OR ISJSON(citations)=1)`
  - `content` and `citations` are `nvarchar(max)` by design; the exception to the length-on-every-string rule is written in `docs/design/db-design.md`, which also replaces its example diagram with the real tables
  - the Alembic revision has a working downgrade; `alembic upgrade head --sql` and the downgrade SQL are generated and read as correct SQL Server DDL
- **how_to_test:**
  - `just test` — api: **216 passed** (web: 136 passed); the new tests are `apps/api/tests/test_models_conversation.py` and the rewritten `apps/api/tests/test_alembic.py`
  - `uv run --directory apps/api alembic heads` → `0001 (head)`
  - `uv run --directory apps/api alembic upgrade head --sql` → no database needed; the output holds `CREATE TABLE conversations`, `CREATE TABLE messages` (with `NVARCHAR(max)` for `content`/`citations`, `DATETIME2(3)`, the two named `CHECK`s and `ON DELETE NO ACTION`) and `CREATE INDEX ix_messages_conversation_id`
  - `uv run --directory apps/api alembic downgrade head:base --sql` → `DROP INDEX`, `DROP TABLE messages`, `DROP TABLE conversations`, in that order
  - open `docs/design/db-design.md`: the real tables, the diagram and the `nvarchar(max)` exception are there
- **needs_human:**
  - review the offline SQL, then apply with `migrate.yml` on `dev` (needs the `DEV_SQL_SERVER_FQDN` / `DEV_SQL_DATABASE` secrets and the contained SQL user)
  - confirm the dev SQL server's firewall is not open to the whole internet (the developer said "all IPs are allowed"; `.claude/rules/50-security.md`)
- **notes:**
  - 2026-10-06 — planned by `/plan-roadmap api`. Conversations are shared (no owner column) per the draft B7 / ADR-0014 (Proposed).
  - 2026-10-06 — started by Claude
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/api/app/models/conversation.py`, `apps/api/app/models/__init__.py`, `apps/api/alembic/versions/20261006_1232-0001_create_conversations_and_messages.py`, `apps/api/tests/test_models_conversation.py`, `apps/api/tests/test_alembic.py`, `docs/design/db-design.md`, `apps/api/CHANGELOG.md`, version 0.3.0 → 0.4.0 (`pyproject.toml`, `uv.lock` kept on lock revision 3 so the pinned uv 0.10.9 reads it), plus the docs that said "empty model set / no revisions". The migration was never applied and no database was contacted.
  - 2026-10-06 — reviews run: `code-reviewer` (no code blockers; stale-doc, docstring and test nits fixed) and `security-reviewer` (no critical/high). Left for the team: `docs/architecture/ARCHITECTURE.md` Part A lines 108 and 194 still say "no models, no migrations by design" — template-owned, propose the edit rather than apply it.
  - 2026-10-06 — confirmed by the developer (done). The migration is still not applied to any database; that stays a human step (needs_human above).

### 1.2 — Conversation endpoints (create, list, get)

- **status:** done
- **depends_on:** [1.1]
- **layers:** [endpoint]
- **acceptance:**
  - `POST /v1/conversations` with optional `{title}` returns `201 {id, title, created_at, updated_at}`; a missing title becomes "New conversation"; a title over 200 characters returns `422 validation_error`
  - `GET /v1/conversations?limit=50` (1–100) returns `200 {items: [{id, title, updated_at}], count}` newest `updated_at` first; a limit outside 1–100 returns `422 validation_error`
  - `GET /v1/conversations/{id}` returns the conversation plus `messages: [{id, role, content, citations, created_at}]`, oldest first; an unknown id returns `404 not_found`, a malformed id `422 validation_error`
  - every response echoes `x-trace-id`; errors use `{error, trace_id}`; no message content appears in logs, spans, metrics or events
  - `docs/reference/openapi.json` and the web's `src/lib/api-types.ts` are regenerated (`just openapi`) so the web items can type their mocks against them
- **how_to_test:**
  - `just test` — api: **263 passed** (web: 136 passed); the new file is `apps/api/tests/test_conversations_api.py` (47 tests, no database)
  - `just openapi` then `git status` — `docs/reference/openapi.json` and `apps/web/src/lib/api-types.ts` show no further change (they already contain the three routes)
  - needs the dev database (after 1.1 is applied and `DATABASE_URL` is set in `apps/api/.env`): `uv run --directory apps/api uvicorn app.main:app --port 8000`, then
    - `curl -s -X POST localhost:8000/v1/conversations -H 'content-type: application/json' -d '{"title":"Trace ids"}'` → `201` `{id, title, created_at, updated_at}`
    - `curl -s localhost:8000/v1/conversations` → `200`, the new conversation first, `count` ≥ 1
    - `curl -s localhost:8000/v1/conversations/<id>` → `200`, `"messages": []`, `"truncated": false`
    - `curl -si localhost:8000/v1/conversations/00000000-0000-0000-0000-000000000000` → `404` `{"error":"not_found","trace_id":"…"}` and the same value in the `x-trace-id` header
    - `curl -s -o /dev/null -w "%{http_code}" "localhost:8000/v1/conversations?limit=101"` → `422`
- **needs_human:**
  - apply migration 1.1 on `dev` (`migrate.yml`) and put the dev `DATABASE_URL` in `apps/api/.env` (a secret — not set by an agent) to run the curl steps above
  - prove against a real SQL Server what offline tests cannot: millisecond timestamps round-trip, the 200-UTF-16-unit title limit, `TOP`/`ORDER BY` and the `role` collation order, and that a naive datetime inserts through pyodbc
- **notes:**
  - 2026-10-06 — planned. Tested with a fake session; no database needed.
  - 2026-10-06 — from the 1.1 security review: `GET /v1/conversations/{id}` loads a whole history, so cap the number of messages returned (or paginate); titles are user content and appear in the list for everyone (ADR-0014).
  - 2026-10-06 — started by Claude
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/api/app/routers/conversations.py`, `apps/api/app/repositories/` (new), `apps/api/app/routers/v1.py`, `apps/api/tests/test_conversations_api.py`, regenerated `docs/reference/openapi.json` and `apps/web/src/lib/api-types.ts`, `docs/reference/http-api.md`, `apps/api/CLAUDE.md`, `apps/api/CHANGELOG.md`, version 0.4.0 → 0.5.0 (`uv.lock` kept on lock revision 3 for the pinned uv 0.10.9), plus a few "no business features" orientation lines. Nothing applied, no database contacted.
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed: UTF-16 title limit, millisecond timestamps, citations hardening (size cap, RecursionError), deterministic message order, plain top-of-file import, stale HTTP docs, weaker tests. API addition beyond the draft contract: `truncated` on `GET /v1/conversations/{id}` (older messages cannot be fetched yet; paging is a later item).
  - 2026-10-06 — NOT done here, for later items (re-run `/plan-roadmap api` to turn them into items): (a) `POST /v1/conversations` is an unauthenticated write with no rate limit or growth cap, and the list has no paging, so a flood could push real conversations off the list (rate limit at BFF/ingress, a cursor on `updated_at`/`id`, retention); (b) a request-body size limit at the BFF/ingress; (c) the message-writing item (2.2) must cap `content` and stored answer length and validate `citations` strictly, including a format check on `path`; (d) the web layer must render titles, message text and citation paths as plain text (no `dangerouslySetInnerHTML`, no `javascript:` links). Team-owned docs to update: add `truncated` to B4a in `docs/architecture.md`.
  - 2026-10-06 — confirmed by the developer (done). Real-database checks (needs_human above) are still open.

### 1.3 — Threat model: shared conversation content

- **status:** done
- **depends_on:** []
- **layers:** [docs]
- **acceptance:**
  - `docs/security/threat-models/shared-conversations.md` exists (STRIDE, via the `threat-modeler` agent) covering: every user can read every conversation, content kept indefinitely, users pasting personal data or secrets into chat, content in Azure SQL
  - each threat has a mitigation or an explicitly accepted residual risk, and the document references ADR-0014
- **how_to_test:**
  - open `docs/security/threat-models/shared-conversations.md`: STRIDE threats S/T/Rp/I/D/E, an AI section, "what changes when Okta lands", residual risks R1–R6, proposed items P1–P6, open questions, review triggers
  - check that every threat has a mitigation (with where it lives and its status) or an explicit accepted residual risk, and that ADR-0014 is referenced
  - `docs/security/threat-models/README.md` lists it as "Draft (awaiting team acceptance)"
  - `just fmt` is clean (docs only; no code or tests changed)
- **needs_human:**
  - the team reads the document and accepts or changes the residual risks R1–R6 (shared visibility, no rate limit/paging/body limit, indefinite retention, PII notice wording, stored wrong answers, content reaching Foundry/Search), then changes its status from Draft to Accepted — **api 2.2 must not start before this**
  - decide the PII notice wording (proposed in section 9; it is the text web 4.1 will show)
  - verify what the threat model could not: Foundry/Search prompt and query retention, database backup retention, whether the OTel instrumentors capture bound parameters or request bodies, and that no BFF rate or body limit exists
  - infra/network (for the infra layer, not edited here): the web app has `externalIngress: true` and the SQL server has a public endpoint plus the `AllowAllWindowsAzureIps` rule, so "internal-only" depends on the cloud team's network posture
- **notes:**
  - 2026-10-06 — planned from the review's "threat models to write".

## Phase 2 — Grounded answers (F1)

- 2026-10-06 — started by Claude
  - 2026-10-06 — written by the `threat-modeler` agent; awaiting test by the developer. Files: `docs/security/threat-models/shared-conversations.md`, `docs/security/threat-models/README.md`. Code facts I re-checked: neither engine sets `hide_parameters` (SQLAlchemy errors can include bound parameters, i.e. titles or questions); web ingress is external and api ingress internal; SQL has a public endpoint and `AllowAllWindowsAzureIps`. No code reviewer or security-review run: this item is documentation and is itself the security analysis.
  - 2026-10-06 — the threat model proposes six items that are in NO roadmap yet (P1 `hide_parameters` + a no-content-in-errors canary; P2 rate limit + list cursor; P3 operator purge runbook for the SQL tables; P4 request-body size limit; P5 optional secret screening; P6 CSP/security headers + render tests). Re-run `/plan-roadmap api` (and web/infra) to turn them into items.
  - 2026-10-06 — confirmed by the developer (done). The document is still Draft: the team's acceptance of R1–R6 (needs_human above) gates api 2.2.

### 2.1 — Citation contract: document titles on sources

- **status:** done
- **depends_on:** []
- **layers:** [ai]
- **acceptance:**
  - ingestion stores a `title` on every chunk (first `# ` heading of the file, else the file name); `build_index` defines the field
  - the retriever returns the title with each chunk; the `sources` and `done` SSE frames and the JSON answer carry `citations: [{title, path}]`, unique by path, in retrieval order — instead of a list of path strings
  - the system prompt still cites inline `[n]`; the eval cases in `tests/evals/cases.json` cover the citation shape and the "I do not know" answer when the context is empty
  - retrieved text, titles and paths never appear in logs, spans, metrics or events
- **how_to_test:**
  - `just test` — api: **315 passed** (web: 136 passed); the changed/new tests are in `apps/api/tests/ai/test_ai_graph_streaming.py`, `apps/api/tests/ai/test_ai_tools_retrieval_ingest.py` and `apps/api/tests/evals/` (`cases.json` now has four cases and asserts `expect_citations`)
  - `uv run --directory apps/api python -c "from app.ai.ingest import document_title; print(document_title('docs/x.md', '# Learning C#\n'))"` → `Learning C#`; with text `intro only` it prints `x.md`
  - `just openapi` then `git status` — no change (the api ships no route that uses the citation shape yet)
  - needs the dev Search service (see needs_human): `uv run --directory apps/api python -m app.ai.ingest ../../docs` → `documents=… chunks=… uploaded=… failed=0`; in the Azure portal the index has a searchable `title` field and a chunk shows its document heading
- **needs_human:**
  - confirm index `team-assistant-docs` does not exist yet on the shared Search service, or that it may be updated: the retriever now selects `title`, so an index without that field makes retrieval fail until `ensure_index` (the first step of the ingest command) has added it in place — do this before the first real question (4.2)
  - run the ingest command above against `dev` (needs the `AZURE_AI_*` / `AZURE_SEARCH_*` values in `apps/api/.env` — secrets, not set by an agent — and the api identity or a dev key with Search Index Data Contributor + Search Service Contributor)
  - what only a live index proves: that Azure accepts the new `title` field on an existing index in place, the exact error when the field is missing, and the effect of a searchable `title` on ranking
- **notes:**
  - 2026-10-06 — planned. The title field changes the index schema; the architecture review suggested a short amendment to ADR-0009 (not drafted).
  - 2026-10-06 — started by Claude
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/api/app/ai/tools/retrieve.py` (`title` field, `fallback_title`, `clean_title`, `chunk_title`), `apps/api/app/ai/graph.py` (`Citation`, `citations_for`, `Answer.citations`; `unique_sources` and `Answer.sources` removed), `apps/api/app/ai/streaming.py` (`sources` and `done` frames carry `citations`), `apps/api/app/ai/ingest.py` (`document_title`, `title` on every chunk and in `build_index`, BOM-safe reads), tests and evals, `docs/architecture/ai.md`, `apps/api/CHANGELOG.md`, version 0.5.0 → 0.6.0 (`uv.lock` kept on lock revision 3). The wire key is `citations` (event name stays `sources`).
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: `# Learning C#` was cut to "Learning C" (closing `#` run now only dropped when preceded by whitespace; linear-time, no regex), fence tracking (type and length), BOM, YAML front matter, indented headings, bidi/control characters removed, title cap applied again on read, the old-index failure mode stated correctly, and many more edge-case tests.
  - 2026-10-06 — NOT done here, for other items: (a) web item 2.1 must read `citations` instead of `sources` (the template's example route, mock and tests still use string `sources`; they pass only because they mock the wire) and must render titles as plain text and link a `path` only through an allow-list (relative, no scheme, no `..`, `docs/…`) — threat model T5; (b) item 4.2: `path` is whatever path was given to the ingest CLI, so running it with an absolute or `../../docs` path stores that string and shows it to users — store paths relative to the repo root (or reject absolute paths and `..`); and one non-UTF-8 file under `docs/` aborts the whole ingest (catch per file, log a count); (c) `search_fields` is not pinned, so the searchable `title` now also affects keyword ranking — acceptable while only repo writers can change headings; (d) the roadmap suggested a short amendment to ADR-0009 for the new index field — not drafted.
  - 2026-10-06 — confirmed by the developer (done). The live-index checks (needs_human above) are still open.

### 2.2 — Ask a question (JSON)

- **status:** todo
- **depends_on:** [1.2, 1.3, 2.1]
- **layers:** [ai, endpoint]
- **acceptance:**
  - `POST /v1/conversations/{id}/ask` with `{question}` returns `200 {message_id, answer, citations}`
  - the user message is stored before retrieval; the assistant message (content, citations as JSON, `token_count`) is stored after the answer; `conversations.updated_at` is set on both writes; a conversation still titled "New conversation" gets the first question cut to 200 characters
  - the model receives the last 10 stored messages as history, plus retrieved context and the question, through `app.ai.graph.ask`
  - an empty question returns `422 validation_error`; a question over 4,000 characters is rejected (`413 payload_too_large`, pending Q5); an unknown conversation returns `404 not_found`; a model or search failure returns `503 ai_unavailable`, the user message is kept and no assistant message is stored
  - timeout 60 s; every response echoes `x-trace-id`; no content in any telemetry
  - OpenAPI and `api-types.ts` regenerated
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - migration 1.1 applied on `dev`; `AZURE_AI_*` and `AZURE_SEARCH_*` values in `apps/api/.env` (secrets — not set by an agent)
  - a populated index (after 4.2) for a real grounded answer
- **notes:**
  - 2026-10-06 — planned. Open: Q5 (status code for a long question) and Q6 (`token_count` meaning; default to output tokens until decided).
  - 2026-10-06 — from the 1.1 security review: `content` is `nvarchar(max)` with no database-side limit, so the 4,000-character question limit MUST be enforced in the request model, and the stored answer length bounded; validate that `citations` is an array of `{title, path}` before storing (the database only checks `ISJSON`).
  - 2026-10-06 — from the shared-conversations threat model (api:1.3): this item may not start until the team has accepted that document. Acceptance must also carry: question cap in the request model, bounded stored answer length, strict `citations` validation with a `path` format check, history sent to the model only as human/assistant messages, citations only from retrieval, injection eval cases, and no content in telemetry. Do P1 (`hide_parameters=True` on both engines) before this merges, so a failed insert cannot put a title or question into an exception.

### 2.3 — Follow-up-aware retrieval

- **status:** blocked
- **depends_on:** [2.2]
- **layers:** [ai]
- **acceptance:**
  - a follow-up such as "And on the api side?" retrieves documents relevant to the conversation, not only to the last sentence, using the approach chosen in Q3
  - the eval harness has a follow-up case that fails with last-question-only retrieval
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team answers Q3 (a condense step adds a model call and a graph node)
- **notes:**
  - 2026-10-06 — blocked: Q3 undecided. The `retrieve` node searches on the last user message only (`app/ai/graph.py`), so the wireframe's own follow-up example would retrieve nothing relevant.

## Phase 3 — Streaming

### 3.1 — Ask a question (SSE stream)

- **status:** todo
- **depends_on:** [2.2]
- **layers:** [ai, endpoint]
- **acceptance:**
  - `POST /v1/conversations/{id}/ask/stream` with `{question}` returns `200 text/event-stream` with frames `sources` → `token`\* → `done`, built on `app.ai.streaming`; `sources` and `done` carry `[{title, path}]`
  - validation, `404` and any failure before the first frame return the normal JSON error body and status (`404 not_found`, `422`/`413`, `503 ai_unavailable`); a failure after the first frame sends `event: error {"error_kind": …}` and ends the stream; the user message is kept and no assistant message is stored
  - the assistant message (content, citations, `token_count`) is stored before the `done` frame is sent; a client disconnect before `done` stores no assistant message
  - the response carries the `x-trace-id` header (the error frame has no trace id; the UI reads the header)
  - the SSE frames are documented in the OpenAPI response description
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the real-model run needs the same setup as 2.2
- **notes:**
  - 2026-10-06 — planned. The web BFF hop timeout must exceed the api's 60 s (web roadmap).

## Phase 4 — Knowledge base (F3)

- 2026-10-06 — from the api:1.3 threat model: carry the same write-side mitigations as 2.2, plus the disconnect-before-done behaviour.

### 4.1 — Threat model: knowledge-base ingestion

- **status:** done
- **depends_on:** []
- **layers:** [docs]
- **acceptance:**
  - `docs/security/threat-models/knowledge-base-ingest.md` exists (via the `threat-modeler` agent) covering: an unauthenticated, cost-bearing trigger; BFF exposure (Q1); prompt injection through a corpus anyone with repo access can edit; per-replica single-flight; everything under `docs/` readable by every user
  - each threat has a mitigation or an accepted residual risk
- **how_to_test:**
  - open `docs/security/threat-models/knowledge-base-ingest.md` and check that it covers each of: the unauthenticated, cost-bearing trigger (section on T/E/D threats), BFF exposure (Q1, with a recommendation), prompt injection through an editable corpus, per-replica single-flight, and everything under `docs/` being readable by every user
  - every threat row has a mitigation or an accepted residual risk (R1–R7)
  - `pnpm exec prettier --check docs/security/threat-models` is clean; the README table lists the new document
- **needs_human:**
  - the team decides **Q1** (recommended: **no**, the BFF does not mirror ingest) and **Q4** (corpus scope: explicit allow-list), accepts or rejects residual risks R1–R7, and answers the open questions Q-K1 to Q-K6 (who calls the endpoint, CODEOWNERS on corpus paths, role-holder list, the identity split for Search write access)
  - ADR-0015 moves from `Proposed` to `Accepted`, or is revised: the threat model recommends NOT shipping it as written (an unauthenticated cost trigger and whole-`docs/` exposure are both High)
  - the team applies the proposed edit to `docs/architecture/ARCHITECTURE.md` Part B (B3/B4a currently say the BFF mirrors every route); agents only propose that
- **notes:**
  - 2026-10-06 — planned from the review's "threat models to write".
  - 2026-10-06 — started by Claude
  - 2026-10-06 — drafted by the `threat-modeler` agent: `docs/security/threat-models/knowledge-base-ingest.md` (Draft, awaiting team acceptance; gates 4.2). Findings worth knowing: the corpus loader follows symlinks and indexes absolute paths as `source`; ingestion only adds and overwrites, so a removed secret or poisoned passage stays retrievable until stale chunks are reconciled (K5); the in-memory single-flight guard holds per process, and prod runs 2–6 replicas.
  - 2026-10-06 — confirmed by the developer (done). The team decisions and risk acceptance (needs_human above) are still open and gate 4.2.

### 4.2 — Ingest endpoint

- **status:** todo
- **depends_on:** [2.1, 4.1]
- **layers:** [ai, endpoint]
- **acceptance:**
  - `POST /v1/admin/ingest` takes no body and returns `202 {"status": "started"}`; it runs the existing ingestion job (load → chunk → embed → upload, stable chunk ids) over the configured corpus path in the background
  - while a run is in progress in the same process, a second call returns `409 ingest_running`; the guard is released when the run finishes or fails
  - a failed run logs the outcome kind and counts only — no document text — and the next call can start a new run
  - the route is under `/v1`, echoes `x-trace-id`, and is documented in OpenAPI; it is not added to the web BFF (per the review's recommendation, subject to Q1)
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - decide the corpus scope and path (Q4)
  - request write access to the Search index for the api identity in `infra/grant-request.md`; the cloud team grants it
  - run the first ingestion on `dev` and check the index
- **notes:**
  - 2026-10-06 — planned. The single-flight guard here is in process memory, so it holds per replica only (ADR-0015); 5.1 closes that.
  - 2026-10-06 — from the ingest threat model (api:4.1): do not start until the team accepts it. Acceptance must carry: K1 corpus allow-list plus a pre-ingest secret scan that fails the run (paths and counts only), K2 a safe loader (regular files only, no symlinks, resolved path inside the corpus root, size caps, `source` relative to the corpus root), K3 an in-memory cooldown and run budget with deadlines and the guard released in `finally`, K4 `INGEST_ENDPOINT_ENABLED` default off (`404` when off) plus a web test that no route exists under `apps/web/src/app/api/v1/admin/`, K5 reconcile stale chunks (or a recorded deferral), K11 no content in telemetry with a canary test, K12 an `ingest.run` audit event (manifest hash, commit SHA). Add a `needs_human` entry for the Search write-role grant (K8, `infra/grant-request.md`).

### 4.3 — Corpus inside the deployed api image

- **status:** blocked
- **depends_on:** [4.2]
- **layers:** [infra, docs]
- **acceptance:**
  - the deployed api can read the agreed corpus at `/app/corpus`; the image build and the CI build step produce it from `docs/` using the approach chosen in Q2
  - ADR-0013 is `Accepted` (or replaced) and `docker-compose.yml`, `apps/api/Dockerfile` and `apps/api/CLAUDE.md` match
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team answers Q2
- **notes:**
  - 2026-10-06 — blocked: Q2 undecided. `docs/` is outside the api build context (`context: ./apps/api`, Dockerfile `COPY . /app`), so the draft's "bake into the image" cannot work as written. This is a Dockerfile/CI change, not Bicep.

## Phase 5 — Hardening

- 2026-10-06 — from the ingest threat model (api:4.1): the corpus is built from the K1 allow-list (deny-by-default build context, no symlinks, a CI listing and a CI secret scan); K6 provenance (CODEOWNERS and required review on corpus paths; ingest only from a corpus CI built from `main`) is a human step; record the manifest hash and commit SHA in the image and keep the corpus read-only to `appuser`; weigh CI-ingest or a Container Apps Job for prod when Q2 is answered.

### 5.1 — Ingest single-flight across replicas

- **status:** todo
- **depends_on:** [4.2]
- **layers:** [endpoint]
- **acceptance:**
  - with two api replicas running, only one ingestion runs at a time; a call to the other replica returns `409 ingest_running`
  - the lock expires if the replica holding it dies, so a crashed run cannot block ingestion forever
  - the mechanism chosen (SQL application lock or a lease row) is recorded in ADR-0015
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - a lease table would need a migration reviewed and applied with `migrate.yml`
- **notes:**
  - 2026-10-06 — planned. Must land before prod scales out: `main.prod.bicepparam` sets `apiReplicas` min 2.
  - 2026-10-06 — from the ingest threat model (api:4.1): a persisted cooldown, a lease that stores the corpus version and refuses older runs (rolling-deploy downgrade), lease expiry, a "started without finished" alert; the endpoint stays off in any environment with more than one replica until this ships; note K7 (index swap) for rebuild windows.
