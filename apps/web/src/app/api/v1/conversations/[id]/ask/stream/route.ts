import {
  apiBase,
  bff,
  bodyReadError,
  errorResponse,
  isJsonRequest,
  readTextCapped,
  relayJsonError,
} from '@/lib/bff-json';
import {
  MAX_ASK_BODY_BYTES,
  MAX_QUESTION_CHARS,
  isConversationId,
} from '@/lib/conversation-limits';
import type { components } from '@/lib/api-types';
import { log } from '@/lib/logger';
import { acquireStreamSlot, enforceRateLimit, releaseWhenDone } from '@/lib/rate-limit';
import { isMockUpstream, mockJson, mockSse } from '@/lib/mocks';
import { sseFrame } from '@/lib/sse';
import { STREAM_TIMEOUT_MS, proxyStream, streamUpstream } from '@/lib/stream';
import {
  ASK_MOCK_ERROR_MARKER,
  NOT_FOUND_CONVERSATION_ID,
  askStreamErrorFrames,
  askStreamFrames,
} from '@/mocks/conversations';

export const dynamic = 'force-dynamic';

const ROUTE_CLASS = '/api/v1/conversations/[id]/ask/stream';

/** What the api's `POST …/ask/stream` takes (generated); the other arm is a local rejection. */
type AskBody = components['schemas']['AskRequest'] | { error: 'invalid' | 'too_long' };

/** Characters (code points) in a string — the api's unit; an emoji is one, not two. */
function characterCount(text: string): number {
  // Code points never outnumber UTF-16 units, and a code point is at most two units, so most
  // strings are decided without walking them.
  if (text.length <= MAX_QUESTION_CHARS) return text.length;
  if (text.length > MAX_QUESTION_CHARS * 2) return Number.POSITIVE_INFINITY;
  return Array.from(text).length;
}

/** Reduce the client's body to the one field the api takes: a trimmed, well-formed `question`. */
function parseAskBody(text: string): AskBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'invalid' };
  }
  const raw = (parsed as Record<string, unknown>).question;
  if (typeof raw !== 'string') return { error: 'invalid' };
  const question = raw.trim();
  if (question === '') return { error: 'invalid' };
  // A lone surrogate is valid JSON but cannot be encoded as text; the api would fail on it.
  if (!(question as string & { isWellFormed(): boolean }).isWellFormed()) {
    return { error: 'invalid' };
  }
  if (characterCount(question) > MAX_QUESTION_CHARS) return { error: 'too_long' };
  return { question };
}

/** The media type only: `text/event-stream; charset=utf-8` → `text/event-stream`. */
function mediaType(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** A failure before any frame: still an event stream, so the client's parser sees a terminal frame. */
function unreachableStream(err: unknown): Response {
  const timedOut = err instanceof Error && err.name === 'TimeoutError';
  return new Response(
    sseFrame('error', { error_kind: timedOut ? 'timeout' : 'upstream_unreachable' }),
    { status: 502, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

/**
 * POST /api/v1/conversations/{id}/ask/stream → api POST /v1/conversations/{id}/ask/stream (SSE)
 *
 * Streams the api's frames (`sources` → `token`* → `done`, or a terminal `error`) to the browser
 * unchanged. What the BFF checks first, in order: the id is a UUID (it goes into the upstream
 * path), the content type is JSON, the body is within its size and time cap, and the question is
 * non-empty, well-formed and at most 4000 characters. The question is user content and is never
 * logged.
 *
 * - An api error BEFORE the stream starts (404, 422, 413, 429, 503…) keeps its status; only its
 *   `{ error, trace_id }` are relayed.
 * - An unreachable api, a timeout or a redirect → `502` carrying a terminal `error` frame.
 * - Only a `200` whose media type is `text/event-stream` is streamed; anything else is a `502`.
 * - If the browser disconnects, the upstream request is aborted so the model call can stop.
 *
 * Known gap (web 2.1 must cover it): once headers are sent, a stream that dies midway — an api
 * crash, a reset, the 300 s bound — just ends. The client must treat "ended without `done` or
 * `error`" as a failure and never show that partial answer as complete.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return bff(req, ROUTE_CLASS, async ({ traceId }) => {
    // First, before the body is read: a client over its allowance costs as little as possible.
    const limited = enforceRateLimit(req, 'ask', ROUTE_CLASS, traceId);
    if (limited) return limited;
    const { id } = await context.params;
    if (!isConversationId(id)) return errorResponse('validation_error', 422, traceId);
    if (!isJsonRequest(req)) return errorResponse('unsupported_media_type', 415, traceId);
    const read = await readTextCapped(req, MAX_ASK_BODY_BYTES);
    if (!read.ok) return bodyReadError(read.reason, traceId);
    const body = parseAskBody(read.text);
    if ('error' in body) {
      return body.error === 'too_long'
        ? errorResponse('payload_too_large', 413, traceId)
        : errorResponse('validation_error', 422, traceId); // what the api answers for an empty question
    }
    const conversationId = id.toLowerCase();
    // A slot for this client's streaming answers; every exit below either hands it to the
    // response (released when the body ends, fails or is cancelled) or releases it here.
    const slot = acquireStreamSlot(req, ROUTE_CLASS, traceId);
    if ('limited' in slot) return slot.limited;
    let handedOff = false;
    try {
      log('info', 'bff inbound', { route: ROUTE_CLASS, method: 'POST' });
      if (isMockUpstream()) {
        // One id is reserved to let a UI exercise the "error before the stream" path.
        if (conversationId === NOT_FOUND_CONVERSATION_ID) {
          return mockJson({ error: 'not_found', trace_id: traceId }, traceId, 404);
        }
        const failing = body.question.includes(ASK_MOCK_ERROR_MARKER);
        const wrapped = releaseWhenDone(
          mockSse(failing ? askStreamErrorFrames : askStreamFrames, traceId),
          slot.release,
        );
        handedOff = true;
        return wrapped;
      }

      const url = `${apiBase()}/v1/conversations/${conversationId}/ask/stream`;
      let upstream: Response;
      try {
        log('info', 'bff upstream stream', { route: ROUTE_CLASS, target: 'api' });
        upstream = await streamUpstream(url, traceId, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: body.question }),
          redirect: 'error',
          // The whole-answer bound, plus: stop the model call when the browser goes away.
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]),
        });
      } catch (err) {
        // A browser that left is not an api failure.
        log(req.signal.aborted ? 'info' : 'error', 'bff upstream stream failed', {
          route: ROUTE_CLASS,
          error: err instanceof Error ? err.name : 'error',
        });
        return unreachableStream(err);
      }
      if (!upstream.ok) return relayJsonError(upstream, traceId, ROUTE_CLASS);
      if (
        upstream.status !== 200 ||
        !upstream.body ||
        mediaType(upstream) !== 'text/event-stream'
      ) {
        void upstream.body?.cancel().catch(() => undefined);
        log('error', 'bff upstream reply was not a stream', {
          route: ROUTE_CLASS,
          status: upstream.status,
        });
        return errorResponse('upstream_error', 502, traceId, { target: 'api' });
      }
      const wrapped = releaseWhenDone(proxyStream(upstream, traceId), slot.release);
      handedOff = true;
      return wrapped;
    } finally {
      if (!handedOff) slot.release();
    }
  });
}
