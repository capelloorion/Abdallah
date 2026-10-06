# Changelog — `apps/web`

All notable changes to the **web** service (Next.js BFF + UI). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) from the consumer's perspective (root `CLAUDE.md`, rule 15).
The two services version independently.

## [Unreleased]

## [0.9.0] — 2026-10-06

### Removed

- The template's example business routes `/api/v1/assistant/ask` and `/api/v1/assistant/ask/stream` (the BFF routes, their tests and the `src/mocks/assistant.ts` fixtures). Nothing in the app used them since `/chat` moved to the conversation routes (web 2.3); the chat page no longer mentions the example or `MOCK_UPSTREAM`. Anything calling those two paths must use `/api/v1/conversations/{id}/ask/stream` instead. No api change.

### Changed

- `apps/web/CLAUDE.md`, `src/mocks/README.md` and `docs/reference/http-api.md` describe the conversation routes and fixtures as the reference. `ChatPanel`'s tests use a conversation endpoint.

## [0.8.0] — 2026-10-06

### Added

- **Conversation drawer on small screens.** Below 768 px the conversation list collapses behind a **Chats** button and opens as a drawer over the page; at 768 px and above the two-column layout is unchanged (the button is hidden and the list is always shown). `ConversationDrawer` (`src/components/chat/ConversationDrawer.tsx`) owns the behaviour: the button reports `aria-expanded` and `aria-controls`; opening moves focus into the drawer, which is a modal dialog ("Chats") while open and keeps Tab inside it; **Esc**, the backdrop or **Close** dismiss it and return focus to the button; picking a row or **+ New chat** closes it and focus goes where that action sends it (the input); growing the window to two columns closes it.
- `ChatWorkspace` wraps its list column in the drawer; the list itself (`ConversationList`) is unchanged.

### Hardening from review

- Esc and the Tab trap are handled at the document while the drawer is open, so they still work when focus has fallen to the page body (a click on blank space in the drawer); Tab from outside brings focus back in. When an action closes the drawer and leaves focus nowhere (the chat was already open, the request failed), focus goes to the **Chats** button instead of being lost. A failed **+ New chat** is shown in the chat area, not inside the drawer that has already closed.

### Tests

- `ConversationDrawer.test.tsx` and drawer cases in `ChatWorkspace.test.tsx`: collapsed by default, open/close by button, Esc, backdrop and Close, focus in and back, Tab trapped both ways, closing on pick and on + New chat, closing when the window widens, the two-column classes. Each guard was proven by removing it and watching a test fail. Layout itself (CSS breakpoints) cannot be checked in jsdom: see the manual check on the roadmap item.

## [0.7.0] — 2026-10-06

### Added

- The question box shows a **`n / 4,000` counter** (characters counted the way the api counts them: an emoji is one, surrounding spaces are not counted) and does not send an empty or over-long question, by button or Enter; the text is kept and the counter turns red with "too long to send". The box is described by the counter for screen readers (`aria-describedby`, `aria-invalid`). `MessageInput` takes `maxChars`; `ChatPanel` takes `maxQuestionChars` (default 4,000) and `onAnswered(question)`.
- When an answer is complete (`done`), the conversation **moves to the top of the list** with a fresh time, and one still called "New conversation" takes its **first question, cut to 200 characters, as its title** (the rule the api applies when it stores the answer), in the list and in the panel heading. A failed or cancelled answer changes nothing in the list and the input comes back.
- `DEFAULT_CONVERSATION_TITLE` in `src/lib/conversation-limits.ts` (the mock fixtures re-export it).

### Hardening from review

- A disabled box drops keyboard focus, so `MessageInput` hands focus back when it is enabled again (an answer finished, failed or was cancelled) if the person was typing in it — and only if focus was lost, never if they moved elsewhere. "Too long to send" is also announced through a status region (once, not on every keystroke).

### Tests

- `MessageInput`, `ChatPanel` and `ChatWorkspace` tests for the counter, the limit (button, Enter, paste, emoji, exactly the limit), `onAnswered` only on `done`, moving to the top, the first-question title (once only, cut at 200 code points), and an unchanged list on error. Each guard was proven by removing it and watching a test fail.

## [0.6.0] — 2026-10-06

### Added

- The **`/chat` page** now shows the conversation list (left) and the selected conversation (right). On load it calls `GET /api/v1/conversations`; **+ New chat** calls `POST /api/v1/conversations`, puts the new chat first, selects it and focuses the input; clicking a row calls `GET /api/v1/conversations/{id}` and shows its stored messages with their sources, and the input continues that conversation (it posts to `/api/v1/conversations/{id}/ask/stream`). A failed list, create or open shows the error code and trace id instead of a blank page. It works end to end with `MOCK_UPSTREAM=true`.
- `ChatWorkspace` (`src/components/chat/ChatWorkspace.tsx`) owns the list, the selection and the load states; the page itself stays thin.
- `src/lib/conversations-client.ts`: the browser client of the conversation BFF routes (`listConversations`, `createConversation`, `getConversation`, `askEndpoint`). Stored data is untrusted text: rows and messages are shape-checked, control/bidi characters stripped, sizes bounded (100 rows, 200 messages, 100,000 characters each, 2 MB per response), ids checked as UUIDs before they enter a URL, and citations go through `parseCitations`. A stored message never carries an `error` or trace id, so it can never look like a failed request.
- `ChatPanel` takes `initialMessages`, `autoFocus` and `headingLevel`; `MessageInput` takes `autoFocus`.

### Hardening from review

- A thread with more than 200 messages keeps the NEWEST 200 and shows "Only the most recent messages are shown." (the first version kept the oldest). `askEndpoint` throws for anything that is not a UUID, so a path is never built from other text. The set of characters stripped from stored text now also covers the soft hyphen, the Arabic letter mark (U+061C), line/paragraph separators, interlinear marks and the invisible tag characters. Titles are trimmed.
- Nothing is disabled while a chat opens or is created, so keyboard focus stays on the button just pressed; the newest action wins (an older open is cancelled, a new chat that finishes after another was opened joins the list without taking over). A failed list says so instead of "No chats yet" and offers **Try again**. The open conversation's title is the panel heading. Loading and hint lines are live regions.

### Changed

- `/chat` no longer shows the template's example assistant; it uses the conversation routes. (The example route and mock stay until web 3.2.)
- Live message ids are `live-<n>` and stored ones `stored-<n>`, so a stored message can never be mistaken for the answer being streamed (found while testing: a stored id `m1` collided with the first live id and a streamed token landed on a stored message).
- `chat-client.ts` exports `sanitizeText`, `readBoundedText` and `readFailure` for the new client.

### Tests

- `conversations-client.test.ts`, `ChatWorkspace.test.tsx` and additions to `ChatPanel.test.tsx` / `MessageInput.test.tsx`: list, empty and failed list, open with sources, truncated note, failed open and retry, stored text never shown as an error, new chat (also from the empty state, and failing), hostile title inert, requests cancelled on leave. Each guard was proven by removing it and watching a test fail.

## [0.5.0] — 2026-10-06

### Added

- `ConversationList` (`src/components/chat/ConversationList.tsx`): the conversation sidebar. Presentational only — it takes `items` (the shape of `GET /api/v1/conversations`), `selectedId`, `onSelect`, `onNewChat` and `disabled`, and fetches nothing. Rows are buttons showing the title and a relative time, the selected row carries `aria-current`, the empty state reads "No chats yet", and **+ New chat** is always offered. Titles are stored data and render as text only (own `<bdi>`, clipped by CSS); an empty title, or one made only of invisible characters, reads "Untitled chat"; a clipped title shows in full on hover and an unreadable time is left out.
- `relativeTime` (`src/lib/relative-time.ts`): "5 minutes ago", "yesterday", "now" through `Intl.RelativeTimeFormat`; `''` for a bad date, "now" for a time in the future.

### Tests

- `ConversationList.test.tsx` and `relative-time.test.ts`: rows, selection, empty state, new chat, keyboard use, disabled, hostile title as inert text, title and time fallbacks. Each guard was proven by removing it and watching its test fail.

## [0.4.0] — 2026-10-06

### Added

- **Citations in the chat UI** (roadmap web 2.1): `ChatMessage.citations` (`[{ title, path }]`) replaces `sources`
  (`string[]`), and `askStream`'s `onSources`/`onDone` hand the citations over. `ChatThread` shows a **Sources** block
  — title, then path, as plain text only — as soon as the `sources` frame arrives. `parseCitations()` keeps only
  well-formed entries (at most 50, each field at most 500 characters).
- **Error details**: `askStream`'s `onError` now receives `{ code, traceId }`. A failure before the stream starts
  surfaces the api's `error` and `trace_id` (JSON body), or the `error_kind` in the BFF's `502` event-stream body
  (api unreachable); an in-stream `error` frame surfaces `error_kind`; the trace id comes from the body, else the
  `x-trace-id` header. Codes and trace ids are validated against strict patterns before they are shown. `ChatThread`
  shows a red line with the code and trace id; a failed answer with nothing to show is just that line, and a
  partial answer is kept and marked incomplete.

### Changed

- A stream that ends without a `done` or `error` frame is now a failure (`stream_ended`) instead of a silent
  "done", so a cut-off answer is never shown as complete.
- A cancelled request is handled honestly: the page now aborts its request when it is left (which lets the api stop the
  model call); a half answer is kept and marked incomplete (`aborted`), and an empty placeholder is removed. `ChatPanel`
  patches ITS OWN message by id, never "the last one", so a late callback can never land on a newer answer.
- The template's example `/api/v1/assistant/ask/stream` mock now streams `citations` like the api.
- **Internal API change**: `StreamHandlers.onError` takes `{ code, traceId }` instead of a string, and `ChatMessage`
  has `citations`/`traceId` instead of `sources`. Only the chat components use them.

### Hardening from review

- Control, zero-width and bidi-override characters are stripped from citation titles and paths (a title that is nothing
  but those falls back to the file name), and each is rendered in its own `<bdi>` with a space between them, so a
  disguised title cannot reorder or hide the path next to it.
- Browser-side bounds: an answer is capped at 100,000 characters (`answer_too_long`, the text so far is kept), an SSE
  frame that never ends is refused after 1,000,000 characters (`stream_error`), an error body is read only up to 4 KB, and
  a failed response's event stream is read for at most 20 events.
- `askStream` only accepts a same-origin path (one leading `/`, no scheme or host, no whitespace): anything else is
  `bad_endpoint` and nothing is sent. The response body is cancelled once a terminal frame has been read.

### Tests

- `src/lib/chat-client.test.ts`, `ChatThread.test.tsx`, `ChatPanel.test.tsx` rewritten and `sse.test.ts` extended: citations,
  every failure path (JSON error, BFF 502 stream, error frame, cut-off stream, network, abort), unsafe codes and trace ids,
  hostile titles/paths rendered as inert text, bidi/zero-width stripping, the size bounds, endpoint refusal, abort on
  unmount, sources shown before the first token. Each new check was proven by removing it and watching its tests fail.

## [0.3.0] — 2026-10-06

### Added

- **Ask-stream BFF route** (roadmap web 1.2): `POST /api/v1/conversations/{id}/ask/stream` relays the api's
  `sources` → `token`\* → `done` (or terminal `error`) Server-Sent Events unchanged, with `x-trace-id`
  forwarded and echoed. `sources` and `done` carry `citations: [{ title, path }]`.
- Checks before anything is forwarded: the `id` is a UUID, `content-type` is `application/json` (`415`), the body
  is at most 64 KB and arrives within 5 s (`413`, `408`), and `question` is a trimmed, non-empty, well-formed
  string (`400 bad_request`) of at most 4000 characters — counted in code points like the api, so an emoji is
  one (`413 payload_too_large`, pending the api's Q5). Only `question` is forwarded; the question is never logged.
- An api error before the stream starts (`404`, `422`, `413`, `503 ai_unavailable`) keeps its status and JSON
  body. An unreachable api, a timeout or a redirect → `502` carrying a terminal `error` frame; a 200 that is not an
  event stream → `502 upstream_error`. If the browser disconnects, the upstream request is aborted so the model
  call can stop.
- Mock mode (`MOCK_UPSTREAM=true`): paced `askStreamFrames` with title+path citations, and `askStreamErrorFrames`
  (tokens, then an `error` frame, no `done`) for a question containing `[mock:error]` — in `src/mocks/conversations.ts`.
- `src/lib/bff-json.ts`: `isJsonRequest`, `bodyReadError`, `relayJsonError`; `src/lib/conversation-limits.ts`:
  `MAX_QUESTION_CHARS`, `MAX_ASK_BODY_BYTES`, `isConversationId`.

### Changed

- `hardenResponse` keeps a stream's own `cache-control: no-cache, no-transform` (it keeps intermediaries from
  compressing or buffering an event stream) but forces `no-store` on everything else, even a response that
  arrived already marked cacheable.
- Pre-stream api errors are relayed as `{ error, trace_id }` only; an api error body of any other shape is a
  `502 upstream_error`. A `200` is streamed only if its media type is exactly `text/event-stream`.

- Tests: `src/app/api/v1/conversations/ask-stream.test.ts` (70 tests: both modes, every pre-forward check, pass-through of
  api errors, unreachable/timeout/redirect, disconnect abort, trace echo, no question in logs).

## [0.2.0] — 2026-10-06

### Added

- **Conversation BFF routes** (roadmap web 1.1): `GET /api/v1/conversations` (`?limit=`),
  `POST /api/v1/conversations` and `GET /api/v1/conversations/{id}`, mirroring the api's `/v1/conversations`.
  Each forwards `x-trace-id`, passes the api's status and `{ error, trace_id }` body through unchanged, and
  returns `502 upstream_unreachable` / `502 upstream_error` (never relaying a non-JSON upstream body).
- The BFF validates what it forwards: `limit` must be an integer 1–100; the `id` must be a UUID before it
  is placed in the upstream path; the create body is capped at 4 KB (`413 payload_too_large`), must be a JSON
  object, and only a trimmed `title` of at most 200 UTF-16 code units is forwarded (`422 validation_error`).
- Hardening from review: `POST` requires `content-type: application/json` (`415`), so a cross-site form or
  `no-cors` request cannot create conversations; the body read has a 5 s deadline (`408`) as well as the 4 KB
  cap; a title with a lone surrogate is rejected (`422`) because the api could not encode it; every response
  carries `cache-control: no-store` and `x-content-type-options: nosniff`; upstream redirects are refused and
  no upstream header is relayed; a timeout while reading the api's reply is `upstream_unreachable`.
- `src/lib/bff-json.ts` (`bff`, `proxyJson`, `errorResponse`, `readTextCapped`), `src/lib/conversation-limits.ts` and `src/mocks/conversations.ts` —
  fixtures typed from the generated `api-types.ts` (three conversations, one with messages and citations);
  served only with `MOCK_UPSTREAM=true`, marked `x-mock-upstream: true`. The mock is stateless.
- Tests: `src/app/api/v1/conversations/routes.test.ts` (102 tests; both modes, validation, pass-through,
  failures, trace echo, and that no title reaches a log).

## [0.1.0] — 2026-09-28

### Added

- **UI foundation** (ADR-0010): Tailwind CSS v4 (`@tailwindcss/postcss`), chat components
  (`src/components/chat/`: `ChatThread`, `MessageInput`, `ChatPanel`), the browser streaming
  client `src/lib/chat-client.ts` (`askStream`), SSE helpers `src/lib/sse.ts`, and the example
  page `/chat`.
- **Streaming pass-through** for the BFF: `streamUpstream` + `proxyStream` (`src/lib/stream.ts`,
  5-minute whole-answer bound, `x-trace-id` forwarded, no proxy buffering).
- **Mock-upstream mode**: `MOCK_UPSTREAM=true` (server-side, refused in `prod`) makes a BFF
  route serve fixtures from `src/mocks/` (`src/lib/mocks.ts`, responses marked
  `x-mock-upstream: true`).
- Example business routes `POST /api/v1/assistant/ask` and `POST /api/v1/assistant/ask/stream`
  (mock or proxy to the api's `/v1/assistant/…`, which a project adds on `app/ai/`).
- **API contract types**: `src/lib/api-types.ts` generated from `docs/reference/openapi.json`
  (`pnpm api-types` / `make openapi`).
- **Component tests** (ADR-0011): React Testing Library in Vitest with per-file jsdom; coverage
  now includes `src/components/**/*.tsx`. New scripts: `typecheck`, `api-types`.

## [0.0.0] — 2026-09-20

- Template baseline. No features shipped.
