import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/conversations/route';
import { POST as askRoute } from '@/app/api/v1/conversations/[id]/ask/stream/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { recordRateLimited } from '@/lib/metrics';
import { TRACE_CONVERSATION_ID as ID } from '@/mocks/conversations';

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return { ...actual, log: vi.fn() };
});
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return { ...actual, recordRateLimited: vi.fn() };
});

const ASK_CLASS = '/api/v1/conversations/[id]/ask/stream';
const CREATE_CLASS = '/api/v1/conversations';
const API = 'http://api:8000';
const KEYS = [
  'API_BASE_URL',
  'MOCK_UPSTREAM',
  'APP_ENV',
  'RATE_LIMIT_ASKS_PER_MINUTE',
  'RATE_LIMIT_CREATES_PER_MINUTE',
  'RATE_LIMIT_STREAMS_PER_CLIENT',
  'RATE_LIMIT_TRUSTED_PROXY_HOPS',
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  __resetRateLimitForTests();
  vi.mocked(log).mockClear();
  vi.mocked(recordRateLimited).mockClear();
  process.env.API_BASE_URL = API;
  process.env.MOCK_UPSTREAM = 'true';
  for (const k of KEYS.slice(3)) delete process.env[k];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetRateLimitForTests();
});

const ctx = { params: Promise.resolve({ id: ID }) };
const from = (address: string) => ({ 'x-forwarded-for': address });
function ask(headers: Record<string, string> = {}, question = 'hi') {
  return askRoute(
    new Request(`http://web/api/v1/conversations/${ID}/ask/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ question }),
    }),
    ctx,
  );
}
function create(headers: Record<string, string> = {}) {
  return createRoute(
    new Request('http://web/api/v1/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    }),
  );
}
const noFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called');
  });

describe('per-client rate limit on asking', () => {
  it('answers 429 rate_limited with Retry-After once the client is over its allowance', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '2';
    for (let i = 0; i < 2; i++) {
      const ok = await ask(from('203.0.113.7'));
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const res = await ask(from('203.0.113.7'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(body.trace_id).toMatch(/^0eb0[0-9a-f]{28}$/);
    expect(res.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forwards nothing to the api for a refused request (real mode)', async () => {
    delete process.env.MOCK_UPSTREAM;
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('event: done\ndata: {}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    await (await ask(from('203.0.113.7'))).text();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const refused = await ask(from('203.0.113.7'), 'a second question');
    expect(refused.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the question never reached the api
  });

  it('applies the same limit in mock mode', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    await (await ask(from('203.0.113.7'))).text();
    expect((await ask(from('203.0.113.7'))).status).toBe(429);
  });

  it('refuses before reading the body, so a flood of oversized requests costs nothing', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    await (await ask(from('203.0.113.7'))).text();
    const res = await askRoute(
      new Request(`http://web/api/v1/conversations/${ID}/ask/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...from('203.0.113.7') },
        body: 'x'.repeat(200_000), // far over the body cap: would be 413 if the body were read
      }),
      ctx,
    );
    expect(res.status).toBe(429);
  });

  it('counts each client separately', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    await (await ask(from('203.0.113.7'))).text();
    expect((await ask(from('203.0.113.7'))).status).toBe(429);
    const other = await ask(from('198.51.100.9'));
    expect(other.status).toBe(200);
    await other.text();
  });

  it('cannot be dodged by sending an x-forwarded-for of its own', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    await (await ask(from('1.1.1.1, 203.0.113.7'))).text();
    // a different claimed address in front of the same trusted (last) entry: the same client
    expect((await ask(from('2.2.2.2, 203.0.113.7'))).status).toBe(429);
    expect((await ask(from('3.3.3.3, 4.4.4.4, 203.0.113.7'))).status).toBe(429);
  });

  it('puts requests with no readable address into one shared allowance', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    await (await ask({})).text();
    expect((await ask({ 'x-forwarded-for': 'not an address' })).status).toBe(429);
  });

  it('honours the number of trusted hops', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '2';
    await (await ask(from('203.0.113.7, 10.0.0.1'))).text();
    expect((await ask(from('203.0.113.7, 10.0.0.2'))).status).toBe(429); // same second-from-last
    const other = await ask(from('198.51.100.9, 10.0.0.1'));
    expect(other.status).toBe(200);
    await other.text();
  });

  it('does not limit asking and creating together: each has its own allowance', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    process.env.RATE_LIMIT_CREATES_PER_MINUTE = '1';
    await (await ask(from('203.0.113.7'))).text();
    expect((await create(from('203.0.113.7'))).status).toBe(201);
    expect((await create(from('203.0.113.7'))).status).toBe(429);
  });
});

describe('per-client rate limit on starting a chat', () => {
  it('answers 429 with the api error shape and Retry-After', async () => {
    process.env.RATE_LIMIT_CREATES_PER_MINUTE = '1';
    expect((await create(from('203.0.113.7'))).status).toBe(201);
    const res = await create(from('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(Object.keys(await res.json()).sort()).toEqual(['error', 'trace_id']);
    expect(res.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
  });

  it('forwards nothing to the api for a refused request (real mode)', async () => {
    delete process.env.MOCK_UPSTREAM;
    process.env.RATE_LIMIT_CREATES_PER_MINUTE = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: ID,
            title: 'New conversation',
            created_at: '2026-10-12T09:00:00Z',
            updated_at: '2026-10-12T09:00:00Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    await create(from('203.0.113.7'));
    await create(from('203.0.113.7'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not limit listing', async () => {
    process.env.RATE_LIMIT_CREATES_PER_MINUTE = '1';
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    for (let i = 0; i < 25; i++) {
      const res = await listRoute(
        new Request('http://web/api/v1/conversations', { headers: from('203.0.113.7') }),
      );
      expect(res.status).toBe(200);
    }
  });
});

describe('concurrent streams per client', () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_STREAMS_PER_CLIENT = '1';
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1000';
  });

  it('refuses a second stream while one is open, and accepts one after it is read to the end', async () => {
    const first = await ask(from('203.0.113.7'));
    expect(first.status).toBe(200);
    const second = await ask(from('203.0.113.7'));
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('rate_limited');
    expect(second.headers.get('retry-after')).toBe('5');
    await first.text(); // finished
    const third = await ask(from('203.0.113.7'));
    expect(third.status).toBe(200);
    await third.text();
  });

  it('frees the slot when the browser goes away mid-answer', async () => {
    const first = await ask(from('203.0.113.7'));
    const reader = first.body!.getReader();
    await reader.read();
    await reader.cancel();
    const next = await ask(from('203.0.113.7'));
    expect(next.status).toBe(200);
    await next.text();
  });

  it("does not make one client's streams count against another's", async () => {
    const mine = await ask(from('203.0.113.7'));
    const theirs = await ask(from('198.51.100.9'));
    expect(theirs.status).toBe(200);
    await mine.text();
    await theirs.text();
  });

  it('frees the slot when the api refuses before the stream starts', async () => {
    delete process.env.MOCK_UPSTREAM;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'not_found', trace_id: '0c70' + '1'.repeat(28) }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect((await ask(from('203.0.113.7'))).status).toBe(404);
    expect((await ask(from('203.0.113.7'))).status).toBe(404); // not 429: the slot was released
  });

  it('frees the slot when the api cannot be reached', async () => {
    delete process.env.MOCK_UPSTREAM;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await ask(from('203.0.113.7'))).status).toBe(502);
    expect((await ask(from('203.0.113.7'))).status).toBe(502);
  });

  it('frees the slot when the api answers with something that is not a stream', async () => {
    delete process.env.MOCK_UPSTREAM;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect((await ask(from('203.0.113.7'))).status).toBe(502);
    expect((await ask(from('203.0.113.7'))).status).toBe(502);
  });

  it('does not take a slot for a request that is rejected before any answer starts', async () => {
    noFetch();
    expect((await ask(from('203.0.113.7'), '')).status).toBe(422);
    const ok = await ask(from('203.0.113.7'));
    expect(ok.status).toBe(200);
    await ok.text();
  });
});

describe('privacy and telemetry', () => {
  it('never logs a client address, and counts the refusal by route class only', async () => {
    process.env.RATE_LIMIT_ASKS_PER_MINUTE = '1';
    process.env.RATE_LIMIT_CREATES_PER_MINUTE = '1';
    await (await ask(from('203.0.113.7'))).text();
    await ask(from('203.0.113.7'));
    await create(from('203.0.113.7'));
    await create(from('203.0.113.7'));
    expect(vi.mocked(recordRateLimited).mock.calls).toEqual([[ASK_CLASS], [CREATE_CLASS]]);
    const logged = JSON.stringify(vi.mocked(log).mock.calls);
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).toContain('bff rate limited');
  });
});
