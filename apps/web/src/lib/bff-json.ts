import { log } from '@/lib/logger';
import { BODY_READ_TIMEOUT_MS } from '@/lib/conversation-limits';
import { type BffContext, fetchUpstream, withBff } from '@/lib/trace';

/** The api's base URL — server-side env only (the BFF rule), never `NEXT_PUBLIC_*`. */
export function apiBase(): string {
  return (process.env.API_BASE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
}

/**
 * Headers every response of these routes carries. The payloads are shared user content, so a
 * browser or an intermediary must never cache them, and a browser must not sniff them into
 * something other than JSON.
 */
export function hardenResponse(res: Response): Response {
  res.headers.set('cache-control', 'no-store');
  res.headers.set('x-content-type-options', 'nosniff');
  return res;
}

/** `withBff` plus `hardenResponse` on whatever the handler returns (success or error). */
export function bff(
  req: Request,
  routeClass: string,
  handler: (ctx: BffContext) => Promise<Response> | Response,
): Promise<Response> {
  return withBff(req, async (ctx) => hardenResponse(await handler(ctx)), { routeClass });
}

/**
 * The one error shape every response of this BFF uses, matching the api's contract
 * (`{ error, trace_id }`), so the UI handles an api error and a BFF error the same way.
 */
export function errorResponse(
  error: string,
  status: number,
  traceId: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error, ...extra, trace_id: traceId }, { status });
}

function isTimeoutOrAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Forward a JSON request to the api and pass its status and JSON body through unchanged — so a
 * `404 not_found` or `422 validation_error` reaches the UI exactly as the api sent it.
 *
 * - An unreachable api, a timeout (while connecting OR while reading the reply) or a redirect
 *   becomes `502 upstream_unreachable`. Redirects are refused: only the configured api is called.
 * - A reply that is not JSON (a proxy error page, an empty `204`) becomes `502 upstream_error`;
 *   its body is never relayed. No upstream header is relayed either.
 *
 * `route` is a bounded label for the log line. Request and response bodies are user content and
 * are never logged.
 */
export async function proxyJson(
  url: string,
  traceId: string,
  init: RequestInit,
  route: string,
): Promise<Response> {
  const unreachable = (err: unknown): Response => {
    log('error', 'bff upstream failed', {
      route,
      error: err instanceof Error ? err.name : 'error',
    });
    return errorResponse('upstream_unreachable', 502, traceId, { target: 'api' });
  };
  let res: Response;
  let body: unknown;
  try {
    log('info', 'bff upstream call', { route, target: 'api' });
    res = await fetchUpstream(url, traceId, { ...init, redirect: 'error' });
  } catch (err) {
    return unreachable(err);
  }
  try {
    body = await res.json();
  } catch (err) {
    if (isTimeoutOrAbort(err)) return unreachable(err); // the deadline hit while reading the body
    log('error', 'bff upstream reply was not json', { route, status: res.status });
    return errorResponse('upstream_error', 502, traceId, { target: 'api' });
  }
  log('info', 'bff upstream ok', { route, status: res.status });
  return Response.json(body, { status: res.status });
}

export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'timeout' | 'aborted' };

/**
 * Read a request body as text, giving up as soon as it exceeds `maxBytes` or takes longer than
 * `timeoutMs` (a client trickling bytes must not hold a handler). A hostile or accidental
 * megabyte body is never buffered in full.
 */
export async function readTextCapped(
  req: Request,
  maxBytes: number,
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout') {
        void reader.cancel().catch(() => undefined); // do not wait on a stalled stream
        return { ok: false, reason: 'timeout' };
      }
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: 'aborted' }; // the client dropped the upload
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}
