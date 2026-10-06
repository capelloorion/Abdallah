# Changelog — `apps/web`

All notable changes to the **web** service (Next.js BFF + UI). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) from the consumer's perspective (root `CLAUDE.md`, rule 15).
The two services version independently.

## [Unreleased]

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
