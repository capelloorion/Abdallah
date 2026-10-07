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
  **Re-planned (2026-10-06, `/plan-roadmap api`):** Q1–Q6 are all decided (above), so 2.3 and 4.3 are unblocked on the decision side (4.3 still waits for 4.2). 2.2 and 3.1 are done. New Phase 5 items 5.2–5.8 collect what those items and the threat models left open. 4.2 still waits for the team's acceptance of the ingest risks R1–R7 and ADR-0015.

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

- **status:** done
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
  - `just test` — api: **414 passed** (web: 500 passed); the new file is `apps/api/tests/test_ask_api.py` (no database, no model: fake session, recording fake model, fake retriever), plus new cases in `tests/evals/cases.json` (injected history turn, injected corpus passage), `tests/ai/test_ai_telemetry_prompts.py` (span records no exception text) and `tests/test_db_engine.py` / `test_db_external.py` (`hide_parameters`)
  - `just openapi` then `git status` — no further change (the contract already has `POST /v1/conversations/{conversation_id}/ask` with `200/404/413/422/503`)
  - `uv run --directory apps/api alembic heads` is unchanged (`0001`): this item adds no migration
  - needs the dev database, a migration-1.1 schema, and the AI settings (see needs_human): `uv run --directory apps/api uvicorn app.main:app --port 8000`, then
    - `ID=$(curl -s -X POST localhost:8000/v1/conversations | python -c "import sys,json;print(json.load(sys.stdin)['id'])")` (or copy the id from the response by hand)
    - `curl -s -X POST localhost:8000/v1/conversations/$ID/ask -H 'content-type: application/json' -d '{"question":"Which port does the api listen on?"}'` → `200` `{message_id, answer, citations:[{title,path}]}`; the answer is grounded in the ingested docs (an empty index gives an "I do not know" answer and `citations: []`)
    - `curl -s localhost:8000/v1/conversations/$ID` → two messages (user, then assistant with the same citations), and the conversation's title is now your question instead of "New conversation"
    - `-d '{"question":""}'` → `422 validation_error`; a 4001-character question → `413 payload_too_large`; an unknown id → `404 not_found`; every reply echoes `x-trace-id` and error bodies carry the same value
    - with `AZURE_AI_ENDPOINT` unset: `503 ai_unavailable`, and `GET /v1/conversations/$ID` shows the question stored with no answer
  - logs (stdout JSON): one `question answered` line with counts only (`history`, `citations`, `dropped_citations`, `output_tokens`) — never the question, answer, title or a path
- **needs_human:**
  - migration 1.1 applied on `dev`; `AZURE_AI_*` and `AZURE_SEARCH_*` values in `apps/api/.env` (secrets — not set by an agent)
  - a populated index (after 4.2, or the manual ingest from api 2.1) for a real grounded answer
  - prove against a real SQL Server what offline tests cannot: that a stored question/answer with emoji and line breaks round-trips through `nvarchar(max)`, that a 200-UTF-16-unit title is accepted, and that a long answer (up to 20,000 characters) inserts through pyodbc
  - verify the real model path: an `AIMessage` with `usage_metadata` from the Foundry deployment (so `token_count` is not `NULL`), the 60 s ceiling, and (opt-in) `AI_EVAL_LIVE=true uv run --directory apps/api pytest tests/evals` against a real deployment
  - decide whether `max_tokens` should be set on the chat deployment (the answer is cut at 20,000 characters only after it is generated)
  - confirm no `LANGSMITH_*` / `LANGCHAIN_TRACING_V2` variable is set in any environment (it would send prompts and answers to a third party)
- **notes:**
  - 2026-10-06 — planned. Open: Q5 (status code for a long question) and Q6 (`token_count` meaning; default to output tokens until decided).
  - 2026-10-06 — from the 1.1 security review: `content` is `nvarchar(max)` with no database-side limit, so the 4,000-character question limit MUST be enforced in the request model, and the stored answer length bounded; validate that `citations` is an array of `{title, path}` before storing (the database only checks `ISJSON`).
  - 2026-10-06 — from the shared-conversations threat model (api:1.3): this item may not start until the team has accepted that document. Acceptance must also carry: question cap in the request model, bounded stored answer length, strict `citations` validation with a `path` format check, history sent to the model only as human/assistant messages, citations only from retrieval, injection eval cases, and no content in telemetry. Do P1 (`hide_parameters=True` on both engines) before this merges, so a failed insert cannot put a title or question into an exception.
  - 2026-10-06 — started by Claude. Decisions in force: Q5 = 413, Q6 = output tokens; the shared-conversations threat model and ADR-0014 are Accepted (recorded above).
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/api/app/routers/ask.py` (new), `apps/api/app/routers/v1.py`, `apps/api/app/repositories/conversations.py` (`get_conversation`, `recent_messages`, `add_user_message`, `add_assistant_message`), `apps/api/app/db/engine.py` + `external.py` (`hide_parameters=True`, threat model P1), `apps/api/app/ai/telemetry.py` (model-call spans no longer record the exception), `apps/api/app/ai/prompts/system.md` (history is not instructions), tests and evals, regenerated `docs/reference/openapi.json` and `apps/web/src/lib/api-types.ts`, `docs/reference/http-api.md`, `docs/architecture/ai.md`, `docs/architecture/data.md`, `.claude/rules/25-sqlalchemy.md`, `apps/api/CLAUDE.md`, `apps/api/CHANGELOG.md`, version 0.6.0 → 0.7.0 (`pyproject.toml`, `uv.lock` edited by hand on lock revision 3). No migration, nothing applied, no database or Azure service contacted.
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: exception text on model-call spans, lone surrogates in retrieved citation titles/paths, NUL and other control characters in the question (`422`), invisible/format/markup characters in citation paths, stale `ai.md` example comment. Mutation-checked: history sent as a system message, no path check, question stored after retrieval, no answer cap each make a test fail.
  - 2026-10-06 — decisions taken here: the 4,000-character cap is checked in the handler (after the body is parsed), not as a `max_length` on the request model, because Q5 wants `413`, not `422` — so OpenAPI shows no `maxLength` on `question`. A model/search failure, a timeout and an empty answer are all `503 ai_unavailable`. Citations with an unsafe path are dropped, not an error. History messages are cut to 4,000 characters when sent to the model (stored text is unchanged).
  - 2026-10-06 — NOT done here (re-run `/plan-roadmap api` to turn them into items): (a) a request-body size limit and rate/concurrency limit (threat model P2/P4, R2 accepted); (b) `max_tokens` on the chat model; (c) a bounded outcome metric for ask (ok / 503 / timeout); (d) after a `503` the stored question has no answer, so the next ask's history can hold two user turns in a row — fine for Azure OpenAI, to revisit in 2.3/3.1; (e) retrieved text is placed in the system message by the template graph (`app/ai/graph.py`) — the prompt says it is data, but rule 70 / the review checklist say retrieved text must not reach the model as a system message: decide in ADR-0009 whether to accept or move it to a human message; (f) web: any future Markdown/HTML rendering of answers needs a sanitizer and link allow-list first (stored answers can carry attacker-steered markup); (g) percent-encoded paths (`%2e%2e`) are not rejected — harmless while paths are shown as text; (h) the root `CLAUDE.md` still says "no AI answers yet" and "no use case shipped" — a team-owned orientation line to update.
  - 2026-10-06 — confirmed by the developer (done). The real-database / real-model checks (needs_human above) are still open.

### 2.3 — Follow-up-aware retrieval

- **status:** done
- **depends_on:** [2.2]
- **layers:** [ai]
- **acceptance:**
  - a follow-up such as "And on the api side?" retrieves documents relevant to the conversation, not only to the last sentence, using the approach chosen in Q3
  - the eval harness has a follow-up case that fails with last-question-only retrieval
- **how_to_test:**
  - `just test` — api: **467 passed** (web: 500 passed, unchanged); the new cases are in `apps/api/tests/ai/test_ai_graph_streaming.py` (`retrieval_query` edge cases, graph and stream paths), `tests/evals/cases.json` (`follow-up-is-searched-with-the-previous-user-turn`; the harness now takes an `expect_query` per case), `tests/test_ask_api.py` and `tests/test_ask_stream_api.py` (the stored previous user turn reaches the retriever)
  - the follow-up eval case fails with last-question-only retrieval: temporarily change `retrieve` in `apps/api/app/ai/graph.py` to `question = last_user_text(...)` and `uv run --directory apps/api pytest tests/evals -q` fails on that case (checked here: also on the graph, ask and stream tests); revert it
  - `just openapi` then `git status` — no change (no request or response shape changed)
  - needs the dev setup from 2.2/3.1 (migration applied, `AZURE_AI_*` / `AZURE_SEARCH_*`, a populated index): `POST /v1/conversations/$ID/ask` with `{"question":"How does trace_id propagation work?"}`, then `{"question":"And on the api side?"}` → the second answer cites documents about trace ids in the api, not unrelated ones; asking the second question first in a new conversation gives a vaguer answer
  - logs: the query never appears (only `retrieval` lines with outcome, duration and hit count)
- **needs_human:**
  - judge answer quality on a few real conversations once an index is populated (one retrieval query now holds two turns, so a sharp change of topic can pull in the old topic's documents; that is the accepted cost of Q3)
  - the shared-conversations threat model (A1/A5, team-owned) does not yet say that the text sent to Search and the embeddings deployment can include the previous user's question; add a line when the team next edits it
- **notes:**
  - 2026-10-06 — blocked: Q3 undecided. The `retrieve` node searches on the last user message only (`app/ai/graph.py`), so the wireframe's own follow-up example would retrieve nothing relevant.
  - 2026-10-06 — re-planned: unblocked. Q3 was decided on 2026-10-06 (previous turn plus the question). 2.2 is done: the stored history reaches the graph as the `messages` list, so the `retrieve` node can build its query from the last two user turns without a new node or model call. Keep the query bounded (the 4,000-character question cap applies to the new question; cut the previous turn). Retrieval input must never be logged.
  - 2026-10-07 — started by Claude.
  - 2026-10-07 — implemented; awaiting test by the developer. Files: `apps/api/app/ai/graph.py` (`retrieval_query()`, `MAX_PREVIOUS_TURN_CHARS`; the `retrieve` node uses it), tests and evals, `docs/architecture/ai.md`, `apps/api/CHANGELOG.md`, version 0.8.0 → 0.8.1 (`pyproject.toml`, `uv.lock` by hand on lock revision 3; a PATCH because no request or response shape changed). Nothing applied, no database or Azure service contacted. Both `/ask` and `/ask/stream` get it because they share the graph.
  - 2026-10-07 — review run: `code-reviewer` (no blockers). Fixed from it: a retry after a failed answer no longer doubles the question (the failed question stays stored, so a repeat is skipped), a blank earlier turn no longer stops the search for context, and block-style content is read with `_message_text`. Not run: `security-reviewer` (no BFF, env, external HTTP, DB or tool change). Mutation-checked: last-question-only retrieval fails the follow-up eval case and the graph, ask and stream tests.
  - 2026-10-07 — decisions taken here: only user turns are used (never the assistant's answer), the previous turn is cut to 1,000 characters, and the query is never logged. The query can now carry another user's earlier question to Search and Foundry (conversations are shared, ADR-0014) — bounded to which documents are retrieved; it cannot reach the system role.
  - 2026-10-07 — confirmed by the developer (done). Judging answer quality on real conversations (needs_human above) is still open.

## Phase 3 — Streaming

### 3.1 — Ask a question (SSE stream)

- **status:** done
- **depends_on:** [2.2]
- **layers:** [ai, endpoint]
- **acceptance:**
  - `POST /v1/conversations/{id}/ask/stream` with `{question}` returns `200 text/event-stream` with frames `sources` → `token`\* → `done`, built on `app.ai.streaming`; `sources` and `done` carry `[{title, path}]`
  - validation, `404` and any failure before the first frame return the normal JSON error body and status (`404 not_found`, `422`/`413`, `503 ai_unavailable`); a failure after the first frame sends `event: error {"error_kind": …}` and ends the stream; the user message is kept and no assistant message is stored
  - the assistant message (content, citations, `token_count`) is stored before the `done` frame is sent; a client disconnect before `done` stores no assistant message
  - the response carries the `x-trace-id` header (the error frame has no trace id; the UI reads the header)
  - the SSE frames are documented in the OpenAPI response description
- **how_to_test:**
  - `just test` — api: **453 passed** (web: 500 passed); the new file is `apps/api/tests/test_ask_stream_api.py` (no database, no model: fake session, a fake chat model that really streams, fake retriever; one test drives the whole ASGI app with a hand-made `receive` that disconnects after the first token)
  - `just openapi` then `git status` — no further change (the contract has `POST /v1/conversations/{conversation_id}/ask/stream` with `200 text/event-stream` and `404/413/422/503`; the frames are in the 200 description)
  - `pnpm -C apps/web typecheck` clean (the regenerated `api-types.ts`)
  - needs the dev database, the migration-1.1 schema and the AI settings (see needs_human): `uv run --directory apps/api uvicorn app.main:app --port 8000`, then `ID=<id from POST /v1/conversations>` and
    - `curl -sN -X POST localhost:8000/v1/conversations/$ID/ask/stream -H 'content-type: application/json' -d '{"question":"Which port does the api listen on?"}'` → `event: sources` with the citations, then many `event: token`, then `event: done` with the citations and token counts; `GET /v1/conversations/$ID` shows the stored question and answer (with the same citations) and the title now holds the question
    - `Ctrl-C` curl in the middle of an answer, then `GET /v1/conversations/$ID` → the question is there, **no** assistant message for it, and the api log shows `ask stream ended by the client`
    - an unknown id → `404`, an empty question → `422`, a 4001-character question → `413`, each as normal JSON with `{error, trace_id}` (not a stream); `AZURE_AI_ENDPOINT` unset → `503 ai_unavailable` as JSON, question stored
    - through the web (`MOCK_UPSTREAM` off): http://localhost:3000/chat → ask → the answer streams in and a reload shows it
  - logs: one `question streamed` line with counts only (`history`, `citations`, `dropped_citations`, `output_tokens`); failures log `outcome` and a bounded `error_kind`, never content
- **needs_human:**
  - the real-model run needs the same setup as 2.2 (migration 1.1 applied on `dev`, `AZURE_AI_*` / `AZURE_SEARCH_*` in `apps/api/.env`, a populated index)
  - verify under the real server what offline tests cannot: that a browser/curl disconnect really cancels the model and search work (the unit tests close the generator and disconnect through a hand-made ASGI `receive`, not through uvicorn), that Azure Container Apps ingress and any proxy do not buffer or cut an idle stream (there is no SSE keep-alive; the first token can take several seconds), and the web disconnect check from web 1.2 ("verify the browser-disconnect abort under the real Next server")
  - decide whether the stream needs a heartbeat/comment frame for the platform's idle timeout
- **notes:**
  - 2026-10-06 — planned. The web BFF hop timeout must exceed the api's 60 s (web roadmap).
  - 2026-10-06 — started by Claude.
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/api/app/routers/ask.py` (`_begin` shared with `/ask`, `_stream_frames`, `ask_question_stream`, `EventStreamResponse`), `apps/api/app/ai/streaming.py` (`stream_events()` typed events; `stream_answer()` formats them, wire format unchanged; the graph run is closed in a `finally`), tests, regenerated `docs/reference/openapi.json` and `apps/web/src/lib/api-types.ts`, `docs/reference/http-api.md`, `docs/architecture/ai.md`, `apps/api/CLAUDE.md`, `apps/api/CHANGELOG.md`, version 0.7.0 → 0.8.0 (`pyproject.toml`, `uv.lock` edited by hand on lock revision 3). No migration, nothing applied, no database or Azure service contacted. The web needs no change: its BFF route and client (web 1.2, 2.1) already parse these frames.
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: a lone surrogate in a streamed token (would have cut the stream with no `error` frame), the exact-cap edge (an answer of exactly 20,000 characters lost its usage), `error_kind` clamped to the bounded set, a disconnect check right before the assistant write, the graph run closed in a `finally`, OpenAPI no longer lists an extra `application/json` body, the deadline docstring, a real ASGI-disconnect test. Mutation-checked: storing after `done`, unsanitized citations, accepting a non-`sources` first frame and no cap each make a test fail.
  - 2026-10-06 — decisions taken here: the answer is stored by the generator just before it yields `done` (so `done` means "stored"); retrieval failure is a JSON `503` because `sources` is the first frame; a model failure after `sources` is an `error` frame; the 60 s is one wall-clock deadline for the whole stream; an answer past 20,000 characters is cut and ends with `done` but `output_tokens` is `null` (the model is stopped before it reports usage, so `token_count` is `NULL` for exactly those answers).
  - 2026-10-06 — NOT done here (re-run `/plan-roadmap api`): (a) streams are not bounded for slow or non-reading clients (the 60 s deadline covers the waits for the model, not writes to the client) and there is no concurrency cap — threat model A7/P2, to land before wider rollout; (b) a client that leaves while the answer is being written can still get it stored (checked just before the write, not during); (c) no `truncated` marker or usage estimate for a cut answer; (d) `docs/security/threat-models/shared-conversations.md` still lists the ask endpoints as "Planned" — a team-owned status line to update; (e) the `/ask/stream` log lines carry a `trace_id` only while the request context is alive, a GC-finalised generator would log without one — the explicit close paths avoid that.
  - 2026-10-06 — confirmed by the developer (done). The real-server checks (needs_human above) are still open.

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

- **status:** todo
- **depends_on:** [4.2]
- **layers:** [infra, docs]
- **acceptance:**
  - the deployed api can read the agreed corpus at `/app/corpus`; the image build and the CI build step produce it from `docs/` using the approach chosen in Q2
  - ADR-0013 is `Accepted` (or replaced) and `docker-compose.yml`, `apps/api/Dockerfile` and `apps/api/CLAUDE.md` match
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none to decide: Q2 is decided (copy `docs/` into `apps/api` before the build); a developer runs the first CI and image build
- **notes:**
  - 2026-10-06 — blocked: Q2 undecided. `docs/` is outside the api build context (`context: ./apps/api`, Dockerfile `COPY . /app`), so the draft's "bake into the image" cannot work as written. This is a Dockerfile/CI change, not Bicep.
  - 2026-10-06 — re-planned: unblocked on the decision side. Q2 was decided on 2026-10-06 (copy `docs/` into `apps/api` before the build). Still depends on 4.2 (the K1 allow-list and the loader it defines). Carry the Phase 5 note: allow-list build context, no symlinks, CI listing and secret scan.

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

### 5.2 — Request-size, rate and stream limits on the ask routes

- **status:** todo
- **depends_on:** [3.1]
- **layers:** [endpoint]
- **acceptance:**
  - a request body over a fixed size (a few times the 4,000-character question limit) is rejected with `413 payload_too_large` before it is buffered and parsed; the exact 4,000-character check stays in the handler
  - a per-client rate limit on `POST /v1/conversations`, `/ask` and `/ask/stream` returns `429 rate_limited` with the `{error, trace_id}` body; the limits are env-configurable with safe defaults and are off in tests unless set
  - the number of concurrent streams is capped (a request over the cap gets `429 rate_limited`), and a stream whose client stops reading is ended after a write-stall timeout, releasing the model run and the DB session
  - no new limit logs content; counts and outcomes only
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - decide the numbers (body size, requests per minute, concurrent streams) and whether the limit also belongs at the Container Apps ingress or the web BFF (threat model P2/P4; the infra roadmap would own an ingress setting)
- **notes:**
  - 2026-10-06 — planned by `/plan-roadmap api` from the open points left by api 1.2, 2.2 and 3.1 (threat model D2/D4/A7, risk R2 accepted until this ships). The 60 s stream deadline covers waits for the model, not writes to the client. A web counterpart (rate limit at the BFF, request timeouts) belongs in the web roadmap.
  - 2026-10-07 — decision (developer): per-client rate limiting belongs in the web BFF, which sees the real client address (the api is reached only by the BFF, so a per-IP limit there would see one client). When 5.2 is built it is split: the api gets a global concurrent-stream cap, the body-size cap and the write-stall timeout; the per-browser rate limit becomes a new item in the web roadmap.

### 5.3 — Cap the model output and record ask outcomes

- **status:** done
- **depends_on:** [3.1]
- **layers:** [ai]
- **acceptance:**
  - the chat model is built with an explicit output-token cap (`AI_MAX_OUTPUT_TOKENS`, documented in `.env.example` and `docs/reference/environment-variables.md`, with a default in line with the 20,000-character answer bound)
  - one bounded metric counts ask outcomes (`ok`, `ai_unavailable`, `timeout`, `client_disconnected`, `cut`) with `route_class` and no ids or content; both `/ask` and `/ask/stream` record it
  - an answer cut at the character bound still reports usage when the model has reported it
- **how_to_test:**
  - `just test` — api: **483 passed** (web: 500 passed, unchanged); the new cases are in `apps/api/tests/ai/test_ai_config_client.py` (`TestOutputCap`: default, invalid, non-positive and over-ceiling values, the cap reaching the model, a caller override), `tests/ai/test_ai_telemetry_prompts.py` (the outcome metric only takes values from fixed sets and never raises), `tests/test_ask_api.py` and `tests/test_ask_stream_api.py` (outcomes per route, one outcome per ask, usage kept after the cut, a stall or missing `done` after the cut, and a test that every outcome literal in the router is one the metric accepts)
  - `just openapi` then `git status` — no change (no request or response shape changed)
  - `uv run --directory apps/api python -c "from app.ai.config import get_ai_settings; print(get_ai_settings().max_output_tokens)"` → `6000`; with `AI_MAX_OUTPUT_TOKENS=1500` in the environment → `1500`; with `99999999` → `16000`
  - with the dev setup from 2.2/3.1: ask a question and, in Application Insights, query the custom metric `team-assistant.ai.ask.outcomes` — one row per ask with `route_class` `ask` or `ask_stream` and `outcome` `ok`; ask with `AZURE_AI_ENDPOINT` unset → `ai_unavailable`; close curl mid-stream → `client_disconnected`
  - logs: no question, answer, title or path in any line; after a cut answer, a failed usage read logs `ask stream usage unavailable` with a bounded `error_kind` only
- **needs_human:**
  - choose the cap with the model owner (a low cap truncates real answers; 6000 tokens is about 20,000 English characters and fewer characters for dense text such as Arabic). A model that stops at the cap is counted `ok`, not `cut`, and its answer is just shorter: `cut` means only that the 20,000-character bound was hit
  - confirm what the Foundry deployment reports as usage (`input_tokens` / `output_tokens`), and whether a reasoning model counts hidden reasoning tokens against the cap
  - the cost trade-off of reading the model to its end after a cut: up to the cap in tokens and 10 s more, in exchange for an accurate `token_count`
  - the shared-conversations threat model (A7, team-owned) still lists the per-ask token bound as "question cap + history + top_k"; add the output cap there when the team next edits it
- **notes:**
  - 2026-10-06 — planned from api 2.2 and 3.1: the answer is only cut after it is generated, and an answer stopped at the cap loses `output_tokens` (so `token_count` is `NULL` for exactly the most expensive answers). Cardinality rules: `.claude/rules/60-observability.md`.
  - 2026-10-07 — started by Claude.
  - 2026-10-07 — implemented; awaiting test by the developer. Files: `apps/api/app/ai/config.py` (`AI_MAX_OUTPUT_TOKENS`, default 6000, ceiling 16000), `apps/api/app/ai/client.py` (`max_tokens`, verified in langchain-openai 1.6.6 to be sent as `max_completion_tokens`), `apps/api/app/ai/telemetry.py` (`record_ask_outcome`, `ASK_OUTCOMES`, `ASK_ROUTE_CLASSES`), `apps/api/app/routers/ask.py` (outcomes in both routes; a streamed answer cut at the character bound is now read to its end for the usage, for at most 10 s), tests, both `.env.example`s, `docker-compose.yml`, `docs/reference/environment-variables.md`, `docs/reference/http-api.md`, `docs/architecture/ai.md`, `.claude/rules/70-ai.md`, `apps/api/CHANGELOG.md`, version 0.8.1 → 0.9.0 (`pyproject.toml`, `uv.lock` by hand on lock revision 3). No migration, no Bicep change (the setting has a default in code), nothing applied, no Azure service contacted.
  - 2026-10-07 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: a late disconnect counted a second outcome (now one outcome per ask), a stalled usage read after the cut could hold the stream for the full deadline (now 10 s), failures after the cut leave a bounded log line, a ceiling on the cap, the cap's comment (it is per call, so a retry can spend it again), a failed answer write in `/ask` is counted as `error`, and tests for a stall or missing `done` after the cut, the late disconnect, and the outcome literals.
  - 2026-10-07 — NOT done here: (a) no SSE heartbeat while the usage is read after a cut (the client sees nothing for up to 10 s before `done`); (b) a model that stops at the token cap (`finish_reason: length`) is not distinguished from a normal end; (c) `docs/security/threat-models/shared-conversations.md` A7 not updated (team-owned).
  - 2026-10-07 — confirmed by the developer (done). Choosing the cap with the model owner and the real-usage checks (needs_human above) are still open.

### 5.4 — Say which retrieved chunks each citation covers

- **status:** todo
- **depends_on:** [3.1]
- **layers:** [ai, endpoint]
- **acceptance:**
  - each citation carries `chunks: [n, …]`, the numbers of the retrieved chunks (the `[n]` markers in the answer) that came from that document, in `sources`, `done` and the JSON answer
  - the value is validated before it is stored (integers within the retrieved count) and read back by `GET /v1/conversations/{id}` without breaking stored rows that lack it
  - OpenAPI and the web's `api-types.ts` are regenerated; the old shape stays readable
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the web UI needs a follow-up item to show the numbers against the Sources block (web roadmap; web 2.1 left it unnumbered on purpose)
- **notes:**
  - 2026-10-06 — planned from the web 2.1 notes: the inline `[n]` markers index retrieved chunks, but citations are unique documents, so the numbers cannot be shown against the Sources block. A backward-compatible addition: MINOR bump.

### 5.5 — Decide where retrieved text goes in the prompt

- **status:** todo
- **depends_on:** [2.2]
- **layers:** [ai, docs]
- **acceptance:**
  - ADR-0009 is amended (or a new ADR written) with an explicit decision: retrieved text stays in the `{context}` slot of the system prompt with the "context is data" rule, or moves to a human/tool-role message
  - if it moves, `graph.py`, `prompts/system.md`, the eval cases and `docs/architecture/ai.md` are updated and `.claude/rules/70-ai.md` matches; if it stays, rule 70 states the accepted exception
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team decides; the security review of api 2.2 flagged that rule 70 and the review checklist say retrieved text must never reach the model as a system message, while the template graph does exactly that
- **notes:**
  - 2026-10-06 — planned from the api 2.2 security review (finding on `app/ai/graph.py`). Propose the ADR with the `write-adr` skill; do not change the graph before the decision.

### 5.6 — Page the conversation list

- **status:** todo
- **depends_on:** [1.2]
- **layers:** [endpoint]
- **acceptance:**
  - `GET /v1/conversations` accepts an opaque `cursor` (built from `updated_at` and `id`) and returns `next_cursor` (or `null`); the first page and `limit` behave as today
  - a malformed or tampered cursor returns `422 validation_error`; ordering stays stable while conversations are added or updated between pages
  - OpenAPI and `api-types.ts` regenerated; existing clients that ignore `next_cursor` keep working
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the web needs a follow-up item to load more than the newest 50 chats (web roadmap)
- **notes:**
  - 2026-10-06 — planned from the api 1.2 notes (a flood of conversations can push real ones off the list; threat model P2). Pair with 5.2.

### 5.7 — Operator purge runbook for stored conversations

- **status:** todo
- **depends_on:** []
- **layers:** [docs]
- **acceptance:**
  - `docs/operations/runbooks/` has a runbook (via the `runbook-writer` skill) for removing a conversation or message from Azure SQL by an operator: who may do it, the exact SQL with bound values, how to record what was removed and who asked (counts, never content), and the follow-up for a pasted credential (rotate it; deleting a row does not undo the exposure)
  - the runbook states the retention decision and backup retention once they are known
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team names who owns erasure requests, picks a retention period (or "forever") and learns the platform's real backup retention (threat model R3, P3, Q1/Q4)
- **notes:**
  - 2026-10-06 — planned from the shared-conversations threat model (P3). Documentation only; there is deliberately no delete endpoint (ADR-0014).

### 5.8 — Optional: warn on secrets in questions

- **status:** todo
- **depends_on:** [2.2]
- **layers:** [endpoint]
- **acceptance:**
  - when a question matches a small set of secret patterns (`AKIA…`, `sk-…`, `ghp_…`, `eyJ…` tokens, private-key headers), the api rejects it with a distinct `422` code (or accepts it with a warning field, as decided) before anything is stored or sent to the model
  - the matched text is never logged or echoed; only the pattern class is counted
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team decides whether to build this at all (threat model P5 is optional) and whether to reject or warn; false positives on pasted code are likely
- **notes:**
  - 2026-10-06 — planned from the shared-conversations threat model (P5, I3/A6). Leave `todo` until the decision; do not start without it.
