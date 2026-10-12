import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as askStream } from '@/app/api/v1/conversations/[id]/ask/stream/route';
import { hardenResponse } from '@/lib/bff-json';
import { MAX_ASK_BODY_BYTES, MAX_QUESTION_CHARS } from '@/lib/conversation-limits';
import { STREAM_TIMEOUT_MS } from '@/lib/stream';
import { log } from '@/lib/logger';
import { MOCK_HEADER } from '@/lib/mocks';
import { TRACE_HEADER } from '@/lib/trace';
import {
  ASK_MOCK_CITATIONS,
  ASK_MOCK_ERROR_MARKER,
  NOT_FOUND_CONVERSATION_ID,
  TRACE_CONVERSATION_ID,
} from '@/mocks/conversations';

// The logger is spied on to prove a question never reaches a log line.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return { ...actual, log: vi.fn() };
});

const TRACE = /^0eb0[0-9a-f]{28}$/;
const INBOUND = `0eb00${'e'.repeat(27)}`;
const API = 'http://api:8000';
const ID = TRACE_CONVERSATION_ID;
const EMOJI = String.fromCodePoint(0x1f600);

const json = (value: unknown) => JSON.stringify(value);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function ask(
  body: BodyInit | null,
  options: { headers?: Record<string, string>; signal?: AbortSignal; id?: string } = {},
) {
  const { headers = {}, signal, id = ID } = options;
  const request = new Request(`http://web/api/v1/conversations/${id}/ask/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal,
  });
  return askStream(request, ctx(id));
}
const q = (question: unknown) => json({ question });

const noFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called');
  });
const SSE = (text: string, init: ResponseInit = {}) =>
  new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    ...init,
  });
const events = (text: string) =>
  text
    .trim()
    .split('\n\n')
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });

const ENV_KEYS = ['API_BASE_URL', 'MOCK_UPSTREAM', 'APP_ENV'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.API_BASE_URL = API;
  delete process.env.MOCK_UPSTREAM;
  vi.mocked(log).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('mock mode', () => {
  beforeEach(() => {
    process.env.MOCK_UPSTREAM = 'true';
  });

  it('streams sources → tokens → done with title+path citations, marked as a mock', async () => {
    const fetchSpy = noFetch();
    const res = await ask(q('How does trace_id work?'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    expect(res.headers.get(TRACE_HEADER)).toMatch(TRACE);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform'); // not downgraded
    const frames = events(await res.text());
    expect(frames[0].event).toBe('sources');
    expect(frames[0].data.citations).toEqual(ASK_MOCK_CITATIONS);
    expect(frames[0].data.count).toBe(2);
    expect(frames.slice(1, -1).every((f) => f.event === 'token')).toBe(true);
    expect(frames.slice(1, -1).length).toBeGreaterThan(5);
    const answer = frames
      .filter((f) => f.event === 'token')
      .map((f) => f.data.text)
      .join('');
    expect(answer).toContain('trace id is minted by the BFF [1]');
    const last = frames.at(-1)!;
    expect(last.event).toBe('done');
    expect(last.data.citations).toEqual(ASK_MOCK_CITATIONS);
    expect(Object.keys(last.data).sort()).toEqual(['citations', 'input_tokens', 'output_tokens']);
    for (const citation of last.data.citations) {
      expect(Object.keys(citation).sort()).toEqual(['path', 'title']);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ends in a terminal error frame (no done) when the question carries the error marker', async () => {
    const frames = events(await (await ask(q(`why? ${ASK_MOCK_ERROR_MARKER}`))).text());
    expect(frames[0].event).toBe('sources');
    expect(frames.at(-1)).toEqual({ event: 'error', data: { error_kind: 'timeout' } });
    expect(frames.some((f) => f.event === 'done')).toBe(false);
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(1);
  });

  it('accepts any well-formed conversation id (a conversation just created by the mock exists)', async () => {
    const fresh = crypto.randomUUID();
    const res = await ask(q('hi'), { id: fresh });
    expect(res.status).toBe(200);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
  });

  it('is refused in prod and falls through to the real call', async () => {
    process.env.APP_ENV = 'prod';
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => SSE('event: done\ndata: {}\n\n'));
    const res = await ask(q('hi'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.headers.get(MOCK_HEADER)).toBeNull();
  });
});

describe('what the BFF checks before it forwards anything', () => {
  it.each([
    'abc',
    '123',
    '../../etc/passwd',
    '..%2f..%2fadmin',
    `${ID}/../x`,
    `${ID}\n`,
    `${ID}?x=1`,
    `{${ID}}`,
    ID.replaceAll('-', ''),
    '',
  ])('rejects conversation id %j with 422 and never calls the api', async (id) => {
    const fetchSpy = noFetch();
    const res = await ask(q('hi'), { id });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(body.trace_id).toMatch(TRACE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['a form encoding', 'application/x-www-form-urlencoded'],
    ['no content type', ''],
  ])('rejects %s with 415', async (_label, type) => {
    const fetchSpy = noFetch();
    const headers: Record<string, string> = type ? { 'content-type': type } : {};
    const res = await askStream(
      new Request('http://web/x', { method: 'POST', headers, body: q('hi') }),
      ctx(ID),
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_media_type');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty question', q('')],
    ['a blank question', q('  \n\t ')],
    ['a missing question', json({})],
    ['a null question', q(null)],
    ['a numeric question', q(5)],
    ['an array question', q(['a'])],
    ['an array body', json(['hi'])],
    ['a string body', json('hi')],
    ['a null body', 'null'],
    ['an empty body', ''],
    ['malformed JSON', '{"question": "hi'],
    ['a lone surrogate', '{"question":"bad \\ud800 text"}'],
  ])(
    'rejects %s with 422 validation_error, as the api does, and never calls the api',
    async (_label, body) => {
      const fetchSpy = noFetch();
      const res = await ask(body);
      expect(res.status).toBe(422);
      const parsed = await res.json();
      expect(parsed.error).toBe('validation_error');
      expect(parsed.trace_id).toMatch(TRACE);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('counts characters, not UTF-16 units: 4000 emoji pass, one more is 413', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    expect(EMOJI.repeat(MAX_QUESTION_CHARS).length).toBe(MAX_QUESTION_CHARS * 2); // 8000 units
    expect((await ask(q(EMOJI.repeat(MAX_QUESTION_CHARS)))).status).toBe(200);
    expect((await ask(q('x'.repeat(MAX_QUESTION_CHARS)))).status).toBe(200);
    const fetchSpy = noFetch();
    const res = await ask(q('x'.repeat(MAX_QUESTION_CHARS + 1)));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('payload_too_large');
    expect((await ask(q(EMOJI.repeat(MAX_QUESTION_CHARS + 1)))).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trims the question before it counts it', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    expect((await ask(q(`  ${'x'.repeat(MAX_QUESTION_CHARS)}  `))).status).toBe(200);
  });

  it('rejects an oversized body with 413, declared or streamed', async () => {
    const fetchSpy = noFetch();
    const big = json({ question: 'hi', pad: 'y'.repeat(MAX_ASK_BODY_BYTES) });
    const streamed = await ask(big);
    expect(streamed.status).toBe(413);
    expect((await streamed.json()).error).toBe('payload_too_large');
    expect((await ask(q('hi'), { headers: { 'content-length': '9999999' } })).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('real mode: forwarding', () => {
  it('POSTs {question} to the api with the same trace id, then relays the stream byte for byte', async () => {
    const stream =
      'event: sources\ndata: {"citations":[{"title":"A","path":"docs/a.md"}],"count":1}\n\n' +
      'event: token\ndata: {"text":"hi "}\n\n' +
      'event: done\ndata: {"citations":[{"title":"A","path":"docs/a.md"}],"input_tokens":3,"output_tokens":1}\n\n';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE(stream));
    const upper = ID.toUpperCase();
    const res = await ask(q('  What is a trace id?  '), {
      id: upper,
      headers: { [TRACE_HEADER]: INBOUND },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get(TRACE_HEADER)).toBe(INBOUND);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get(MOCK_HEADER)).toBeNull();
    await expect(res.text()).resolves.toBe(stream);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${API}/v1/conversations/${ID}/ask/stream`);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get(TRACE_HEADER)).toBe(INBOUND);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'What is a trace id?' });
    expect(init?.redirect).toBe('error');
  });

  it('forwards only the question, never other fields', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE(''));
    await ask('{"question":"hi","conversation_id":"x","__proto__":{"admin":true},"top_k":9999}');
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ question: 'hi' });
  });

  it('aborts the upstream request when the browser disconnects, so the model call can stop', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE(''));
    const browser = new AbortController();
    await ask(q('hi'), { signal: browser.signal });
    const upstreamSignal = spy.mock.calls[0][1]?.signal as AbortSignal;
    expect(upstreamSignal.aborted).toBe(false);
    browser.abort();
    expect(upstreamSignal.aborted).toBe(true);
  });

  it('relays an error frame from the api exactly as sent', async () => {
    const stream =
      'event: sources\ndata: {"citations":[],"count":0}\n\n' +
      'event: error\ndata: {"error_kind":"timeout"}\n\n';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE(stream));
    const res = await ask(q('hi'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(stream);
  });
});

describe('real mode: failures', () => {
  it.each([
    [404, { error: 'not_found', trace_id: INBOUND }],
    [422, { error: 'validation_error', trace_id: INBOUND }],
    [413, { error: 'payload_too_large', trace_id: INBOUND }],
    [503, { error: 'ai_unavailable', trace_id: INBOUND }],
    [500, { error: 'internal_error', trace_id: INBOUND }],
  ])("passes the api's pre-stream %i through with its JSON body", async (status, body) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }));
    const res = await ask(q('hi'));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(body);
    expect(res.headers.get(TRACE_HEADER)).toMatch(TRACE);
  });

  it('turns a non-JSON api error into 502 upstream_error without relaying its body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('<html>internal detail</html>', { status: 502 }),
    );
    const res = await ask(q('hi'));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'upstream_error', target: 'api' });
    expect(text).not.toContain('internal detail');
  });

  it('refuses a 200 that is not an event stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true }));
    const res = await ask(q('hi'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_error');
  });

  it('turns an unreachable api into a 502 carrying a terminal error frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await ask(q('hi'), { headers: { [TRACE_HEADER]: INBOUND } });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get(TRACE_HEADER)).toBe(INBOUND);
    expect(events(await res.text())).toEqual([
      { event: 'error', data: { error_kind: 'upstream_unreachable' } },
    ]);
  });

  it('names a deadline hit while connecting as a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    );
    const res = await ask(q('hi'));
    expect(res.status).toBe(502);
    expect(events(await res.text())[0].data.error_kind).toBe('timeout');
  });
});

describe('cross-cutting', () => {
  it('echoes the inbound trace id on success and on every kind of error', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const headers = { [TRACE_HEADER]: INBOUND };
    const responses = await Promise.all([
      ask(q('hi'), { headers }),
      ask(q(''), { headers }),
      ask(q('hi'), { headers, id: 'nope' }),
      ask(q('x'.repeat(MAX_QUESTION_CHARS + 1)), { headers }),
    ]);
    expect(responses.map((r) => r.headers.get(TRACE_HEADER))).toEqual(Array(4).fill(INBOUND));
  });

  it('sends nosniff on JSON errors and keeps the stream cache header on streams', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const error = await ask(q(''));
    expect(error.headers.get('cache-control')).toBe('no-store');
    expect(error.headers.get('x-content-type-options')).toBe('nosniff');
    const stream = await ask(q('hi'));
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
  });

  it('never logs a question or any of its text', async () => {
    const secret = 'QUESTION-SENTINEL-4711';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE('event: done\ndata: {}\n\n'));
    await ask(q(secret));
    await ask(q(secret), { id: 'bad' });
    process.env.MOCK_UPSTREAM = 'true';
    await ask(q(secret));
    expect(vi.mocked(log).mock.calls.length).toBeGreaterThan(0); // it did log something ...
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(secret); // ... but no content
  });
});

describe('review follow-ups', () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  const BACKSLASH = String.fromCharCode(92);

  it('relays frames as they arrive instead of buffering the whole stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let upstreamCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      SSE(upstreamBody as unknown as string),
    );
    const res = await ask(q('hi'));
    const reader = res.body!.getReader();

    controller.enqueue(encode('event: sources\ndata: {"citations":[],"count":0}\n\n'));
    expect(decode((await reader.read()).value)).toContain('event: sources'); // before the stream ends
    controller.enqueue(encode('event: token\ndata: {"text":"hi"}\n\n'));
    expect(decode((await reader.read()).value)).toContain('event: token');

    await reader.cancel(); // the browser closes the stream ...
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upstreamCancelled).toBe(true); // ... and so does the upstream body
  });

  it('accepts 4000 astral characters even when every one is \\u-escaped (the 64 KB cap leaves room)', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const pair = BACKSLASH + 'ud83d' + BACKSLASH + 'ude00'; // the 12-byte JSON escape of one emoji
    const body = (count: number) => '{"question":"' + pair.repeat(count) + '"}';
    expect(new TextEncoder().encode(body(4000)).byteLength).toBeLessThan(MAX_ASK_BODY_BYTES);
    expect((await ask(body(4000))).status).toBe(200);
    expect((await ask(body(4001))).status).toBe(413);
  });

  it('decides an ASCII question over twice the limit without counting code points', async () => {
    const fetchSpy = noFetch();
    const res = await ask(q('x'.repeat(MAX_QUESTION_CHARS * 2 + 1)));
    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a JSON content type with a charset parameter', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const res = await ask(q('hi'), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(res.status).toBe(200);
  });

  it('bounds the upstream request by the whole-answer timeout as well as by the browser', async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => SSE(''));
    await ask(q('hi'));
    expect(timeoutSpy).toHaveBeenCalledWith(STREAM_TIMEOUT_MS);
    const upstreamSignal = spy.mock.calls[0][1]?.signal as AbortSignal;
    expect(upstreamSignal.aborted).toBe(false);
    deadline.abort(new DOMException('The operation timed out', 'TimeoutError'));
    expect(upstreamSignal.aborted).toBe(true);
  });

  it.each([
    ['a 201', 201, 'text/event-stream'],
    ['a 206', 206, 'text/event-stream'],
    ['a look-alike media type', 200, 'text/event-streamx'],
    ['text/html', 200, 'text/html'],
    ['no content type', 200, ''],
  ])('refuses %s as a stream with 502 upstream_error', async (_label, status, type) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('event: done\ndata: {}\n\n', {
          status,
          headers: type ? { 'content-type': type } : {},
        }),
    );
    const res = await ask(q('hi'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_error');
  });

  it.each([
    ['429 rate_limited (the api stream cap)', 429, 'rate_limited'],
    ['413 payload_too_large (the api body or question limit)', 413, 'payload_too_large'],
    ['503 ai_unavailable', 503, 'ai_unavailable'],
    ['404 not_found', 404, 'not_found'],
    ['422 validation_error', 422, 'validation_error'],
  ])("passes the api's %s through with its status and code", async (_label, status, code) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: code, trace_id: INBOUND }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = await ask(q('hi'), { headers: { [TRACE_HEADER]: INBOUND } });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, trace_id: INBOUND });
  });

  it("answers an invalid question with exactly the api's error shape", async () => {
    noFetch();
    const res = await ask(q(''));
    expect(res.status).toBe(422);
    expect(Object.keys(await res.json()).sort()).toEqual(['error', 'trace_id']);
  });

  it('relays only error and trace_id from an api error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        {
          error: 'ai_unavailable',
          trace_id: INBOUND,
          stack: 'at secret.py:1',
          echo: { question: 'x' },
        },
        { status: 503 },
      ),
    );
    const res = await ask(q('hi'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable', trace_id: INBOUND });
  });

  it.each([
    ['a FastAPI default body', { detail: 'Not Found' }],
    ['an error that is not a snake_case code', { error: 'Not Found!', trace_id: INBOUND }],
    ['a numeric error', { error: 404 }],
    ['an array', ['x']],
    ['a bare string', 'oops'],
  ])('turns %s into 502 upstream_error', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(body, { status: 404 }),
    );
    const res = await ask(q('hi'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_error');
  });

  it("replaces an api trace id that is not a trace id with this request's", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'not_found', trace_id: '<script>' }, { status: 404 }),
    );
    const res = await ask(q('hi'), { headers: { [TRACE_HEADER]: INBOUND } });
    expect(await res.json()).toEqual({ error: 'not_found', trace_id: INBOUND });
  });

  it('answers 404 in mock mode for the reserved id, with no stream', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const res = await ask(q('hi'), { id: NOT_FOUND_CONVERSATION_ID });
    expect(res.status).toBe(404);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    expect((await res.json()).error).toBe('not_found');
  });
});

describe('hardenResponse', () => {
  const stream = (headers: Record<string, string> = {}) =>
    new Response('', { headers: { 'content-type': 'text/event-stream', ...headers } });

  it('forces no-store on JSON even when the response already said it is cacheable', () => {
    const res = hardenResponse(
      Response.json({}, { headers: { 'cache-control': 'public, max-age=3600' } }),
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it("keeps a stream's own no-cache, no-transform", () => {
    const res = hardenResponse(stream({ 'cache-control': 'no-cache, no-transform' }));
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
  });

  it('gives a stream with no cache-control no-store', () => {
    expect(hardenResponse(stream()).headers.get('cache-control')).toBe('no-store');
  });

  it('adds nosniff to everything', () => {
    expect(hardenResponse(stream()).headers.get('x-content-type-options')).toBe('nosniff');
  });
});
