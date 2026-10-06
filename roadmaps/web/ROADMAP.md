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

- **status:** todo
- **depends_on:** []
- **layers:** [bff]
- **acceptance:**
  - `GET /api/v1/conversations?limit=` and `POST /api/v1/conversations` (optional `{title}`) and `GET /api/v1/conversations/{id}` exist under `src/app/api/v1/conversations/`, each forwarding to the matching `/v1/conversations…` route with `x-trace-id`
  - the api's status and `{error, trace_id}` body pass through unchanged for `404 not_found` and `422 validation_error`; an unreachable api returns `502 {error: "upstream_unreachable", target: "api", trace_id}`
  - with `MOCK_UPSTREAM=true` all three return fixtures from `src/mocks/conversations.ts` (a list of several conversations, one with messages and citations) with `x-mock-upstream: true`; works against fixtures until `api:1.2` lands
  - every response echoes `x-trace-id`; the routes are tested in both mock and real modes
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none
- **notes:**
  - 2026-10-06 — planned. Fixture types are written by hand with `// TODO(contract)` until `api:1.2`.

### 1.2 — Ask-stream BFF route

- **status:** todo
- **depends_on:** [1.1]
- **layers:** [bff]
- **acceptance:**
  - `POST /api/v1/conversations/{id}/ask/stream` with `{question}` streams the api's `sources` → `token`\* → `done` frames to the browser unchanged, using `streamUpstream` + `proxyStream`; `sources` and `done` carry `[{title, path}]`
  - an empty question is rejected locally with `400`; a question over 4,000 characters is rejected locally with the same code the api uses (pending `api` Q5); the api's own pre-stream errors (`404`, `422`/`413`, `503 ai_unavailable`) pass through with their status and `{error, trace_id}` body
  - an unreachable api returns a terminal `error` SSE frame with `error_kind: "upstream_unreachable"`; an `error` frame from the api reaches the browser as sent
  - with `MOCK_UPSTREAM=true` the route streams a paced fixture (citations with title and path) and a second fixture that ends in an `error` frame, selectable by a fixed marker in the question; works against fixtures until `api:3.1` lands
  - the response carries `x-trace-id`; tested in both modes
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - none
- **notes:**
  - 2026-10-06 — planned. The BFF stream timeout (`STREAM_TIMEOUT_MS`, 300 s) already exceeds the api's 60 s, so no change is needed. The JSON `/ask` route is not planned here: the wireframe only uses the stream. The draft B4a says the BFF mirrors every route — confirm that is not wanted for `/ask`. `/v1/admin/ingest` is deliberately not mirrored; if the team decides otherwise (`api` Q1), add a new item.

## Phase 2 — Chat page (F1, F2)

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
