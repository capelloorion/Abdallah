# HTTP API reference

The complete HTTP surface of both services as they exist today: the operational foundation
(`/ping`, `/info`, `/health`), the first business endpoints (`/v1/conversations` on the api, mirrored by
`/api/v1/conversations` on the BFF) and the two demo BFF routes in `apps/web` that exercise the
`web → api` hop. Derived from the route
source, cross-checked against the test suites (`routes.test.ts`, `test_routes.py`).

`apps/api` (FastAPI) is the **only backend**; it took the `api` name in
[ADR-0005](../adr/0005-name-services-by-role.md). The former **NestJS** `apps/api` service — a
different service (origin `0a71`, retired) — and with it `/ping/chain`, `/info/chain`, and the
BFF routes `/api/ping-python`, `/api/info-python`, `/api/ping-chain`, `/api/info-chain` — was
removed in [ADR-0003](../adr/0003-remove-nestjs-api-layer.md).

## Route map

| Method   | Path                         | Service          | Purpose                                             | Versioned?       |
| -------- | ---------------------------- | ---------------- | --------------------------------------------------- | ---------------- |
| GET      | `/ping`                      | `apps/api`       | Liveness greeting                                   | No (operational) |
| GET      | `/info`                      | `apps/api`       | Status/version/runtime report                       | No (operational) |
| GET      | `/health`                    | `apps/api`       | Health + observability state                        | No (operational) |
| POST/GET | `/v1/conversations[/{id}]`   | `apps/api`       | Chat history: create, list, read (see below)        | Yes (`/v1`)      |
| POST     | `/v1/conversations/{id}/ask` | `apps/api`       | Ask a question in a conversation (JSON answer)      | Yes (`/v1`)      |
| GET      | `/api/ping-backend`          | `apps/web` (BFF) | Proxies `apps/api` `/ping`                          | No (demo route)  |
| GET      | `/api/info-backend`          | `apps/web` (BFF) | Proxies `apps/api` `/info`                          | No (demo route)  |
| GET      | `/health`                    | `apps/web` (BFF) | Own health + observability state (no upstream call) | No (operational) |

Business endpoints, when they arrive, are `/v1/<feature>` on the api (routers attached to
`v1_router`) and `/api/v1/<feature>` on web (folder-enforced). See [Versioning](#versioning).

---

## `apps/api` — FastAPI (port 8000, origin `0c70`)

Source: `apps/api/app/routes.py` (operational router, mounted at root by `app/main.py`).
`app/routers/v1.py` defines `v1_router` (`prefix="/v1"`) and attaches the feature routers
(`conversations` today) — see [`/v1/conversations`](#v1conversations--chat-history-shared-no-auth).

### `GET /ping`

```json
{
  "service": "api",
  "message": "hello from the Team Assistant api service",
  "trace_id": "0c70…"
}
```

- `service` — fixed string `"api"`.
- `message` — fixed greeting string.
- `trace_id` — the request-scoped trace id (adopted from a valid inbound `x-trace-id`, or
  generated with origin `0c70`). When called through the BFF it is the **web-minted** `0eb0…`
  id, because the api validates only the 32-hex **format**, not the origin prefix
  (`apps/api/app/tracing.py`).

No upstream call — the api is the end of the hop.

### `GET /info`

```json
{
  "status": "ok",
  "service": "api",
  "version": "0.0.0",
  "env": "local",
  "uptime_seconds": 12.345,
  "runtime": { "name": "python", "version": "3.14.0" },
  "system": {
    "platform": "Linux",
    "arch": "x86_64",
    "pid": 1,
    "hostname": "api-abc123"
  },
  "observability": "disabled",
  "reason": "no Azure connection string",
  "trace_id": "0c70…"
}
```

Field notes (`apps/api/app/routes.py`):

- `version` — `importlib.metadata.version("team-assistant-api")` (the dist name from
  `pyproject.toml`); falls back to `"unknown"` if the package metadata isn't installed.
- `env` — `APP_ENV` lowercased, default `"local"`.
- `uptime_seconds` — `time.monotonic() - _STARTED` (captured at module import), rounded to 3
  decimals.
- `runtime` — `{ "name": "python", "version": platform.python_version() }` — the **interpreter** name, not the service (which is `"api"`); unchanged by the rename (ADR-0005).
- `system` — `{ platform: platform.system(), arch: platform.machine(), pid: os.getpid(), hostname: socket.gethostname() }`
  (`platform.system()` returns `"Linux"`/`"Windows"`/`"Darwin"`, capitalized).
- `observability` / `reason` — see the reason-string table in
  [Observability state reasons](#observability-state-reasons) below.

### `GET /health`

```json
{
  "status": "ok",
  "service": "api",
  "trace_id": "0c70…",
  "observability": "disabled",
  "reason": "no Azure connection string"
}
```

`status` is unconditionally `"ok"` — this endpoint reports process liveness + observability
state, not database health. **The database is never queried here**: the SQLAlchemy engine is
lazy and the baseline issues no queries, so `/health` is green with the placeholder
`DATABASE_URL`.

### `/v1/conversations` — chat history (shared, no auth)

Conversations are **shared**: there is no owner, so every caller sees every conversation
([ADR-0014](../adr/0014-shared-conversations-until-auth.md), Proposed). Titles and message text
are user content and are never logged. Source: `apps/api/app/routers/conversations.py`.

| Method | Path                     | Request                                      | Success                                                                                                            | Errors                                                            |
| ------ | ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| POST   | `/v1/conversations`      | optional `{ "title": string }` (≤ 200 chars) | `201` `{ id, title, created_at, updated_at }`; a missing or blank title becomes `New conversation`                 | `422 validation_error` (title too long or not a string)           |
| GET    | `/v1/conversations`      | `?limit=50` (1–100)                          | `200` `{ items: [{ id, title, updated_at }], count }`, newest `updated_at` first                                   | `422 validation_error` (limit out of range)                       |
| GET    | `/v1/conversations/{id}` | —                                            | `200` `{ id, title, created_at, updated_at, messages: [{ id, role, content, citations, created_at }], truncated }` | `404 not_found` (unknown id), `422 validation_error` (not a UUID) |

- Timestamps are ISO 8601 in UTC. `messages` are oldest first; `citations` is `[{ title, path }]` or `null`.
- A read returns at most the **500 most recent** messages; `truncated` is `true` when older ones were
  left out (there is no way yet to fetch them — paging is a later item). (This field is an addition to the draft contract in `docs/architecture.md` B4a.)
- Every response echoes `x-trace-id`; errors use the `{ error, trace_id }` contract below.

#### `POST /v1/conversations/{id}/ask` — ask a question (api:2.2)

Source: `apps/api/app/routers/ask.py`. Request `{ "question": string }`; success
`200 { message_id, answer, citations: [{ title, path }] }`. The web BFF does not mirror this JSON route
(the chat page uses the stream route, api 3.1).

| Status | Code                | When                                                                                                                                |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `404`  | `not_found`         | unknown conversation id                                                                                                             |
| `413`  | `payload_too_large` | question over **4000 characters** (code points, after trimming)                                                                     |
| `422`  | `validation_error`  | empty or whitespace-only question, not a string, a lone surrogate or control character (tab, newline and CR are fine), malformed id |
| `503`  | `ai_unavailable`    | model or search failed or is not configured, no answer within **60 s**, or the model returned nothing                               |

- **Order of work:** the question is stored first (`messages` row, `conversations.updated_at` bumped; a
  conversation still titled `New conversation` takes the question — control/bidi characters removed,
  whitespace collapsed, at most 200 characters — as its title), then retrieval and the model run, then the answer is
  stored (`content`, `citations` as JSON, `token_count` = **output tokens**, `NULL` if the model reports none;
  `updated_at` bumped again). On a `503` the question stays and **no** assistant message is stored.
- **History:** the model receives the conversation's last **10** stored messages (each cut to 4000 characters) as
  human/assistant messages only, plus the retrieved context and the question. Conversations are shared, so that
  history can hold other users' turns (ADR-0014).
- **Bounded output:** the answer is trimmed and cut at 20,000 characters (the stored and returned text are identical).
  `citations` come only from retrieval (unique by path, at most 20); a citation whose `path` is not a plain relative
  path (a scheme, a leading `/`, a `..` segment, a backslash, quotes or angle brackets, control, bidi or zero-width characters, over 500 characters) is dropped.
  A conversation with no sources returns `citations: []` and stores `NULL`.
- No question, answer, title or path is ever logged.

---

## `apps/web` — Next.js BFF demo routes (port 3000, origin `0eb0`)

Source: `apps/web/src/app/api/{ping,info}-backend/route.ts`. Every handler is wrapped in
`withBff` (`src/lib/trace.ts`), which resolves/adopts `x-trace-id`, runs the handler inside the
trace-id async-local scope, and **unconditionally echoes `x-trace-id`** on whatever `Response`
the handler returns (success or error). Upstream calls use `fetchUpstream` (never bare `fetch`).

| Route                   | Upstream call             | Base URL env var (default)               |
| ----------------------- | ------------------------- | ---------------------------------------- |
| `GET /api/ping-backend` | `GET {API_BASE_URL}/ping` | `API_BASE_URL` (`http://localhost:8000`) |
| `GET /api/info-backend` | `GET {API_BASE_URL}/info` | `API_BASE_URL` (`http://localhost:8000`) |

In `docker-compose.yml` the base URL is overridden to `http://api:8000` (compose DNS).

### Success response shape

On success, each route returns the **upstream JSON body verbatim** (`Response.json(data, {
status: res.status })`) — the BFF does not add its own envelope. So:

- `/api/ping-backend` → the api's `/ping` shape (see above).
- `/api/info-backend` → the api's `/info` shape.
- The upstream's own `trace_id` field matches the response's `x-trace-id` header, because the
  BFF forwards its resolved trace id to the api, which adopts it (valid 32-hex format,
  origin-agnostic). This single hop is the `x-trace-id` propagation the contract exists to
  demonstrate: one `0eb0…` id on the browser response, on the api's body, and on every log line
  and span in between.
- HTTP status is **mirrored from upstream** — e.g. an upstream 404/500 with a valid JSON body is
  passed through with that same status, not converted to a BFF error.

### `GET /health` (web's own, no upstream call)

```json
{
  "status": "ok",
  "service": "web",
  "trace_id": "0eb0…",
  "observability": "disabled",
  "reason": "no Azure connection string"
}
```

Unlike the two demo routes, this one never calls upstream — it reports `apps/web`'s own process
liveness + observability state (`apps/web/src/app/health/route.ts`).

---

### BFF: `/api/v1/conversations` (chat history)

Source: `apps/web/src/app/api/v1/conversations/` (`route.ts`, `[id]/route.ts`, `[id]/ask/stream/route.ts`);
shared helpers `src/lib/bff-json.ts` and `src/lib/conversation-limits.ts`. Each handler is wrapped in
`withBff`; upstream calls go through `fetchUpstream` (JSON) or `streamUpstream` (the SSE route) — never a bare
`fetch`. A JSON route passes the api's status and body through; the stream route relays the api's events.

| Method | BFF route                               | Upstream                                       | What the BFF checks first                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/conversations`                 | `GET /v1/conversations`                        | `limit`, if present, is an integer 1–100 (else `422 validation_error`); only the validated `limit` is forwarded                                                                                                                                                                                                                            |
| POST   | `/api/v1/conversations`                 | `POST /v1/conversations`                       | `content-type: application/json` (else `415 unsupported_media_type`); body ≤ 4 KB (else `413 payload_too_large`) and received within 5 s (else `408 request_timeout`); a JSON object with an optional well-formed string `title` ≤ 200 UTF-16 units; only a trimmed `title` is forwarded                                                   |
| GET    | `/api/v1/conversations/{id}`            | `GET /v1/conversations/{id}`                   | `id` is a UUID (else `422 validation_error`)                                                                                                                                                                                                                                                                                               |
| POST   | `/api/v1/conversations/{id}/ask/stream` | `POST /v1/conversations/{id}/ask/stream` (SSE) | `id` is a UUID (`422`); `content-type: application/json` (`415`); body ≤ 64 KB within 5 s (`413`, `408`); `{ "question": string }` — trimmed, non-empty, well-formed (else `400 bad_request`) and at most 4000 **characters** (code points, as the api counts; else `413 payload_too_large`, pending api Q5); only `question` is forwarded |

- An unreachable api, a timeout (while connecting or while reading the reply) or a redirect →
  `502 { error: "upstream_unreachable", target: "api", trace_id }`; an api reply that is not JSON (a proxy
  page, an empty `204`) → `502 { error: "upstream_error", target: "api", trace_id }`. Neither relays the
  upstream body, and no upstream header (cookies, `server`) is relayed either.
- **Stream route.** It relays the api's Server-Sent Events unchanged: `sources`
  (`{ citations: [{ title, path }], count }`), `token` (`{ text }`)…, then `done`
  (`{ citations, input_tokens, output_tokens }`) or a terminal `error` (`{ error_kind }`).
  - An api error _before_ the stream starts (`404`, `422`, `413`, `503 ai_unavailable`…) keeps its status;
    only its `error` and `trace_id` are relayed (an api reply of any other shape → `502 upstream_error`).
  - An unreachable api, a timeout or a redirect → `502` whose body is a single `error` frame
    (`error_kind`: `upstream_unreachable` or `timeout`). Only a `200` whose media type is exactly
    `text/event-stream` is streamed; anything else → `502 { error: "upstream_error" }`.
  - If the browser disconnects, the upstream request is aborted so the model call can stop. A stream that
    dies _after_ headers were sent just ends — a client must treat "ended without `done` or `error`" as a
    failure.
- JSON responses carry `cache-control: no-store`; a stream keeps `no-cache, no-transform`. All carry
  `x-content-type-options: nosniff` — the payloads are shared user content.
- The `id` must be a canonical hyphenated UUID; the api also accepts un-hyphenated and braced forms, the
  BFF does not (the UI only sends ids the api returned).
- With `MOCK_UPSTREAM=true` (refused in `prod`) the routes serve `src/mocks/conversations.ts` — typed from the
  generated contract — with `x-mock-upstream: true`. The mock is stateless: `POST` returns a fresh
  conversation but the list does not grow, and a mocked ask is not stored. `GET …/{id}` answers `404
not_found` for an unknown id; the stream route streams for any well-formed id except
  `00000000-0000-4000-8000-000000000000` (a `404` before any stream), and a question containing
  `[mock:error]` ends in an `error` frame instead of `done`.
- Titles, questions and message text are user content and are never logged.

## api error contract (`apps/api`, `app/errors.py`)

Every non-2xx response from the api — operational routes and `/v1` alike — has exactly this body,
and the same trace id in the `x-trace-id` header:

```json
{ "error": "not_found", "trace_id": "0c70…" }
```

| Situation                                      | Status  | `error`                                                                                   |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| unknown route                                  | 404     | `not_found`                                                                               |
| wrong method                                   | 405     | `method_not_allowed` (+ `Allow` header)                                                   |
| request body/query fails validation            | 422     | `validation_error` — fields logged, not echoed                                            |
| `raise NotFound()` / `Conflict("<code>")`      | 404/409 | the class code or the one given                                                           |
| `raise HTTPException(403, detail="read_only")` | 403     | `read_only` (a snake_case `detail` is the code; prose maps to the default for the status) |
| model/search not configured or unavailable     | 503     | `ai_unavailable`                                                                          |
| anything else                                  | 500     | `internal_error` — kind + location logged only                                            |

Codes are stable identifiers the BFF and UI can switch on; messages, validation values and stack
traces never leave the api (rule 50). Streaming routes emit `event: error` with a bounded
`error_kind` once the stream has started (rule 70).

## Error behavior (BFF)

Each of the two demo routes wraps its upstream `fetch` **and** its `res.json()` parse in a single
`try/catch`. Only failures in that block — a network error (e.g. `ECONNREFUSED`, timeout) or a
non-JSON/unparseable upstream body — produce the BFF's own synthesized error response:

```json
{
  "error": "upstream_unreachable",
  "target": "api",
  "trace_id": "0eb0…"
}
```

- HTTP status: **`502`**.
- `target` — always `"api"` today (the bounded target label; `resolveTarget()` maps any
  other host to `"other"`).
- `trace_id` — the BFF's resolved trace id (same value echoed in the `x-trace-id` header).
- The literal error code `"upstream_unreachable"` is used even when the actual cause is a JSON
  parse failure rather than a connectivity failure — the catch block doesn't distinguish the two
  (`apps/web/src/app/api/*/route.ts`).
- An upstream **non-2xx status with a valid JSON body** (e.g. upstream 500) is **not** converted
  to a 502 — it's mirrored through as described above. The 502 path is reserved for cases where no
  upstream `Response` was successfully obtained/parsed at all.

## Headers

| Header                     | Direction                 | Behavior                                                                                                                                                                         |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-trace-id`               | Inbound                   | Adopted if it matches `^[0-9a-f]{32}$` (any origin prefix accepted); otherwise a fresh id is generated with the receiving service's origin (`web=0eb0`, `api=0c70`).             |
| `x-trace-id`               | Outbound (every response) | Always echoed — success, upstream passthrough, and the BFF's 502 all carry it. Set unconditionally by `withBff` (web) and `TraceMiddleware` (api) regardless of handler outcome. |
| `x-trace-id`               | Outbound (upstream calls) | Forwarded unchanged on every proxied call — `fetchUpstream` (web); `traced_client()` (api, unused in the baseline — the api has no downstream calls today).                      |
| `accept: application/json` | Outbound (web only)       | Set by `fetchUpstream` on every upstream call (`apps/web/src/lib/trace.ts`).                                                                                                     |

## Observability state reasons

The exact `reason` string on `/health` and `/info` depends on the service and its state — useful
when comparing responses across services (full detail:
[`environment-variables.md`](environment-variables.md#per-variable-notes)):

| State                          | `apps/web` reason                                                                            | `apps/api` reason                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| No connection string (default) | `no Azure connection string`                                                                 | `no Azure connection string`            |
| Enabled successfully           | `ok`                                                                                         | `azure monitor configured`              |
| Invalid `TELEMETRY_AUTH_MODE`  | `invalid TELEMETRY_AUTH_MODE "<value>" — expected "connection_string" or "managed_identity"` | same wording                            |
| Init/config threw              | `<raw error message>` (or `unknown initialization error`)                                    | `configure_azure_monitor failed: <exc>` |

In all cases `observability` is `"enabled"`/`"disabled"` (never any other value), and a
disabled/degraded state never crashes the service — see `.claude/rules/60-observability.md`.

## Versioning

- **Every business HTTP endpoint MUST be URI-versioned (`/v{n}`, starting at `v1`)** — decided in
  [`../adr/0001-api-versioning.md`](../adr/0001-api-versioning.md) and enforced per
  [`../../.claude/rules/05-api-versioning.md`](../../.claude/rules/05-api-versioning.md).
- **The only exemption**: the operational endpoints `/ping`, `/info`, `/health` (both services)
  stay unversioned — container/Azure health probes target fixed paths.
- **Business endpoints so far:** `apps/api` serves `/v1/conversations` (api:1.2) and
  `/v1/conversations/{id}/ask` (api:2.2); `apps/web` mirrors the conversation routes under
  `/api/v1/conversations` (web 1.1). The template's example
  `/api/v1/assistant/*` routes were removed in web 3.2.
