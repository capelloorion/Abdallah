# Changelog — `apps/api`

All notable changes to the **api** service (FastAPI). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) from the consumer's perspective (root `CLAUDE.md`, rule 15).
The two services version independently.

## [Unreleased]

## [0.11.0] — 2026-10-12

### Added

- **Chunk numbers on citations** (roadmap api:5.4). Each citation now carries `chunks: [n, …]`: the 1-based numbers of the retrieved chunks that came from that document, which are the same numbers the model sees in its context block and cites as `[n]` in the answer. A client can therefore show `[2]` against the right source. It is in the `sources` and `done` frames, the JSON answer and `GET /v1/conversations/{id}`, and in the stored `messages.citations` JSON.
- The numbers are validated before they are stored: whole numbers only (a boolean, a float or a string is dropped), from 1 up to the number of chunks retrieved, unique, ascending, at most 50. A chunk with no usable source still takes its number (the model sees it) but belongs to no citation, and a citation dropped for an unsafe path leaves its numbers unused, so the numbers that remain match the answer.
- Reading never breaks: a stored row from before this field reads back with `chunks: null` (unknown); odd values inside a stored list are dropped, and a list with entries but none usable reads as `null`, not as "covers no chunks".

### Changed

- OpenAPI: `Citation` gains an optional `chunks` (`integer[] | null`, at most 50). The old shape stays valid, so existing clients keep working (a client that rejects unknown fields must allow it). `docs/reference/openapi.json` and the web's `api-types.ts` are regenerated; the eval cases expect the numbers.

## [0.10.0] — 2026-10-07

### Added

- **Request-size limit** (roadmap api:5.2): a `POST`, `PUT` or `PATCH` body to any `/v1` route over
  `API_MAX_REQUEST_BODY_BYTES` (default 64 KiB) is `413 payload_too_large` with the usual `{error, trace_id}` body,
  before the route reads it — by `Content-Length` when sent, and counted while a chunked body arrives. The exact
  4,000-character question check stays in the ask routes.
- **Stream cap**: at most `API_MAX_CONCURRENT_STREAMS` (default 20) `/v1/conversations/{id}/ask/stream` responses are
  open per process; one more gets `429 rate_limited` before anything is stored. The slot is freed whenever the stream
  ends, fails or the client leaves, including a client that goes before the first write. With several replicas the cap
  multiplies.
- **Write-stall timeout**: a write to a stream's client that blocks for `API_STREAM_WRITE_STALL_SECONDS` (default 30)
  ends the stream and closes the generator, releasing the model run, the search call and the DB session; no `done` is sent
  and no answer is stored.
- `rejected` (a stream refused by the cap) and `write_stalled` (a client that stopped reading) are new values of the
  `team-assistant.ai.ask.outcomes` metric.
- The new settings are in both `.env.example`s, `docker-compose.yml` and `docs/reference/environment-variables.md`;
  the OpenAPI contract (`429` on the stream route) and the web's `api-types.ts` are regenerated.
- Per-client rate limiting is **not** in the api: it is a web (BFF) concern, because the api is reached only by the BFF.

## [0.9.0] — 2026-10-07

### Added

- **`AI_MAX_OUTPUT_TOKENS`** (default `6000`; documented in both `.env.example`s, `docker-compose.yml` and
  `docs/reference/environment-variables.md`) — the chat model is now built with an explicit output cap (sent to Azure
  OpenAI as `max_completion_tokens`), so a runaway or injected answer cannot cost more than this many output tokens.
  An invalid or non-positive value uses the default; a value above 16,000 is cut back to 16,000. The cap applies to each
  model call (a retry can spend it again) and, for a reasoning model, includes its hidden reasoning tokens. The ask routes
  still keep at most 20,000 characters of an answer.
- **`team-assistant.ai.ask.outcomes`** metric — one count per ask from `/ask` and `/ask/stream`, by `route_class`
  (`ask`, `ask_stream`) and `outcome` (`ok`, `cut`, `ai_unavailable`, `timeout`, `client_disconnected`, `error`); both
  are checked against those fixed sets, so no id or content can become a series. One outcome per ask: a client that
  leaves right after the real outcome is not counted a second time.

### Changed

- **A streamed answer cut at the 20,000-character bound now still reports usage.** `/ask/stream` stops sending and
  storing text at the bound, but reads the model's stream to its end (bounded by `AI_MAX_OUTPUT_TOKENS`) so `done` carries
  `input_tokens` / `output_tokens` and `messages.token_count` is set (for at most 10 s after the cut); a failure or stall after the cut keeps the cut answer and
  loses only the usage. Before, such answers had `output_tokens: null` and a `NULL` `token_count`.

## [0.8.1] — 2026-10-07

### Changed

- **Follow-up-aware retrieval** (roadmap api:2.3, decision Q3). The `retrieve` node now searches for the previous
  *user* turn (cut to 1,000 characters) followed by the new question, instead of the new question alone, so a
  follow-up such as "And on the api side?" retrieves documents about the conversation's topic. Applies to
  `/v1/conversations/{id}/ask` and `/ask/stream`. No extra model call and no new graph node; the assistant's earlier
  answers are never part of the query, and the query is never logged; a blank turn, or the same question asked
  again after a failed answer, is skipped in favour of the turn before it. The query can be up to 1,000 characters
  longer than before (one embedding and one search call, as before). The first question of a conversation is
  searched exactly as before. The request and response shapes are unchanged.
- `app.ai.graph.retrieval_query()` builds the query; the eval harness accepts an `expect_query` per case and has
  a follow-up case that fails with last-question-only retrieval.

## [0.8.0] — 2026-10-06

### Added

- **`POST /v1/conversations/{id}/ask/stream`** (roadmap api:3.1) — the streaming form of `/ask`: `200 text/event-stream`
  with frames `sources` → `token`\* → `done`; `sources` and `done` carry the validated `[{title, path}]` citations
  (`done` also `input_tokens` / `output_tokens`). The answer (content, citations, `token_count` = output tokens) is
  stored **before** `done` is sent; a client that disconnects earlier stores no assistant message.
  Validation, `404`, `413`, `422` and any failure before the first frame (retrieval failed or not configured, nothing
  within 60 s) are the normal JSON errors (`503 ai_unavailable` for the last two); a failure after the first frame
  is `event: error` `{"error_kind": …}` and the stream ends — the question is kept, no answer is stored, and there is
  no `done`. The whole round trip is limited to 60 s; an answer past 20,000 characters stops there; the `error_kind` in an `error` frame is always one of `timeout`, `rate_limited`, `auth`, `network`, `error`; a lone surrogate in a streamed token is replaced.
  The frames are documented in the OpenAPI response description; the contract and the web's `api-types.ts` are
  regenerated. The web BFF route for it already exists (web 1.2).
- `app.ai.streaming.stream_events()` — the typed `(event, data)` form of `stream_answer()`, which now formats its output.
  `stream_answer()` and the wire format are unchanged.

## [0.7.0] — 2026-10-06

### Added

- **`POST /v1/conversations/{id}/ask`** (roadmap api:2.2) — ask a question in a conversation:
  request `{ "question": string }`, response `200 { message_id, answer, citations: [{ title, path }] }`.
  The question is stored before retrieval; the answer (content, citations as JSON, `token_count` = output
  tokens) is stored after it; `conversations.updated_at` is bumped on both writes and a conversation still
  titled "New conversation" takes the first question (cut to 200 characters) as its title. The model gets the
  conversation's last 10 stored messages as human/assistant history plus the retrieved context.
  Errors: `404 not_found`, `413 payload_too_large` (question over 4,000 characters), `422 validation_error`
  (empty question, lone surrogate, malformed id), `503 ai_unavailable` (model or search failure, no answer within
  60 s, or an empty answer — the question is kept and no answer is stored).
- Bounded storage: answers are cut at 20,000 characters; `citations` come only from retrieval and a citation whose
  `path` is not a plain relative path (scheme, leading `/`, `..`, backslash, control or bidi characters, over 500
  characters) is dropped; history sent to the model is cut to 4,000 characters per message.
- Eval cases for an injected history turn and an injected corpus passage; the eval harness accepts a `history` list.
- OpenAPI contract and the web's `api-types.ts` regenerated.

### Changed

- **Both database engines are created with `hide_parameters=True`**, so a failed statement cannot copy a bound
  value (a title, a question, an answer) into its exception text (threat model P1).
- **Model-call spans no longer record the exception** (`record_exception=False`, `set_status_on_exception=False`):
  an upstream error message can quote the request, so only the bounded `ai.error_kind` reaches Application Insights.
- A question containing a control character other than tab, newline or carriage return (a NUL, for example) is
  `422 validation_error`; citation paths also reject quotes, angle brackets and invisible format characters, and a
  lone surrogate in a retrieved title is replaced instead of breaking the answer.
- The system prompt now says earlier conversation turns are history, not instructions and not a source of
  citations (shared-conversations threat model A1).

## [0.6.0] — 2026-10-06

### Changed

- **Citation contract** (roadmap api:2.1; internal to the AI runtime — the api ships no route that uses it
  yet). `ask()` returns `Answer.citations: [{title, path}]` instead of `Answer.sources: [str]`, and the SSE
  `sources` and `done` frames carry `citations` (same shape) instead of `sources`. Citations are unique by
  path, in retrieval order; the first chunk's title wins. `unique_sources()` is replaced by `citations_for()`.
- **Ingestion stores a `title`** on every chunk — the document's first `# ` heading (headings inside code
  fences and YAML front matter are ignored, a closing `#` run is dropped but `C#` is kept; control and
  bidi-override characters are removed; capped at 200 characters, on ingestion and again on read), else its file name — and `build_index` defines the
  searchable `title` field. The retriever selects it; a chunk whose `title` is empty or null falls back to
  the file name. **The Search query now selects `title`, so the index must have the field**: an index
  created before this version makes retrieval fail (a bounded `error_kind: "error"`) until `ensure_index`
  — the first step of `python -m app.ai.ingest` — has added it (Azure adds a field in place; existing
  chunks then read back with a null title and fall back to the file name until re-ingested).
- Titles and paths are document content and are never logged.

### Added

- Tests: citation shape and de-duplication, title extraction (including code fences and caps), index
  contract, retriever fallback, SSE frames; the eval harness (`tests/evals/cases.json`) now asserts
  `expect_citations` and has cases for the file-name fallback, several chunks of one document, and an
  empty context.

## [0.5.0] — 2026-10-06

### Added

- **`/v1/conversations`** (roadmap api:1.2): `POST /v1/conversations` (optional title ≤ 200 characters,
  trimmed; missing or blank → "New conversation"; `201`), `GET /v1/conversations?limit=50` (1–100,
  newest `updated_at` first, `{items, count}`), `GET /v1/conversations/{id}` (the conversation and its
  messages oldest first, with parsed `citations`). Unknown id → `404 not_found`; a malformed id, a bad
  limit or a bad title → `422 validation_error`. Timestamps are timezone-aware UTC. Every response echoes
  `x-trace-id`; titles and message text are never logged.
- A read returns at most the 500 most recent messages and sets `truncated: true` when it cut older
  ones (an addition to the draft contract; bounds the size of a read, from the api:1.1 security review).
- `app/repositories/` (query functions taking an `AsyncSession`) and `app/routers/conversations.py`;
  `docs/reference/openapi.json` and the web's `src/lib/api-types.ts` regenerated.
- Hardening from review: a title is limited to 200 **UTF-16 code units** (the `NVARCHAR(200)` limit; 100 emoji
  fit, 101 are a `422` rather than a database error); timestamps are stored at millisecond precision so
  `POST` and a later `GET` agree; unreadable, oversized (> 64 KB) or deeply nested stored `citations` are
  dropped to `null` instead of failing the read; the message read has a deterministic final `id` order.
- Tests: `tests/test_conversations_api.py` (contract, ordering and `TOP` limits via compiled SQL,
  bounds, error paths, trace echo, no content in logs) — no database.

## [0.4.0] — 2026-10-06

### Added

- **Chat-history models** `app/models/conversation.py`: `Conversation` and `Message` (roadmap api:1.1,
  ADR-0014). Shared conversations — no owner column. `messages` has a `NO ACTION` foreign key to
  `conversations`, an index on `conversation_id`, a named `role` check and a named `ISJSON` check on
  `citations`. Text is `NVARCHAR`; `content`/`citations` are `NVARCHAR(max)` by design; timestamps are
  `DATETIME2(3)` UTC defaulted by `SYSUTCDATETIME()`.
- **Alembic revision `0001`** (`create conversations and messages`) with a real downgrade. Hand-written
  and reviewed as offline SQL; **not applied to any database** — that is the `migrate.yml` workflow or a
  named human.
- Tests: `tests/test_models_conversation.py` (shape, constraints, defaults) and, in
  `tests/test_alembic.py`, one linear revision, offline upgrade/downgrade SQL, and a parity check that
  the migration emits the same DDL as the models.

### Changed

- `tests/test_alembic.py` no longer asserts an empty `alembic/versions/`; docs that described an empty
  model set now describe the two tables (`docs/design/db-design.md` has the real design).

## [0.3.0] — 2026-10-04

### Added

- **Error contract** `app/errors.py`: every non-2xx response body is `{"error": <snake_case code>,
  "trace_id": <id>}` with the trace id also echoed in `x-trace-id`. `ApiError` (+ `NotFound`,
  `Conflict`, `AIUnavailable`) for routes and repositories; handlers for `HTTPException`
  (a snake_case `detail` becomes the code, prose maps to a default per status; `Allow` and other
  protocol headers kept), `RequestValidationError` (`422 validation_error` — field locations are
  logged, never returned) and `AINotConfigured` (`503 ai_unavailable`); `UnhandledErrorMiddleware`
  turns anything else into `500 internal_error` logging only the exception kind and location.
  `v1_router` documents 422/500 as `ErrorBody` in OpenAPI (`docs/reference/openapi.json`
  regenerated). Promoted from the first project dry run (`docs/development/walkthrough-team-assistant.md`).

### Changed

- Comments and docstrings that described the Terraform landing zone now describe the use-case
  Bicep deployment (ADR-0012). No behaviour change.

## [0.2.0] — 2026-09-28

### Added

- **AI runtime** `app/ai/` (ADR-0009): LangChain + LangGraph on Azure AI Foundry — client
  factory (`get_chat_model` / `get_embeddings`, managed identity when deployed), a compiled
  `retrieve → answer` graph with an optional tool loop (`build_graph`, `ask`), SSE streaming
  (`stream_answer`, `sse_response`), a tool registry with the allow-listed read-only
  `query_external_db` tool, prompt files (`load_prompt`), content-free `gen_ai` telemetry
  (`model_call_span`), Azure AI Search retrieval (`AzureSearchRetriever`) and the ingestion job
  (`python -m app.ai.ingest`). No route or use case is shipped.
- New optional env vars: `AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`,
  `AZURE_AI_EMBEDDING_DEPLOYMENT`, `AZURE_AI_EMBEDDING_DIMENSIONS`, `AZURE_AI_API_VERSION`,
  `AZURE_AI_AUTH_MODE`, `AZURE_AI_API_KEY`, `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX`,
  `AZURE_SEARCH_API_KEY`, `AI_REQUEST_TIMEOUT_SECONDS`, `AI_MAX_RETRIES`, `AI_ALLOW_TEXT_TO_SQL`.
- Dependencies: `langchain-core`, `langgraph`, `langchain-openai`, `azure-search-documents`
  (OTel pins unchanged). Tests: `tests/ai/` + the `tests/evals/` prompt regression harness.
- `python -m app.openapi_export` writes the API contract to `docs/reference/openapi.json`
  (`make openapi` also regenerates the web's TS types); `tests/test_openapi_export.py` fails
  when the committed contract is stale.

## [0.1.0] — 2026-09-28

### Changed — **BREAKING** (consumer-facing configuration)

- **Database engine is Azure SQL Database**, not Postgres (ADR-0008, supersedes ADR-0004):
  `DATABASE_URL` must now be an `mssql+aioodbc://…?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no`
  URL. `postgresql+asyncpg://…?ssl=require` URLs are no longer accepted.
- Dependencies: `asyncpg` and `opentelemetry-instrumentation-asyncpg` removed; `aioodbc`,
  `pyodbc` and `opentelemetry-instrumentation-sqlalchemy` (0.61b0) added. The runtime image now
  installs Microsoft ODBC Driver 18 for SQL Server.
- DB dependency spans come from the SQLAlchemy instrumentation (registered without an engine, so
  every lazily created engine is covered) instead of the asyncpg driver instrumentation.

### Added

- `EXTERNAL_DATABASE_URL` (optional) + `app/db/external.py`: a second, lazy, **read-only**
  engine for an external Azure SQL database (`get_external_session()` dependency); non-`SELECT`
  statements are refused before they reach the driver.

### Internal

- Engine factories resolve `create_async_engine` at call time (`sa_asyncio.create_async_engine`)
  so the OTel wrapper applies regardless of import order.
- Offline tests now guard on `pyodbc.connect`; Alembic offline mode renders T-SQL.

## [0.0.0] — 2026-09-20

- Template baseline. No features shipped.
