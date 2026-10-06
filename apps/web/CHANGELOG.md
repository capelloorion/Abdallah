# Changelog — `apps/web`

All notable changes to the **web** service (Next.js BFF + UI). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) from the consumer's perspective (root `CLAUDE.md`, rule 15).
The two services version independently.

## [Unreleased]

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
