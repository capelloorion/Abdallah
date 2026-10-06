# Web roadmap — Team Assistant

Schema: [`../README.md`](../README.md). Frontend (`apps/web`): pages, BFF routes, components,
mocks.

**Planned from (2026-10-06):** the `/chat` wireframe in `docs/wireframe.md` (state table, components,
API needs), the draft API surface in `docs/architecture.md` B4a, and the api roadmap
([`../api/ROADMAP.md`](../api/ROADMAP.md)). `ARCHITECTURE.md` Part B and
`docs/design/wireframes/chat.md` have **not** been updated yet — when the team applies them, re-run
`/plan-roadmap web` and reconcile.

**What the template already ships and these items change:** an example page `src/app/chat`
(`ChatPanel` → `/api/v1/assistant/ask/stream`), the BFF routes `/api/v1/assistant/ask[/stream]`,
the fixture `src/mocks/assistant.ts`, and the stream client `src/lib/chat-client.ts`. They model a
single anonymous question with `sources: string[]`; the project needs conversation-scoped routes
and `citations: [{title, path}]`.

**Working ahead of the api.** Every UI and BFF item below works against `MOCK_UPSTREAM=true`
fixtures, typed by hand from the draft contract and marked `// TODO(contract)` (the generated
`src/lib/api-types.ts` has no conversation routes until `api:1.2` lands and `just openapi` is run).
Only item 3.1 — switching to the generated types and a real run — depends on the api items.

## Phase 1 — BFF contract and mocks

### 1.1 — Conversation BFF routes (list, create, get)

- **status:** done
- **depends_on:** []
- **layers:** [bff]
- **acceptance:**
  - `GET /api/v1/conversations?limit=` and `POST /api/v1/conversations` (optional `{title}`) and `GET /api/v1/conversations/{id}` exist under `src/app/api/v1/conversations/`, each forwarding to the matching `/v1/conversations…` route with `x-trace-id`
  - the api's status and `{error, trace_id}` body pass through unchanged for `404 not_found` and `422 validation_error`; an unreachable api returns `502 {error: "upstream_unreachable", target: "api", trace_id}`
  - with `MOCK_UPSTREAM=true` all three return fixtures from `src/mocks/conversations.ts` (a list of several conversations, one with messages and citations) with `x-mock-upstream: true`; works against fixtures until `api:1.2` lands
  - every response echoes `x-trace-id`; the routes are tested in both mock and real modes
- **how_to_test:**
  - `just test` — web: **238 passed** (api: 315 passed); the new file is `apps/web/src/app/api/v1/conversations/routes.test.ts` (102 tests, both mock and real modes)
  - `pnpm -C apps/web typecheck` clean, and `pnpm -C apps/web build` lists `ƒ /api/v1/conversations` and `ƒ /api/v1/conversations/[id]` (delete `apps/web/.next` afterwards before running `next dev`)
  - mock mode by hand: put `MOCK_UPSTREAM=true` in `apps/web/.env.local`, run `pnpm -C apps/web dev`, then
    - `curl -si localhost:3000/api/v1/conversations` → `200`, headers `x-mock-upstream: true`, `x-trace-id`, `cache-control: no-store`; three conversations, newest first
    - `curl -s "localhost:3000/api/v1/conversations?limit=1"` → one item; `?limit=0` → `422 {"error":"validation_error","trace_id":…}`
    - `curl -s -X POST localhost:3000/api/v1/conversations -H "content-type: application/json" -d '{"title":"Hi"}'` → `201` with `"title":"Hi"`; the same without the `content-type` header → `415`
    - `curl -s localhost:3000/api/v1/conversations/3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51` → `200` with messages and citations; `…/00000000-0000-4000-8000-000000000000` → `404 not_found`; `…/abc` → `422`
  - real mode (needs the api running with a database, see needs_human): unset `MOCK_UPSTREAM`, run the api on `:8000`, repeat the calls → the api's own bodies, no `x-mock-upstream` header; stop the api → `502 {"error":"upstream_unreachable","target":"api",…}`
- **needs_human:**
  - to try real mode: the api running against the dev database (migration 1.1 applied through `migrate.yml`, `DATABASE_URL` in `apps/api/.env` — secrets, not set by an agent)
  - confirm `MOCK_UPSTREAM` is never set in a deployed environment: nothing in `infra/`, `.github/`, `docker-compose.yml`, the Dockerfile or the `.env.example`s sets it (checked), and the code refuses it only when `APP_ENV=prod`
- **notes:**
  - 2026-10-06 — planned. Fixture types are written by hand with `// TODO(contract)` until `api:1.2`.
  - 2026-10-06 — started by Claude
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/web/src/app/api/v1/conversations/route.ts` (GET list, POST create) and `[id]/route.ts` (GET one), `apps/web/src/lib/bff-json.ts` (`bff`, `proxyJson`, `errorResponse`, `readTextCapped`), `apps/web/src/lib/conversation-limits.ts`, `apps/web/src/mocks/conversations.ts`, the route tests, `docs/reference/http-api.md`, `apps/web/CLAUDE.md`, `apps/web/src/mocks/README.md`, `apps/web/CHANGELOG.md`, version 0.1.0 → 0.2.0. Fixtures are typed from the generated `api-types.ts` (api:1.2 is done), so there are no hand-typed `TODO(contract)` shapes — web 3.1 now only has to run against the real api.
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: `POST` now requires `content-type: application/json` (a cross-site form or `no-cors` fetch could otherwise create conversations), 5 s body-read deadline, lone-surrogate titles rejected, `no-store` + `nosniff` on every response, upstream redirects refused, a timeout while reading the api's reply is `upstream_unreachable`, constants moved out of `route.ts`, hermetic tests with env restore, and many edge-case tests (each new guard proven by a mutation check).
  - 2026-10-06 — NOT done here (threat-model items, no roadmap item yet): P2 rate limit on create and ingress/server request timeouts; P4 a byte cap on the api reply (`res.json()` buffers it; the api bounds its own output with limit 100, the 500-message cap and citation size caps); P6 CSP and the rest of the security headers. Not forwarded-safe yet: titles may contain control or bidi-override characters (the api does not strip them on create) — the UI items must render titles as plain text. The mock is stateless, so a created conversation does not appear in the mock list: web 2.3 must add it to its own list.
  - 2026-10-06 — confirmed by the developer (done). Trying it against the real api (needs_human above) is still open.

### 1.2 — Ask-stream BFF route

- **status:** done
- **depends_on:** [1.1]
- **layers:** [bff]
- **acceptance:**
  - `POST /api/v1/conversations/{id}/ask/stream` with `{question}` streams the api's `sources` → `token`\* → `done` frames to the browser unchanged, using `streamUpstream` + `proxyStream`; `sources` and `done` carry `[{title, path}]`
  - an empty question is rejected locally with `400`; a question over 4,000 characters is rejected locally with the same code the api uses (pending `api` Q5); the api's own pre-stream errors (`404`, `422`/`413`, `503 ai_unavailable`) pass through with their status and `{error, trace_id}` body
  - an unreachable api returns a terminal `error` SSE frame with `error_kind: "upstream_unreachable"`; an `error` frame from the api reaches the browser as sent
  - with `MOCK_UPSTREAM=true` the route streams a paced fixture (citations with title and path) and a second fixture that ends in an `error` frame, selectable by a fixed marker in the question; works against fixtures until `api:3.1` lands
  - the response carries `x-trace-id`; tested in both modes
- **how_to_test:**
  - `just test` — web: **308 passed** (api: 315 passed); the new file is `apps/web/src/app/api/v1/conversations/ask-stream.test.ts` (70 tests, both mock and real modes)
  - `pnpm -C apps/web typecheck` clean, and `pnpm -C apps/web build` lists `ƒ /api/v1/conversations/[id]/ask/stream` (delete `apps/web/.next` afterwards before running `next dev`)
  - mock mode by hand (`MOCK_UPSTREAM=true` in `apps/web/.env.local`, `pnpm -C apps/web dev`):
    - `curl -N -X POST localhost:3000/api/v1/conversations/3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51/ask/stream -H "content-type: application/json" -d '{"question":"How does trace_id work?"}'` → frames arrive paced: `event: sources` with `"citations":[{"title":"Tracing","path":"docs/architecture/tracing.md"},…]`, then many `event: token`, then `event: done`
    - the same with `"question":"why? [mock:error]"` → a few tokens, then `event: error` with `"error_kind":"timeout"` and no `done`
    - `…/00000000-0000-4000-8000-000000000000/ask/stream` → `404 {"error":"not_found",…}` (no stream)
    - empty `"question":""` → `400 bad_request`; a 4001-character question → `413 payload_too_large`; no `content-type` header → `415`; id `abc` → `422`
  - real mode needs the api route (api 3.1, not built yet): until then a real call gets the api's `404`, which the BFF relays as `{"error":"not_found","trace_id":…}`
  - disconnect check (needs a real api stream, so after api 3.1): start a stream, close the tab or `Ctrl-C` curl, and confirm the api logs a cancelled request
- **needs_human:**
  - decide the status code for an invalid question: the roadmap acceptance said `400`, and it is `400 bad_request` (the api's own default code for 400) — web 1.1 uses `422 validation_error` for bad input, which is also what the api returns for validation failures. Say if you want this route to use `422` too; it is a one-line change per case
  - the real-api checks above (the api's ask route is api 3.1; api 2.2 first needs the team's acceptance of the shared-conversations threat model)
  - verify the browser-disconnect abort under the real Next server once an api stream exists (unit tests simulate the signal; Next 16 builds `req.signal` from the response `close` event)
- **notes:**
  - 2026-10-06 — planned. The BFF stream timeout (`STREAM_TIMEOUT_MS`, 300 s) already exceeds the api's 60 s, so no change is needed. The JSON `/ask` route is not planned here: the wireframe only uses the stream. The draft B4a says the BFF mirrors every route — confirm that is not wanted for `/ask`. `/v1/admin/ingest` is deliberately not mirrored; if the team decides otherwise (`api` Q1), add a new item.

## Phase 2 — Chat page (F1, F2)

- 2026-10-06 — started by Claude
  - 2026-10-06 — implemented; awaiting test by the developer. Files: `apps/web/src/app/api/v1/conversations/[id]/ask/stream/route.ts` (new), `apps/web/src/app/api/v1/conversations/ask-stream.test.ts` (new), `apps/web/src/lib/bff-json.ts` (`isJsonRequest`, `bodyReadError`, `relayJsonError`; `hardenResponse` is stream-aware), `apps/web/src/lib/conversation-limits.ts`, `apps/web/src/mocks/conversations.ts` (stream fixtures, error marker, reserved not-found id), small refactors of the two existing conversation routes onto the shared helpers, `docs/reference/http-api.md`, `apps/web/CLAUDE.md`, `apps/web/CHANGELOG.md`, version 0.2.0 → 0.3.0.
  - 2026-10-06 — reviews run: `code-reviewer` and `security-reviewer` (no blockers). Fixed from them: a literal `$1` my docs script left in `http-api.md`, `hardenResponse` could not be fail-open (a response that arrives already cacheable now gets `no-store`; only a real event stream keeps its own header), api error bodies are relayed as `{error, trace_id}` only, only a `200` with an exact `text/event-stream` media type is streamed, question length counted in code points with a fast path, a browser that left is logged at info not error, and tests for unbuffered relay, the escaped-astral body, timeout composition and the `hardenResponse` unit cases (each new check proven by a mutation).
  - 2026-10-06 — for web 2.1 (client): `askStream` must read the body of a non-OK `text/event-stream` response (the unreachable-api `502` carries an `error` frame whose `error_kind` is otherwise lost) and the JSON `{error, trace_id}` of a pre-stream error; it must read `citations` (the template client still reads `sources`); and it must treat a stream that ends without `done` or `error` as a failure — a stream cut after headers has no terminal frame, so the partial answer must never be shown as complete. Key on the status class, not on the exact error code.
  - 2026-10-06 — NOT done here (threat model P2/P4/P6): a rate limit and a concurrent-stream cap on this cost-bearing route (a model call per request, up to 300 s per stream — High until P2, acceptable only on the internal network), a byte cap on the api's error replies, CSP and security headers, a stream-end log/metric (outcome, duration, disconnect — `withBff` measures only time to headers). The template's older `/api/v1/assistant/ask[/stream]` routes have none of these caps either; web 3.2 retires them. `MOCK_UPSTREAM` is refused only when `APP_ENV=prod`, so make sure it is never set in any deployed environment (nothing sets it today).
  - 2026-10-06 — confirmed by the developer (done). The real-api checks and the 400-vs-422 choice (needs_human above) are still open.

### 2.1 — Citations and error details in the chat client and thread

- **status:** todo
- **depends_on:** [1.2]
- **layers:** [ui]
- **acceptance:**
  - `askStream` and `ChatMessage` carry `citations: {title, path}[]` instead of `sources: string[]`; `onSources` and `onDone` hand the citations over
  - a failure before the stream starts surfaces the api's `error` code and `trace_id` (from the JSON body, else the `x-trace-id` header); an `error` frame surfaces `error_kind` plus the response's `x-trace-id` header
  - `ChatThread` renders a **Sources** block under each assistant message (title, then path) as soon as the `sources` frame arrives, and a red line with the error code and `trace_id` under the last user message on failure
  - existing chat component and client tests are updated and green; new cases cover citations and both error paths
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none
- **notes:**
  - 2026-10-06 — planned. `ChatPanel` is the reference shape; this item changes its message type, not its layout.

### 2.2 — ConversationList component

- **status:** todo
- **depends_on:** []
- **layers:** [ui]
- **acceptance:**
  - a presentational `ConversationList` renders rows (title and relative time), a selected state, the empty state "No chats yet", and a **+ New chat** button; it takes items, the selected id and callbacks as props and fetches nothing
  - it is keyboard-operable (rows are buttons, selected row marked `aria-current`) and has a component test next to it covering rows, selection, empty state and the new-chat callback
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none
- **notes:**
  - 2026-10-06 — planned. Tailwind utilities per ADR-0010; no component kit or client-state library (that needs an ADR).

### 2.3 — `/chat` page: list, create and reopen conversations

- **status:** todo
- **depends_on:** [1.1, 2.1, 2.2]
- **layers:** [ui]
- **acceptance:**
  - `/chat` shows the conversation list (left) and the thread (right) as in the wireframe; on load it calls `GET /api/v1/conversations`; with no conversations it shows "No chats yet"
  - **+ New chat** calls `POST /api/v1/conversations`, adds the new conversation at the top, selects it and focuses the input
  - clicking a row calls `GET /api/v1/conversations/{id}` and shows its messages with their citations; the input then continues that conversation
  - a list or load failure shows the error code and `trace_id` instead of a blank page; the page works end to end against `MOCK_UPSTREAM=true` fixtures
  - the page uses `ChatPanel`/`ChatThread` refactored to take a conversation id and initial messages (the page itself stays under the manual Playwright smoke)
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - run the manual Playwright smoke for `/chat` once (page tests are manual per rule 40)
- **notes:**
  - 2026-10-06 — planned.

### 2.4 — Send a question in a conversation

- **status:** todo
- **depends_on:** [2.3]
- **layers:** [ui]
- **acceptance:**
  - **Send** posts to `/api/v1/conversations/{id}/ask/stream`; while streaming **Send** is disabled, tokens appear, and the Sources block appears when the `sources` frame arrives
  - the input shows a `n / 4,000` counter and does not send an empty or over-long question
  - on `done` the assistant message shows its sources and the conversation moves to the top of the list; on an error the red line shows the code and `trace_id`, and the input is re-enabled
  - a new conversation titled "New conversation" shows the first question (cut to 200 characters) as its title after the first answer, matching the api
  - works against the `MOCK_UPSTREAM=true` fixtures, including the error fixture
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none
- **notes:**
  - 2026-10-06 — planned. A reload shows a conversation's stored messages only; an interrupted answer (disconnect before `done`) is not stored by the api (`api:3.1`), so it will not reappear.

### 2.5 — Conversation drawer on small screens

- **status:** todo
- **depends_on:** [2.3]
- **layers:** [ui]
- **acceptance:**
  - below 768 px the conversation list collapses into a drawer opened from a button in the header; picking a row or **+ New chat** closes it
  - the drawer is keyboard- and screen-reader-operable (focus moves in, **Esc** closes, the button reports expanded/collapsed)
  - at 768 px and above the two-column layout is unchanged
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - check the drawer on a phone-width viewport during the manual smoke
- **notes:**
  - 2026-10-06 — planned from the wireframe's "below 768 px" rule.

## Phase 3 — Real contract and cleanup

### 3.1 — Switch to the generated api contract and run against the real api

- **status:** todo
- **depends_on:** [2.4, api:1.2, api:3.1]
- **layers:** [bff, ui]
- **acceptance:**
  - after `just openapi`, the fixtures in `src/mocks/conversations.ts` and the BFF/client types come from `src/lib/api-types.ts`; every `TODO(contract)` is gone and CI's stale-contract check passes
  - with `MOCK_UPSTREAM` off, `/chat` works against the local api: create, list, reopen, and a streamed answer with citations
  - the mock branches in the BFF routes stay available behind `MOCK_UPSTREAM` for demos (they are not deleted)
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the dev database has the migration applied (`api:1.1`), `apps/api/.env` has the `AZURE_AI_*` / `AZURE_SEARCH_*` values, and the index has been ingested (`api:4.2`) — otherwise answers cannot be grounded
  - run the manual Playwright smoke against the real api
- **notes:**
  - 2026-10-06 — planned. `api:2.2` is covered because `api:3.1` depends on it.

### 3.2 — Retire the template's `assistant` example

- **status:** todo
- **depends_on:** [2.4]
- **layers:** [bff, docs]
- **acceptance:**
  - `src/app/api/v1/assistant/**`, `src/mocks/assistant.ts` and their tests are removed, and the `/chat` page no longer mentions the example or `MOCK_UPSTREAM` as a prerequisite
  - `docs/reference/http-api.md`, `apps/web/CLAUDE.md` and `src/mocks/README.md` describe the conversation routes instead
  - nothing else imports the removed files; `just test` is green
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - confirm the deletion of the example files (deleting files is a hard stop)
- **notes:**
  - 2026-10-06 — planned.

## Phase 4 — Hardening

### 4.1 — "Chats are shared" notice

- **status:** todo
- **depends_on:** [api:1.3]
- **layers:** [ui]
- **acceptance:**
  - `/chat` shows a persistent one-line notice that conversations are visible to everyone using the app and that personal or confidential data should not be entered; the wording is the one the team accepted in the `api:1.3` threat model
  - the notice does not cover the thread or the input at any width
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - the team confirms the notice wording (it comes from the `api:1.3` threat-model decision)
- **notes:**
  - 2026-10-06 — planned from ADR-0014 (shared conversations until auth lands).
