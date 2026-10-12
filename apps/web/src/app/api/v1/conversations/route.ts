import type { components } from '@/lib/api-types';
import {
  apiBase,
  bff,
  bodyReadError,
  errorResponse,
  isJsonRequest,
  proxyJson,
  readTextCapped,
} from '@/lib/bff-json';
import {
  MAX_CREATE_BODY_BYTES,
  MAX_LIST_LIMIT,
  MAX_TITLE_UNITS,
  MIN_LIST_LIMIT,
} from '@/lib/conversation-limits';
import { log } from '@/lib/logger';
import { isMockUpstream, mockJson } from '@/lib/mocks';
import { conversationCreatedFixture, conversationListFixture } from '@/mocks/conversations';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/v1/conversations';

/**
 * GET /api/v1/conversations?limit=50 → api GET /v1/conversations
 * `limit` is checked here (an integer 1–100) before it is put on the upstream URL; no other query
 * parameter is forwarded.
 */
export async function GET(req: Request): Promise<Response> {
  return bff(req, ROUTE, async ({ traceId }) => {
    const raw = new URL(req.url).searchParams.get('limit');
    let limit: number | undefined;
    if (raw !== null) {
      limit = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
      if (!(limit >= MIN_LIST_LIMIT && limit <= MAX_LIST_LIMIT)) {
        return errorResponse('validation_error', 422, traceId);
      }
    }
    log('info', 'bff inbound', { route: ROUTE, method: 'GET' });
    if (isMockUpstream()) return mockJson(conversationListFixture(limit), traceId);
    const query = limit === undefined ? '' : `?limit=${limit}`;
    return proxyJson(`${apiBase()}/v1/conversations${query}`, traceId, { method: 'GET' }, ROUTE);
  });
}

/** What the api's `POST /v1/conversations` takes (generated); the other arm is a local rejection. */
type CreateBody = components['schemas']['ConversationCreate'] | { invalid: true };

/** Shape the client's body into what the api accepts: a trimmed, well-formed `title`, nothing else. */
function parseCreateBody(text: string): CreateBody {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { invalid: true };
  }
  if (parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { invalid: true };
  const title = (parsed as Record<string, unknown>).title;
  if (title === undefined || title === null) return {};
  if (typeof title !== 'string') return { invalid: true };
  const trimmed = title.trim();
  if (trimmed.length > MAX_TITLE_UNITS) return { invalid: true };
  // A lone surrogate is valid JSON but cannot be encoded as UTF-16 text; the api would fail on it.
  if (!(trimmed as string & { isWellFormed(): boolean }).isWellFormed()) return { invalid: true };
  return trimmed === '' ? {} : { title: trimmed };
}

/**
 * POST /api/v1/conversations → api POST /v1/conversations
 *
 * Requires `content-type: application/json` (`415` otherwise) — a cross-site form or a
 * `no-cors` fetch cannot send that without a CORS preflight, which this app never approves. The
 * body is size- and time-capped and reduced to `{ title }`; unknown fields are not forwarded. The
 * title is user content: it is never logged.
 */
export async function POST(req: Request): Promise<Response> {
  return bff(req, ROUTE, async ({ traceId }) => {
    if (!isJsonRequest(req)) return errorResponse('unsupported_media_type', 415, traceId);
    const read = await readTextCapped(req, MAX_CREATE_BODY_BYTES);
    if (!read.ok) return bodyReadError(read.reason, traceId);
    const body = parseCreateBody(read.text);
    if ('invalid' in body) return errorResponse('validation_error', 422, traceId);
    log('info', 'bff inbound', { route: ROUTE, method: 'POST' });
    if (isMockUpstream())
      return mockJson(conversationCreatedFixture(body.title ?? undefined), traceId, 201);
    return proxyJson(
      `${apiBase()}/v1/conversations`,
      traceId,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      ROUTE,
    );
  });
}
