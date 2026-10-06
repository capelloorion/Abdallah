import { apiBase, bff, errorResponse, proxyJson } from '@/lib/bff-json';
import { log } from '@/lib/logger';
import { isMockUpstream, mockJson } from '@/lib/mocks';
import { conversationDetailFixture } from '@/mocks/conversations';

export const dynamic = 'force-dynamic';

/** A dynamic segment must pass its pattern as the route class, or metric cardinality is unbounded. */
const ROUTE_CLASS = '/api/v1/conversations/[id]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/conversations/{id} → api GET /v1/conversations/{id}
 * The id goes into the upstream path, so it must be a canonical hyphenated UUID first — nothing
 * else (no `..`, no slashes, no query, no braces) can reach the api through this route. (Stricter
 * than the api, which also accepts un-hyphenated and braced forms; the UI only ever sends ids the
 * api itself returned.)
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return bff(req, ROUTE_CLASS, async ({ traceId }) => {
    const { id } = await context.params;
    if (!UUID.test(id)) return errorResponse('validation_error', 422, traceId);
    const conversationId = id.toLowerCase();
    log('info', 'bff inbound', { route: ROUTE_CLASS, method: 'GET' });
    if (isMockUpstream()) {
      const fixture = conversationDetailFixture(conversationId);
      return fixture
        ? mockJson(fixture, traceId)
        : mockJson({ error: 'not_found', trace_id: traceId }, traceId, 404);
    }
    return proxyJson(
      `${apiBase()}/v1/conversations/${conversationId}`,
      traceId,
      { method: 'GET' },
      ROUTE_CLASS,
    );
  });
}
