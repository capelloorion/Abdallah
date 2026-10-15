import { describe, expect, it, vi } from 'vitest';
import {
  askEndpoint,
  createConversation,
  getConversation,
  listConversations,
} from './conversations-client';

const ID = '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51';
const BIDI = String.fromCodePoint(0x202e);
const ID_2 = '7a1d4e92-0b3c-4f65-8e21-9d8c7b6a5f42';
const TRACE = '0eb01' + 'd'.repeat(27);

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const fetchReturning = (res: Response | (() => Response)) =>
  vi.fn(async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch;

const SUMMARY = { id: ID, title: 'Trace ids', updated_at: '2026-10-06T09:05:00Z' };

describe('listConversations', () => {
  it('returns the items and asks the same-origin list route', async () => {
    const f = fetchReturning(json({ items: [SUMMARY], count: 1 }));
    const result = await listConversations(undefined, f);
    expect(result).toEqual({ ok: true, data: [SUMMARY] });
    expect((f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe(
      '/api/v1/conversations',
    );
  });

  it('drops malformed rows, lower-cases ids and strips hostile characters from titles', async () => {
    const result = await listConversations(
      undefined,
      fetchReturning(
        json({
          items: [
            { ...SUMMARY, id: ID.toUpperCase(), title: `a${BIDI}b\u0000c` },
            { ...SUMMARY, id: 'not-a-uuid' },
            { ...SUMMARY, title: 5 },
            null,
            'x',
          ],
        }),
      ),
    );
    expect(result).toEqual({ ok: true, data: [{ ...SUMMARY, title: 'abc' }] });
  });

  it('trims titles, and a title of only invisible characters becomes empty', async () => {
    const result = await listConversations(
      undefined,
      fetchReturning(
        json({
          items: [
            { ...SUMMARY, title: '  padded  ' },
            { ...SUMMARY, id: ID_2, title: `${BIDI}${String.fromCodePoint(0x200b)}` },
          ],
        }),
      ),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.map((c) => c.title)).toEqual(['padded', '']);
  });

  it('keeps at most 100 rows and clips a long title', async () => {
    const many = Array.from({ length: 150 }, () => ({ ...SUMMARY, title: 'x'.repeat(500) }));
    const result = await listConversations(undefined, fetchReturning(json({ items: many })));
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toHaveLength(100);
    expect(result.data[0].title).toHaveLength(200);
  });

  it('reports the api error code and trace id', async () => {
    const result = await listConversations(
      undefined,
      fetchReturning(json({ error: 'ai_unavailable', trace_id: TRACE }, { status: 503 })),
    );
    expect(result).toEqual({ ok: false, error: { code: 'ai_unavailable', traceId: TRACE } });
  });

  it('reports an unreachable BFF as network_error', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await listConversations(undefined, f)).toEqual({
      ok: false,
      error: { code: 'network_error' },
    });
  });

  it('reports an abort as aborted, not as a failure code', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('x', 'AbortError');
    }) as unknown as typeof fetch;
    expect(await listConversations(undefined, f)).toEqual({
      ok: false,
      error: { code: 'aborted' },
    });
  });

  it.each([
    ['not json', new Response('<html>', { headers: { 'content-type': 'application/json' } })],
    ['wrong shape', json({ nope: true })],
    ['an array', json([SUMMARY])],
  ])('treats %s as bad_response', async (_name, res) => {
    const result = await listConversations(undefined, fetchReturning(res));
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
  });

  it('refuses a response larger than the cap', async () => {
    const big = json({ items: [], pad: 'x'.repeat(2_100_000) });
    const result = await listConversations(undefined, fetchReturning(big));
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
  });
});

describe('createConversation', () => {
  it('posts an empty JSON body and returns the new row', async () => {
    const f = fetchReturning(json(SUMMARY, { status: 201 }));
    const result = await createConversation(undefined, f);
    expect(result).toEqual({ ok: true, data: SUMMARY });
    const [path, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(path).toBe('/api/v1/conversations');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('reports a rejected create', async () => {
    const result = await createConversation(
      undefined,
      fetchReturning(json({ error: 'unsupported_media_type', trace_id: TRACE }, { status: 415 })),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'unsupported_media_type', traceId: TRACE },
    });
  });
});

describe('getConversation', () => {
  const DETAIL = {
    id: ID,
    title: 'Trace ids',
    created_at: '2026-10-06T09:00:00Z',
    updated_at: '2026-10-06T09:05:00Z',
    truncated: true,
    messages: [
      { id: 'm1', role: 'user', content: 'Which port?', citations: null, created_at: 'x' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Port 8000 [1].',
        citations: [
          { title: 'The api' + BIDI + ' service', path: 'docs/api.md' },
          { title: 'bad', path: '' },
        ],
        created_at: 'x',
      },
      { id: 'm3', role: 'system', content: 'ignored', citations: null, created_at: 'x' },
      { id: 'm4', role: 'assistant', content: 5, citations: null, created_at: 'x' },
    ],
  };

  it('maps stored messages to thread messages through the citation parser', async () => {
    const f = fetchReturning(json(DETAIL));
    const result = await getConversation(ID.toUpperCase(), undefined, f);
    expect(result).toEqual({
      ok: true,
      data: {
        id: ID,
        title: 'Trace ids',
        truncated: true,
        messages: [
          { id: 'stored-0', role: 'user', text: 'Which port?' },
          {
            id: 'stored-1',
            role: 'assistant',
            text: 'Port 8000 [1].',
            citations: [{ title: 'The api service', path: 'docs/api.md' }],
          },
        ],
      },
    });
    expect((f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe(
      `/api/v1/conversations/${ID}`,
    );
  });

  it('never carries an error or trace id from stored data into a message', async () => {
    const poisoned = {
      ...DETAIL,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'x',
          citations: null,
          error: 'boom',
          traceId: TRACE,
          created_at: 'x',
        },
      ],
    };
    const result = await getConversation(ID, undefined, fetchReturning(json(poisoned)));
    if (!result.ok) throw new Error('expected ok');
    expect(Object.keys(result.data.messages[0]).sort()).toEqual(['id', 'role', 'text']);
  });

  it('caps the number of messages and the length of one message', async () => {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      content: 'y'.repeat(150_000),
      citations: null,
      created_at: 'x',
    }));
    const result = await getConversation(
      ID,
      undefined,
      fetchReturning(json({ ...DETAIL, messages: messages.slice(0, 5) })),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.messages[0].text).toHaveLength(100_000);
  });

  it('keeps the NEWEST 200 messages when there are more, and says some were left out', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      content: `message ${i}`,
      citations: null,
      created_at: 'x',
    }));
    const capped = await getConversation(
      ID,
      undefined,
      fetchReturning(json({ ...DETAIL, truncated: false, messages: many })),
    );
    if (!capped.ok) throw new Error('expected ok');
    expect(capped.data.messages).toHaveLength(200);
    expect(capped.data.messages[0].text).toBe('message 100');
    expect(capped.data.messages[199].text).toBe('message 299');
    expect(capped.data.truncated).toBe(true);
  });

  it('does not claim truncation when nothing was left out', async () => {
    const result = await getConversation(
      ID,
      undefined,
      fetchReturning(json({ ...DETAIL, truncated: false })),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.truncated).toBe(false);
  });

  it('answers a 404 with the api error code and trace id', async () => {
    const result = await getConversation(
      ID,
      undefined,
      fetchReturning(json({ error: 'not_found', trace_id: TRACE }, { status: 404 })),
    );
    expect(result).toEqual({ ok: false, error: { code: 'not_found', traceId: TRACE } });
  });

  it('refuses an id that is not a UUID without calling the network', async () => {
    const f = fetchReturning(json(DETAIL));
    expect(await getConversation('../etc/passwd', undefined, f)).toEqual({
      ok: false,
      error: { code: 'bad_id' },
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('treats a response for a different shape as bad_response', async () => {
    const result = await getConversation(
      ID,
      undefined,
      fetchReturning(json({ ...DETAIL, id: 'nope' })),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
  });
});

describe('askEndpoint', () => {
  it.each(['../x', `${ID}/../x`, `${ID}?a=1`, `${ID}#x`, '', 'abc'])(
    'refuses %j rather than build a path from it',
    (bad) => {
      expect(() => askEndpoint(bad)).toThrow();
    },
  );

  it('is the conversation same-origin ask-stream path', () => {
    expect(askEndpoint(ID.toUpperCase())).toBe(`/api/v1/conversations/${ID}/ask/stream`);
  });

  describe('Retry-After on a refused request', () => {
    it('is passed on with the error for a 429', async () => {
      const res = new Response(JSON.stringify({ error: 'rate_limited', trace_id: TRACE }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      });
      const result = await createConversation(undefined, fetchReturning(res));
      expect(result).toEqual({
        ok: false,
        error: { code: 'rate_limited', traceId: TRACE, retryAfterSeconds: 7 },
      });
    });

    it('is left out when it is not a sane number', async () => {
      const res = new Response(JSON.stringify({ error: 'rate_limited', trace_id: TRACE }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': 'never' },
      });
      const result = await listConversations(undefined, fetchReturning(res));
      expect(result).toEqual({ ok: false, error: { code: 'rate_limited', traceId: TRACE } });
    });
  });
});
