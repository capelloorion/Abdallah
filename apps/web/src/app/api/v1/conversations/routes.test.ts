import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as getOne } from '@/app/api/v1/conversations/[id]/route';
import { GET as list, POST as create } from '@/app/api/v1/conversations/route';
import { readTextCapped } from '@/lib/bff-json';
import { MAX_CREATE_BODY_BYTES } from '@/lib/conversation-limits';
import { log } from '@/lib/logger';
import { MOCK_HEADER } from '@/lib/mocks';
import { TRACE_HEADER } from '@/lib/trace';
import {
  EMPTY_CONVERSATION_ID,
  TRACE_CONVERSATION_ID,
  conversationFixtures,
} from '@/mocks/conversations';

// The logger is spied on to prove user content (titles) never reaches a log line.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return { ...actual, log: vi.fn() };
});

const TRACE = /^0eb0[0-9a-f]{28}$/;
const INBOUND = `0eb00${'d'.repeat(27)}`;
const API = 'http://api:8000';

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://web${path}`, { method: 'GET', headers });
}
function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('http://web/api/v1/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}
const json = (value: unknown) => JSON.stringify(value);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const noFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called');
  });
const upstreamBody = (spy: ReturnType<typeof vi.spyOn>) =>
  JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));

const ENV_KEYS = ['API_BASE_URL', 'MOCK_UPSTREAM', 'APP_ENV'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  __resetRateLimitForTests();
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

describe('GET /api/v1/conversations', () => {
  it('serves the list fixture in mock mode, newest first, marked as a mock', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const fetchSpy = noFetch();
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(200);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    expect(res.headers.get(TRACE_HEADER)).toMatch(TRACE);
    const body = await res.json();
    expect(body.count).toBe(conversationFixtures.length);
    expect(body.items[0].id).toBe(TRACE_CONVERSATION_ID); // newest updated_at first
    expect(Object.keys(body.items[0]).sort()).toEqual(['id', 'title', 'updated_at']);
    const times = body.items.map((i: { updated_at: string }) => i.updated_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cuts the mock list to ?limit', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const body = await (await list(get('/api/v1/conversations?limit=1'))).json();
    expect(body.count).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(TRACE_CONVERSATION_ID); // the newest one is kept
  });

  it.each(['0', '101', '-1', 'abc', '1.5', '', '1000', '1e2', ' 5'])(
    'rejects limit=%j locally with 422 and never calls the api',
    async (limit) => {
      const fetchSpy = noFetch();
      const res = await list(get(`/api/v1/conversations?limit=${encodeURIComponent(limit)}`));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('validation_error');
      expect(body.trace_id).toMatch(TRACE);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['1', '1'],
    ['50', '50'],
    ['100', '100'],
    ['007', '7'],
  ])('accepts limit=%s and forwards %s', async (limit, forwarded) => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ items: [], count: 0 }));
    expect((await list(get(`/api/v1/conversations?limit=${limit}`))).status).toBe(200);
    expect(spy.mock.calls[0][0]).toBe(`${API}/v1/conversations?limit=${forwarded}`);
  });

  it('takes the first limit when it is repeated and still validates it', async () => {
    noFetch();
    expect((await list(get('/api/v1/conversations?limit=500&limit=5'))).status).toBe(422);
    expect((await list(get('/api/v1/conversations?limit=５'))).status).toBe(422); // full-width digit
  });

  it('proxies to api GET /v1/conversations with the same x-trace-id', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ items: [], count: 0 }));
    const res = await list(get('/api/v1/conversations', { [TRACE_HEADER]: INBOUND }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], count: 0 });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${API}/v1/conversations`);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get(TRACE_HEADER)).toBe(INBOUND);
    expect(res.headers.get(TRACE_HEADER)).toBe(INBOUND);
    expect(res.headers.get(MOCK_HEADER)).toBeNull();
  });

  it('forwards a valid limit, normalised, and nothing else from the query', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ items: [], count: 0 }));
    await list(get('/api/v1/conversations?limit=007&evil=../../x'));
    expect(spy.mock.calls[0][0]).toBe(`${API}/v1/conversations?limit=7`);
  });

  it("passes the api's status and error body through unchanged", async () => {
    const apiError = { error: 'validation_error', trace_id: INBOUND };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(apiError, { status: 422 }));
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(apiError);
  });

  it('passes an api 500 through with its error body', async () => {
    const apiError = { error: 'internal_error', trace_id: INBOUND };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(apiError, { status: 500 }));
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(apiError);
  });

  it('returns 502 upstream_unreachable with trace_id when the api is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'upstream_unreachable', target: 'api' });
    expect(body.trace_id).toMatch(TRACE);
    expect(res.headers.get(TRACE_HEADER)).toBe(body.trace_id);
  });

  it('returns 502 upstream_error when the api answers with something that is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Bad gateway: internal detail</html>', { status: 502 }),
    );
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'upstream_error', target: 'api' });
    expect(text).not.toContain('internal detail'); // the upstream body is never relayed
  });
});

describe('POST /api/v1/conversations', () => {
  it('returns a fresh conversation in mock mode with 201, marked as a mock', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const fetchSpy = noFetch();
    const res = await create(post(json({ title: 'Trace ids' })));
    expect(res.status).toBe(201);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'title', 'updated_at']);
    expect(body.title).toBe('Trace ids');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.created_at).toBe(body.updated_at);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [''],
    [json({})],
    [json(null)],
    [json({ title: null })],
    [json({ title: '  ' })],
  ])('uses the default title in mock mode for body %j', async (body) => {
    process.env.MOCK_UPSTREAM = 'true';
    const res = await create(post(body));
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe('New conversation');
  });

  it('gives every mock conversation a new id', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const a = await (await create(post(null))).json();
    const b = await (await create(post(null))).json();
    expect(a.id).not.toBe(b.id);
  });

  it('proxies POST with only a trimmed title, dropping unknown fields', async () => {
    const created = { id: 'x', title: 'Trace ids', created_at: 't', updated_at: 't' };
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(created, { status: 201 }));
    const res = await create(
      post(json({ title: '  Trace ids  ', id: 'forced', owner: 'me', title2: 'x' }), {
        [TRACE_HEADER]: INBOUND,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${API}/v1/conversations`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init?.headers).get(TRACE_HEADER)).toBe(INBOUND);
    expect(upstreamBody(spy)).toEqual({ title: 'Trace ids' });
  });

  it.each([[null], [''], [json(null)], [json({ title: '   ' })], [json({ title: null })]])(
    'forwards an empty object for body %j so the api applies its default',
    async (body) => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({}, { status: 201 }));
      expect((await create(post(body))).status).toBe(201);
      expect(upstreamBody(spy)).toEqual({});
    },
  );

  it('accepts a title of exactly 200 UTF-16 code units, including 100 emoji', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({}, { status: 201 })); // a fresh body per call
    expect((await create(post(json({ title: 'x'.repeat(200) })))).status).toBe(201);
    const emoji = String.fromCodePoint(0x1f600).repeat(100); // 100 characters, 200 UTF-16 units
    expect((await create(post(json({ title: emoji })))).status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['201 characters', json({ title: 'x'.repeat(201) })],
    ['101 emoji (202 UTF-16 units)', json({ title: String.fromCodePoint(0x1f600).repeat(101) })],
    ['a number', json({ title: 123 })],
    ['an array', json({ title: ['a'] })],
    ['an object', json({ title: { a: 1 } })],
    ['a JSON array body', json(['title'])],
    ['a JSON string body', json('title')],
    ['malformed JSON', '{not json'],
    ['truncated JSON', '{"title": "a'],
  ])('rejects %s with 422 and never calls the api', async (_label, body) => {
    const fetchSpy = noFetch();
    const res = await create(post(body));
    expect(res.status).toBe(422);
    const parsed = await res.json();
    expect(parsed.error).toBe('validation_error');
    expect(parsed.trace_id).toMatch(TRACE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized body with 413, whether or not content-length is declared', async () => {
    const fetchSpy = noFetch();
    const big = json({ title: 'x', pad: 'y'.repeat(MAX_CREATE_BODY_BYTES) });
    const streamed = await create(post(big)); // no content-length header: read is capped
    expect(streamed.status).toBe(413);
    expect((await streamed.json()).error).toBe('payload_too_large');
    const declared = await create(post(json({}), { 'content-length': '999999' }));
    expect(declared.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a body right at the limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 201 }));
    const exact = ' '.repeat(MAX_CREATE_BODY_BYTES - 2) + '{}';
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_CREATE_BODY_BYTES);
    expect((await create(post(exact))).status).toBe(201);
  });

  it("passes the api's error status and body through", async () => {
    const apiError = { error: 'validation_error', trace_id: INBOUND };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(apiError, { status: 422 }));
    const res = await create(post(json({ title: 'ok' })));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(apiError);
  });

  it('returns 502 with trace_id when the api is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await create(post(json({ title: 'ok' })));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unreachable');
  });
});

describe('GET /api/v1/conversations/{id}', () => {
  it('serves a fixture with messages and citations in mock mode', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const fetchSpy = noFetch();
    const res = await getOne(
      get(`/api/v1/conversations/${TRACE_CONVERSATION_ID}`),
      ctx(TRACE_CONVERSATION_ID),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    const body = await res.json();
    expect(body.id).toBe(TRACE_CONVERSATION_ID);
    expect(body.truncated).toBe(false);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[1].citations).toEqual([
      { title: 'Tracing', path: 'docs/architecture/tracing.md' },
      { title: 'The observability contract', path: '.claude/rules/60-observability.md' },
    ]);
    expect(body.messages[0].citations).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a conversation with no messages, and matches ids case-insensitively', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const upper = EMPTY_CONVERSATION_ID.toUpperCase();
    const res = await getOne(get(`/api/v1/conversations/${upper}`), ctx(upper));
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([]);
  });

  it('answers 404 not_found with trace_id for an unknown id in mock mode', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const id = '00000000-0000-4000-8000-000000000000';
    const res = await getOne(get(`/api/v1/conversations/${id}`), ctx(id));
    expect(res.status).toBe(404);
    expect(res.headers.get(MOCK_HEADER)).toBe('true');
    const body = await res.json();
    expect(body.error).toBe('not_found');
    expect(body.trace_id).toBe(res.headers.get(TRACE_HEADER));
  });

  it.each([
    'abc',
    '123',
    '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a5', // one character short
    '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a511', // one character long
    '../../etc/passwd',
    '..%2f..%2fadmin',
    `${TRACE_CONVERSATION_ID}/../x`,
    `${TRACE_CONVERSATION_ID}?x=1`,
    'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
    '',
  ])('rejects id %j with 422 before it can reach an upstream URL', async (id) => {
    const fetchSpy = noFetch();
    const res = await getOne(get('/api/v1/conversations/x'), ctx(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(body.trace_id).toMatch(TRACE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('proxies to api GET /v1/conversations/{id} with a lower-cased id and the same trace id', async () => {
    const detail = { id: TRACE_CONVERSATION_ID, messages: [], truncated: false };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(detail));
    const upper = TRACE_CONVERSATION_ID.toUpperCase();
    const res = await getOne(
      get(`/api/v1/conversations/${upper}`, { [TRACE_HEADER]: INBOUND }),
      ctx(upper),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${API}/v1/conversations/${TRACE_CONVERSATION_ID}`);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get(TRACE_HEADER)).toBe(INBOUND);
    expect(res.headers.get(TRACE_HEADER)).toBe(INBOUND);
  });

  it("passes the api's 404 through unchanged", async () => {
    const apiError = { error: 'not_found', trace_id: INBOUND };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(apiError, { status: 404 }));
    const res = await getOne(
      get(`/api/v1/conversations/${TRACE_CONVERSATION_ID}`),
      ctx(TRACE_CONVERSATION_ID),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(apiError);
  });

  it('returns 502 with trace_id when the api is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await getOne(
      get(`/api/v1/conversations/${TRACE_CONVERSATION_ID}`),
      ctx(TRACE_CONVERSATION_ID),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unreachable');
  });
});

describe('cross-cutting', () => {
  it('echoes the inbound x-trace-id on every route, success or error', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const headers = { [TRACE_HEADER]: INBOUND };
    const responses = await Promise.all([
      list(get('/api/v1/conversations', headers)),
      list(get('/api/v1/conversations?limit=0', headers)),
      create(post(null, headers)),
      create(post('{bad', headers)),
      getOne(get('/x', headers), ctx(TRACE_CONVERSATION_ID)),
      getOne(get('/x', headers), ctx('nope')),
    ]);
    expect(responses.map((r) => r.headers.get(TRACE_HEADER))).toEqual(Array(6).fill(INBOUND));
  });

  it('refuses mock mode in prod and falls through to the real call', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    process.env.APP_ENV = 'prod';
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ items: [], count: 0 }));
    const res = await list(get('/api/v1/conversations'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.headers.get(MOCK_HEADER)).toBeNull();
  });

  it('never logs a title or any request or response content', async () => {
    const secret = 'TITLE-SENTINEL-4711';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ id: 'x', title: secret, created_at: 't', updated_at: 't' }),
    );
    await create(post(json({ title: secret })));
    process.env.MOCK_UPSTREAM = 'true';
    await create(post(json({ title: secret })));
    await list(get('/api/v1/conversations'));
    await getOne(get('/x'), ctx(TRACE_CONVERSATION_ID));
    expect(vi.mocked(log).mock.calls.length).toBeGreaterThan(0); // it did log something ...
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(secret); // ... but not content
  });
});

describe('hardening from review', () => {
  it('sends no-store and nosniff on every kind of response', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    const mock = await list(get('/api/v1/conversations'));
    const invalid = await list(get('/api/v1/conversations?limit=0'));
    delete process.env.MOCK_UPSTREAM;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ items: [], count: 0 }),
    );
    const proxied = await list(get('/api/v1/conversations'));
    for (const res of [mock, invalid, proxied]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('relays no upstream header (no set-cookie, no server) to the browser', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        { items: [], count: 0 },
        { headers: { 'set-cookie': 'sid=1', server: 'uvicorn', 'x-internal': 'yes' } },
      ),
    );
    const res = await list(get('/api/v1/conversations'));
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
  });

  it('refuses to follow an upstream redirect', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ items: [], count: 0 }));
    await list(get('/api/v1/conversations'));
    expect(spy.mock.calls[0][1]?.redirect).toBe('error');
    spy.mockRejectedValue(new TypeError('redirect mode is set to error'));
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unreachable');
  });

  it('maps a deadline hit while READING the reply to upstream_unreachable, not upstream_error', async () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');
    const slow = {
      json: async () => {
        throw timeout;
      },
      status: 200,
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(slow);
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unreachable');
  });

  it.each([
    ['a 200 with a body that is not JSON', () => new Response('plain text', { status: 200 })],
    ['a 204 with no body', () => new Response(null, { status: 204 })],
    ['a 200 with an empty body', () => new Response('', { status: 200 })],
  ])('turns %s into 502 upstream_error', async (_label, make) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => make());
    const res = await list(get('/api/v1/conversations'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_error');
  });

  it('tolerates a trailing slash in API_BASE_URL', async () => {
    process.env.API_BASE_URL = `${API}/`;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ items: [], count: 0 }));
    await list(get('/api/v1/conversations'));
    expect(spy.mock.calls[0][0]).toBe(`${API}/v1/conversations`);
  });
});

describe('POST content type and body hygiene', () => {
  it.each([
    ['text/plain', 'text/plain'],
    ['a form encoding', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['a JSON look-alike', 'application/jsonp'],
    ['no content type at all', ''],
  ])('rejects %s with 415 and never calls the api', async (_label, type) => {
    const fetchSpy = noFetch();
    const headers: Record<string, string> = type ? { 'content-type': type } : {};
    const res = await create(
      new Request('http://web/api/v1/conversations', {
        method: 'POST',
        headers,
        body: json({ title: 'x' }),
      }),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe('unsupported_media_type');
    expect(body.trace_id).toMatch(TRACE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['application/json', 'Application/JSON', 'application/json; charset=utf-8'])(
    'accepts content type %s',
    async (type) => {
      process.env.MOCK_UPSTREAM = 'true';
      const res = await create(post(json({ title: 't' }), { 'content-type': type }));
      expect(res.status).toBe(201);
    },
  );

  it('drops a __proto__ or constructor key instead of merging it', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({}, { status: 201 }));
    const hostile = '{"title":"ok","__proto__":{"admin":true},"constructor":{"x":1}}';
    expect((await create(post(hostile))).status).toBe(201);
    expect(upstreamBody(spy)).toEqual({ title: 'ok' });
    expect(({} as Record<string, unknown>).admin).toBeUndefined(); // nothing was polluted
  });

  it('rejects a title with a lone surrogate (valid JSON, unencodable text)', async () => {
    const fetchSpy = noFetch();
    const res = await create(post('{"title":"bad \\ud800 title"}'));
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still accepts a well-formed surrogate pair', async () => {
    process.env.MOCK_UPSTREAM = 'true';
    expect((await create(post(json({ title: 'ok \u{1F680}' })))).status).toBe(201);
  });
});

describe('GET /api/v1/conversations/{id} id edge cases', () => {
  it.each([
    ['a trailing newline', `${TRACE_CONVERSATION_ID}\n`],
    ['a leading newline', `\n${TRACE_CONVERSATION_ID}`],
    ['a trailing space', `${TRACE_CONVERSATION_ID} `],
    ['full-width hex digits', '３f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51'],
    ['the Kelvin sign', '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a5\u212a'],
    ['a long s', '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a5\u017f'],
    ['no hyphens', TRACE_CONVERSATION_ID.replaceAll('-', '')],
    ['braces', `{${TRACE_CONVERSATION_ID}}`],
  ])('rejects an id with %s', async (_label, id) => {
    const fetchSpy = noFetch();
    const res = await getOne(get('/api/v1/conversations/x'), ctx(id));
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('readTextCapped', () => {
  const streamed = (chunks: Uint8Array[], stall = false) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!stall) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://web/x', {
      method: 'POST',
      body,
      // @ts-expect-error — Node's fetch requires duplex for a streamed request body
      duplex: 'half',
    });
    return { request, wasCancelled: () => cancelled };
  };
  const bytes = (n: number) => new Uint8Array(n).fill(97);

  it('joins several chunks that fit', async () => {
    const { request } = streamed([bytes(10), bytes(20)]);
    const read = await readTextCapped(request, 100);
    expect(read).toEqual({ ok: true, text: 'a'.repeat(30) });
  });

  it('stops and cancels the stream once several small chunks cross the cap', async () => {
    const { request, wasCancelled } = streamed(Array.from({ length: 6 }, () => bytes(1000)));
    const read = await readTextCapped(request, 4096);
    expect(read).toEqual({ ok: false, reason: 'too_large' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wasCancelled()).toBe(true);
  });

  it('accepts exactly the cap and refuses one byte more', async () => {
    expect((await readTextCapped(streamed([bytes(64)]).request, 64)).ok).toBe(true);
    expect(await readTextCapped(streamed([bytes(65)]).request, 64)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('gives up on a body that stalls (a trickling upload) instead of waiting forever', async () => {
    const { request } = streamed([bytes(5)], true);
    const started = Date.now();
    const read = await readTextCapped(request, 100, 50);
    expect(read).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses early on a declared content-length over the cap, without reading', async () => {
    const request = new Request('http://web/x', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x',
    });
    expect(await readTextCapped(request, 4096)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('treats a missing body as empty text', async () => {
    expect(await readTextCapped(new Request('http://web/x', { method: 'POST' }), 10)).toEqual({
      ok: true,
      text: '',
    });
  });
});
