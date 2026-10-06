import type { components } from '@/lib/api-types';
import { DEFAULT_CONVERSATION_TITLE } from '@/lib/conversation-limits';
import { sseFrame } from '@/lib/sse';

/**
 * Fixtures for the conversation BFF routes (`/api/v1/conversations[/{id}]`), served only when
 * `MOCK_UPSTREAM=true`. Typed from the generated contract (`@/lib/api-types`, from
 * `docs/reference/openapi.json`), so a change to the api's shapes breaks the build here first.
 *
 * Stateless on purpose: `POST` returns a fresh conversation but the list does not grow, so a UI
 * built on the mocks adds a created conversation to its own list. Ids are fixed so a page can be
 * opened directly by URL.
 */
type Schemas = components['schemas'];

export { DEFAULT_CONVERSATION_TITLE };

export const TRACE_CONVERSATION_ID = '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51';
export const ERRORS_CONVERSATION_ID = '7a1d4e92-0b3c-4f65-8e21-9d8c7b6a5f42';
export const EMPTY_CONVERSATION_ID = 'c5e8a0b7-2d94-4a13-b7f6-4e3d2c1b0a93';
/** In mock mode, asking in this conversation answers `404 not_found` before any stream starts. */
export const NOT_FOUND_CONVERSATION_ID = '00000000-0000-4000-8000-000000000000';

export const conversationFixtures: Schemas['ConversationDetail'][] = [
  {
    id: TRACE_CONVERSATION_ID,
    title: 'How does trace_id propagation work?',
    created_at: '2026-10-06T09:00:00Z',
    updated_at: '2026-10-06T09:05:00Z',
    truncated: false,
    messages: [
      {
        id: '0d6c8e41-7b2a-4c90-a1f3-5e6d7c8b9a01',
        role: 'user',
        content: 'How does trace_id propagation work?',
        citations: null,
        created_at: '2026-10-06T09:00:00Z',
      },
      {
        id: '8b4f2a63-91c7-4e05-b3d8-6a7e8f9c0b12',
        role: 'assistant',
        content:
          'The trace id is minted by the BFF [1] and forwarded unchanged to the api on the x-trace-id header [2].',
        citations: [
          { title: 'Tracing', path: 'docs/architecture/tracing.md' },
          { title: 'The observability contract', path: '.claude/rules/60-observability.md' },
        ],
        created_at: '2026-10-06T09:00:04Z',
      },
      {
        id: '5e9a1c37-2f80-4b64-9d12-7b8a9c0d1e23',
        role: 'user',
        content: 'And on the api side?',
        citations: null,
        created_at: '2026-10-06T09:05:00Z',
      },
    ],
  },
  {
    id: ERRORS_CONVERSATION_ID,
    title: 'What does the error contract look like?',
    created_at: '2026-10-05T16:30:00Z',
    updated_at: '2026-10-05T16:31:00Z',
    truncated: false,
    messages: [
      {
        id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        role: 'user',
        content: 'What does the error contract look like?',
        citations: null,
        created_at: '2026-10-05T16:30:00Z',
      },
      {
        id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
        role: 'assistant',
        content: 'Every non-2xx response is { error, trace_id } [1].',
        citations: [{ title: 'HTTP API reference', path: 'docs/reference/http-api.md' }],
        created_at: '2026-10-05T16:31:00Z',
      },
    ],
  },
  {
    id: EMPTY_CONVERSATION_ID,
    title: DEFAULT_CONVERSATION_TITLE,
    created_at: '2026-10-04T08:00:00Z',
    updated_at: '2026-10-04T08:00:00Z',
    truncated: false,
    messages: [],
  },
];

/** `GET /v1/conversations`: newest `updated_at` first, optionally cut to `limit`. */
export function conversationListFixture(limit?: number): Schemas['ConversationList'] {
  const items = [...conversationFixtures]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(({ id, title, updated_at }) => ({ id, title, updated_at }))
    .slice(0, limit ?? 50);
  return { items, count: items.length };
}

/** `POST /v1/conversations`: a fresh conversation (not added to the list fixtures). */
export function conversationCreatedFixture(title?: string): Schemas['ConversationOut'] {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: title || DEFAULT_CONVERSATION_TITLE,
    created_at: now,
    updated_at: now,
  };
}

/** `GET /v1/conversations/{id}`: the fixture with that id, or `undefined` (the route answers 404). */
export function conversationDetailFixture(id: string): Schemas['ConversationDetail'] | undefined {
  return conversationFixtures.find((c) => c.id === id.toLowerCase());
}

/**
 * The frames `POST /v1/conversations/{id}/ask/stream` sends: `sources` → `token`* → `done`.
 * The wire format is not part of the OpenAPI contract (it is SSE), so the shapes below follow
 * `apps/api/app/ai/streaming.py`; the citations are typed from the contract.
 */
type Citation = Schemas['Citation'];

export const ASK_MOCK_CITATIONS: Citation[] = [
  { title: 'Tracing', path: 'docs/architecture/tracing.md' },
  { title: 'The observability contract', path: '.claude/rules/60-observability.md' },
];

const ASK_MOCK_ANSWER =
  'The trace id is minted by the BFF [1] and forwarded unchanged to the api on the x-trace-id header [2].';

function words(text: string): string[] {
  return text.split(' ').map((word) => sseFrame('token', { text: `${word} ` }));
}

/** A complete answer. */
export const askStreamFrames: string[] = [
  sseFrame('sources', { citations: ASK_MOCK_CITATIONS, count: 2 }),
  ...words(ASK_MOCK_ANSWER),
  sseFrame('done', { citations: ASK_MOCK_CITATIONS, input_tokens: 42, output_tokens: 24 }),
];

/** An answer cut off by a model failure: some tokens, then a terminal `error` frame (no `done`). */
export const askStreamErrorFrames: string[] = [
  sseFrame('sources', { citations: ASK_MOCK_CITATIONS, count: 2 }),
  ...words('The trace id is minted by the').slice(0, 4),
  sseFrame('error', { error_kind: 'timeout' }),
];

/** Put this anywhere in a question, in mock mode, to get `askStreamErrorFrames`. */
export const ASK_MOCK_ERROR_MARKER = '[mock:error]';
