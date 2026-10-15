import { readSseStream } from '@/lib/sse';

/**
 * Browser-side client for a streamed assistant answer (same-origin BFF only — the BFF rule).
 * Framework-free so it is unit-tested in the node environment; components wrap it.
 *
 * Everything that comes back is untrusted TEXT: titles and paths are document content and error
 * codes are checked against a strict pattern before they are handed on. Callers must render them
 * as plain text (never as HTML or as a link target).
 */

/** A source the answer drew on: the document's title and its path. */
export interface Citation {
  title: string;
  path: string;
}

/** Why a request failed. `traceId` lets a person paste one id into the logs. */
export interface StreamError {
  /** A short snake_case code (`not_found`, `timeout`, `upstream_unreachable`, `stream_ended`…). */
  code: string;
  /** The request's trace id, when the server sent a valid one. */
  traceId?: string;
}

export interface StreamHandlers {
  onSources?: (citations: Citation[]) => void;
  onToken: (text: string) => void;
  onDone?: (info: {
    citations: Citation[];
    inputTokens?: number | null;
    outputTokens?: number | null;
  }) => void;
  onError: (error: StreamError) => void;
}

export interface AskStreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_CITATIONS = 50;
const MAX_FIELD_CHARS = 500;
const MAX_ERROR_BODY_BYTES = 4096;
const MAX_ERROR_EVENTS = 20;
/**
 * Characters that draw nothing or reorder text: C0/C1 controls, soft hyphen, Arabic letter mark,
 * Mongolian vowel separator, zero-width and bidi marks/overrides/isolates, line/paragraph
 * separators, word joiner, BOM, interlinear annotation marks and the invisible tag characters.
 * Built from code points so the source stays readable.
 */
const INVISIBLE_RANGES: [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => String.fromCodePoint(a) + '-' + String.fromCodePoint(b)).join('')}]`,
  'gu',
);
// A same-origin path only: one leading slash (not `//host`), no scheme, no whitespace.
const SAME_ORIGIN_PATH = /^\/(?!\/)\S*$/;

function validTrace(value: unknown): string | undefined {
  return typeof value === 'string' && TRACE_ID.test(value) ? value : undefined;
}

function validCode(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : undefined;
}

function clean(text: string): string {
  return text.replace(INVISIBLE, '');
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) : text;
}

/**
 * Stored or server text made safe to render: control, zero-width and bidi-override characters
 * stripped, then cut to `max` characters. Still TEXT — never HTML.
 */
export function sanitizeText(text: string, max: number = MAX_FIELD_CHARS): string {
  const safe = clean(text);
  return safe.length > max ? safe.slice(0, max) : safe;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The citations of a `sources` or `done` frame, made safe to render: only well-formed entries
 * (a non-empty string `path`; a missing title falls back to the file name), at most 50 of them,
 * each field at most 500 characters. A malformed value gives `[]`, never an exception.
 */
export function parseCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const citations: Citation[] = [];
  for (const item of value) {
    if (citations.length >= MAX_CITATIONS) break;
    if (item === null || typeof item !== 'object') continue;
    const { title, path } = item as Record<string, unknown>;
    if (typeof path !== 'string') continue;
    const safePath = clip(clean(path));
    if (safePath === '') continue;
    const safeTitle = typeof title === 'string' ? clip(clean(title)).trim() : '';
    citations.push({ title: safeTitle || fileName(safePath), path: safePath });
  }
  return citations;
}

/** Read at most `maxBytes` of a body as text; `null` when it is longer (the rest is dropped). */
export async function readBoundedText(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * What went wrong BEFORE the stream started: the api's own `{ error, trace_id }` JSON (relayed by
 * the BFF), or the `error` frame in the BFF's `502` event-stream body (api unreachable). The
 * trace id comes from the body, else the `x-trace-id` header. Anything unreadable falls back to
 * a code by status class — callers should key on the class, not the exact code.
 */
export async function readFailure(res: Response): Promise<StreamError> {
  const headerTrace = validTrace(res.headers.get('x-trace-id'));
  const byClass = res.status >= 500 ? 'upstream_error' : 'request_rejected';
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  try {
    if (type === 'text/event-stream' && res.body) {
      let seen = 0;
      for await (const event of readSseStream(res.body)) {
        if (++seen > MAX_ERROR_EVENTS) break; // an error body is one frame; do not read an endless one
        if (event.event !== 'error') continue;
        const data = JSON.parse(event.data) as Record<string, unknown>;
        return { code: validCode(data.error_kind) ?? byClass, traceId: headerTrace };
      }
      return { code: byClass, traceId: headerTrace };
    }
    if (type === 'application/json' && res.body) {
      const text = await readBoundedText(res.body, MAX_ERROR_BODY_BYTES);
      if (text === null) return { code: byClass, traceId: headerTrace };
      const body = JSON.parse(text) as Record<string, unknown> | null;
      return {
        code: validCode(body?.error) ?? byClass,
        traceId: validTrace(body?.trace_id) ?? headerTrace,
      };
    }
  } catch {
    // unreadable body: fall through to the class code
  }
  void res.body?.cancel().catch(() => undefined);
  return { code: byClass, traceId: headerTrace };
}

/**
 * POST `{ question }` to a same-origin SSE route and dispatch its events.
 * Resolves when the stream ends; EVERY failure path calls `onError` exactly once, and a stream
 * that ends without a `done` or `error` frame is a failure (`stream_ended`) — a cut-off answer
 * is never reported as complete.
 */
export async function askStream(
  endpoint: string,
  question: string,
  handlers: StreamHandlers,
  options: AskStreamOptions = {},
): Promise<void> {
  if (!SAME_ORIGIN_PATH.test(endpoint)) {
    // The BFF rule: the browser only ever calls a same-origin route, never another host.
    handlers.onError({ code: 'bad_endpoint' });
    return;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question }),
      signal: options.signal,
    });
  } catch (err) {
    handlers.onError({ code: (err as Error)?.name === 'AbortError' ? 'aborted' : 'network_error' });
    return;
  }
  if (!res.ok) {
    handlers.onError(await readFailure(res));
    return;
  }
  const traceId = validTrace(res.headers.get('x-trace-id'));
  if (!res.body) {
    handlers.onError({ code: 'upstream_error', traceId });
    return;
  }
  let citations: Citation[] = [];
  try {
    for await (const event of readSseStream(res.body)) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue; // a malformed frame is skipped, never fatal
      }
      switch (event.event) {
        case 'sources':
          citations = parseCitations(data.citations);
          handlers.onSources?.(citations);
          break;
        case 'token':
          if (typeof data.text === 'string') handlers.onToken(data.text);
          break;
        case 'done':
          handlers.onDone?.({
            citations: Array.isArray(data.citations) ? parseCitations(data.citations) : citations,
            inputTokens: (data.input_tokens as number | null | undefined) ?? null,
            outputTokens: (data.output_tokens as number | null | undefined) ?? null,
          });
          return;
        case 'error':
          handlers.onError({ code: validCode(data.error_kind) ?? 'error', traceId });
          return;
        default:
          break;
      }
    }
    // The stream closed with neither `done` nor `error`: the answer was cut off.
    handlers.onError({ code: 'stream_ended', traceId });
  } catch (err) {
    handlers.onError({
      code: (err as Error)?.name === 'AbortError' ? 'aborted' : 'stream_error',
      traceId,
    });
  } finally {
    // Done with the body (a terminal frame, a failure, or the end): free the connection.
    void res.body?.cancel().catch(() => undefined);
  }
}
