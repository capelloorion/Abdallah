import type { components } from '@/lib/api-types';
import {
  parseCitations,
  readBoundedText,
  readFailure,
  sanitizeText,
  type StreamError,
} from '@/lib/chat-client';
import { isConversationId } from '@/lib/conversation-limits';

/**
 * Browser-side client for the conversation BFF routes (`/api/v1/conversations`). Same-origin
 * only (the BFF rule). Everything that comes back is stored, shared data and therefore untrusted
 * TEXT: it is shape-checked, stripped of control/bidi characters and bounded before a component
 * sees it, and a failure is reported as `{ code, traceId }` — never as raw server text.
 */
type Schemas = components['schemas'];

export type ConversationSummary = Schemas['ConversationSummary'];

/** A stored message, ready for `ChatThread` (no `error`/`traceId`: those are for live requests). */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations?: { title: string; path: string }[];
}

export interface ConversationThread {
  id: string;
  title: string;
  messages: StoredMessage[];
  /** The api left older messages out. */
  truncated: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: StreamError };

export const CONVERSATIONS_PATH = '/api/v1/conversations';

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_ITEMS = 100;
const MAX_MESSAGES = 200;
const MAX_TITLE_CHARS = 200;
const MAX_MESSAGE_CHARS = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function parseSummary(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const { id, title, updated_at } = value;
  if (typeof id !== 'string' || !isConversationId(id)) return null;
  if (typeof title !== 'string' || typeof updated_at !== 'string') return null;
  return {
    id: id.toLowerCase(),
    title: sanitizeText(title, MAX_TITLE_CHARS).trim(),
    updated_at: sanitizeText(updated_at, 64),
  };
}

function parseList(body: unknown): ConversationSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items: ConversationSummary[] = [];
  for (const raw of body.items) {
    if (items.length >= MAX_ITEMS) break;
    const item = parseSummary(raw);
    if (item) items.push(item);
  }
  return items;
}

/**
 * The id is made here (`stored-<position>`), never taken from the data: it is a React key and the
 * handle a live answer patches, so a stored id must not be able to collide with a live one.
 */
function parseMessage(value: unknown, index: number): StoredMessage | null {
  if (!isRecord(value)) return null;
  const { role, content, citations } = value;
  if (typeof content !== 'string') return null;
  if (role !== 'user' && role !== 'assistant') return null;
  const message: StoredMessage = {
    id: `stored-${index}`,
    role,
    text: sanitizeText(content, MAX_MESSAGE_CHARS),
  };
  const parsed = parseCitations(citations);
  if (parsed.length > 0) message.citations = parsed;
  return message;
}

function parseDetail(body: unknown): ConversationThread | null {
  if (!isRecord(body)) return null;
  const { id, title, messages, truncated } = body;
  if (typeof id !== 'string' || !isConversationId(id) || typeof title !== 'string') return null;
  if (!Array.isArray(messages)) return null;
  const parsed: StoredMessage[] = [];
  for (const raw of messages.slice(-MAX_MESSAGES)) {
    // the api returns the most recent messages oldest-first: keep the END if there are too many
    const message = parseMessage(raw, parsed.length);
    if (message) parsed.push(message);
  }
  const dropped = Math.max(0, messages.length - MAX_MESSAGES);
  return {
    id: id.toLowerCase(),
    title: sanitizeText(title, MAX_TITLE_CHARS).trim(),
    messages: parsed,
    // the api cuts to its most recent messages; the client may cut further, and says so too
    truncated: truncated === true || dropped > 0,
  };
}

async function call<T>(
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      ...init,
      signal,
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return { ok: false, error: { code: aborted ? 'aborted' : 'network_error' } };
  }
  if (!res.ok) return { ok: false, error: await readFailure(res) };
  const traceId = res.headers.get('x-trace-id') ?? undefined;
  try {
    const text = res.body ? await readBoundedText(res.body, MAX_RESPONSE_BYTES) : null;
    const data = text === null ? null : parse(JSON.parse(text));
    if (data !== null) return { ok: true, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: { code: 'aborted' } };
    }
    // unreadable or malformed body: reported below
  }
  return {
    ok: false,
    error: {
      code: 'bad_response',
      traceId: /^[0-9a-f]{32}$/.test(traceId ?? '') ? traceId : undefined,
    },
  };
}

/** `GET /api/v1/conversations` — newest first. */
export function listConversations(
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Result<ConversationSummary[]>> {
  return call(CONVERSATIONS_PATH, { method: 'GET' }, parseList, signal, fetchImpl);
}

/** `POST /api/v1/conversations` — a new, empty conversation. */
export function createConversation(
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Result<ConversationSummary>> {
  return call(
    CONVERSATIONS_PATH,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    parseSummary,
    signal,
    fetchImpl,
  );
}

/** `GET /api/v1/conversations/{id}` — the conversation with its stored messages. */
export function getConversation(
  id: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Result<ConversationThread>> {
  if (!isConversationId(id)) {
    return Promise.resolve({ ok: false, error: { code: 'bad_id' } });
  }
  return call(
    `${CONVERSATIONS_PATH}/${id.toLowerCase()}`,
    { method: 'GET' },
    parseDetail,
    signal,
    fetchImpl,
  );
}

/** The same-origin ask-stream endpoint of one conversation. */
export function askEndpoint(id: string): string {
  if (!isConversationId(id)) throw new Error('askEndpoint needs a conversation id');
  return `${CONVERSATIONS_PATH}/${id.toLowerCase()}/ask/stream`;
}
