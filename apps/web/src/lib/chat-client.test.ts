import { describe, expect, it, vi } from 'vitest';
import { askStream, parseCitations } from '@/lib/chat-client';
import { sseFrame, sseStreamFromFrames } from '@/lib/sse';

const TRACE = '0eb01' + 'a'.repeat(27);
const OTHER_TRACE = '0c70' + '1' + 'b'.repeat(27);
const A = { title: 'The api service', path: 'docs/api.md' };
const B = { title: 'The web app', path: 'docs/web.md' };

function sseResponse(frames: string[], init: { status?: number; trace?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (init.trace) headers['x-trace-id'] = init.trace;
  return new Response(sseStreamFromFrames(frames), { status: init.status ?? 200, headers });
}
function jsonResponse(body: unknown, status: number, trace?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (trace) headers['x-trace-id'] = trace;
  return new Response(JSON.stringify(body), { status, headers });
}
function handlers() {
  return { onSources: vi.fn(), onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
}
const run = (response: Response | Promise<Response>, h = handlers()) =>
  askStream('/x', 'q', h, { fetchImpl: vi.fn().mockImplementation(async () => response) }).then(
    () => h,
  );

describe('askStream — a successful answer', () => {
  it('posts the question and dispatches sources → tokens → done with citations', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          sseFrame('sources', { citations: [A, B], count: 2 }),
          sseFrame('token', { text: 'Hel' }),
          sseFrame('token', { text: 'lo' }),
          sseFrame('done', { citations: [A, B], input_tokens: 3, output_tokens: 2 }),
        ]),
      );
    const h = handlers();
    await askStream('/api/v1/conversations/x/ask/stream', 'hi', h, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/v1/conversations/x/ask/stream');
    expect(init.method).toBe('POST');
    expect(init.headers.accept).toBe('text/event-stream');
    expect(JSON.parse(init.body)).toEqual({ question: 'hi' });
    expect(h.onSources).toHaveBeenCalledWith([A, B]);
    expect(h.onToken.mock.calls.map((c) => c[0]).join('')).toBe('Hello');
    expect(h.onDone).toHaveBeenCalledWith({ citations: [A, B], inputTokens: 3, outputTokens: 2 });
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('delivers the sources before the first token', async () => {
    const order: string[] = [];
    const h = {
      onSources: () => order.push('sources'),
      onToken: () => order.push('token'),
      onDone: () => order.push('done'),
      onError: () => order.push('error'),
    };
    await run(
      sseResponse([
        sseFrame('sources', { citations: [A], count: 1 }),
        sseFrame('token', { text: 'x' }),
        sseFrame('done', { citations: [A] }),
      ]),
      h as never,
    );
    expect(order).toEqual(['sources', 'token', 'done']);
  });

  it('falls back to the sources-frame citations when done carries none of its own', async () => {
    const h = await run(
      sseResponse([sseFrame('sources', { citations: [A], count: 1 }), sseFrame('done', {})]),
    );
    expect(h.onDone).toHaveBeenCalledWith({
      citations: [A],
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('skips malformed frames', async () => {
    const h = await run(
      sseResponse([
        'event: token\ndata: {broken\n\n',
        sseFrame('token', { text: 'ok' }),
        sseFrame('done', { citations: [] }),
      ]),
    );
    expect(h.onToken).toHaveBeenCalledWith('ok');
    expect(h.onDone).toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});

describe('askStream — failures before the stream starts', () => {
  it("surfaces the api's error code and trace_id from the JSON body", async () => {
    const h = await run(jsonResponse({ error: 'not_found', trace_id: TRACE }, 404, OTHER_TRACE));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'not_found', traceId: TRACE });
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it('uses the x-trace-id header when the body has no valid trace_id', async () => {
    const h = await run(
      jsonResponse({ error: 'ai_unavailable', trace_id: '<script>' }, 503, TRACE),
    );
    expect(h.onError).toHaveBeenCalledWith({ code: 'ai_unavailable', traceId: TRACE });
  });

  it('has no trace id when neither the body nor the header carries a valid one', async () => {
    const h = await run(jsonResponse({ error: 'validation_error' }, 422, 'not-a-trace-id'));
    expect(h.onError).toHaveBeenCalledWith({ code: 'validation_error', traceId: undefined });
  });

  it('reads the error frame in the BFF 502 event-stream body (api unreachable)', async () => {
    const h = await run(
      sseResponse([sseFrame('error', { error_kind: 'upstream_unreachable' })], {
        status: 502,
        trace: TRACE,
      }),
    );
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({
      code: 'upstream_unreachable',
      traceId: TRACE,
    });
  });

  it('falls back to a class code when that 502 body has no error frame', async () => {
    const h = await run(
      sseResponse([sseFrame('token', { text: 'x' })], { status: 502, trace: TRACE }),
    );
    expect(h.onError).toHaveBeenCalledWith({ code: 'upstream_error', traceId: TRACE });
  });

  it.each([
    [400, 'request_rejected'],
    [404, 'request_rejected'],
    [422, 'request_rejected'],
    [500, 'upstream_error'],
    [502, 'upstream_error'],
    [503, 'upstream_error'],
  ])('falls back to a code by status class for a non-JSON %i', async (status, code) => {
    const h = await run(
      new Response('<html>proxy page</html>', { status, headers: { 'x-trace-id': TRACE } }),
    );
    expect(h.onError).toHaveBeenCalledWith({ code, traceId: TRACE });
  });

  it.each(['<script>alert(1)</script>', 'Not Found', 'a'.repeat(200), '', 42, null, ['x']])(
    'never hands on an unsafe error code (%j)',
    async (hostile) => {
      const h = await run(jsonResponse({ error: hostile, trace_id: TRACE }, 502));
      expect(h.onError).toHaveBeenCalledWith({ code: 'upstream_error', traceId: TRACE });
    },
  );

  it('survives a JSON null or array body', async () => {
    for (const body of [null, [], 'text', 5]) {
      const h = await run(jsonResponse(body, 500, TRACE));
      expect(h.onError).toHaveBeenCalledWith({ code: 'upstream_error', traceId: TRACE });
    }
  });

  it('reports a network failure and an abort', async () => {
    const down = handlers();
    await askStream('/x', 'q', down, { fetchImpl: vi.fn().mockRejectedValue(new Error('down')) });
    expect(down.onError).toHaveBeenCalledExactlyOnceWith({ code: 'network_error' });

    const aborted = handlers();
    await askStream('/x', 'q', aborted, {
      fetchImpl: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    });
    expect(aborted.onError).toHaveBeenCalledExactlyOnceWith({ code: 'aborted' });
  });

  it('treats an OK response with no body as an upstream error', async () => {
    const h = await run(new Response(null, { status: 200, headers: { 'x-trace-id': TRACE } }));
    expect(h.onError).toHaveBeenCalledWith({ code: 'upstream_error', traceId: TRACE });
  });
});

describe('askStream — failures inside the stream', () => {
  it('surfaces an error frame with its kind and the response trace id', async () => {
    const h = await run(
      sseResponse(
        [
          sseFrame('sources', { citations: [A], count: 1 }),
          sseFrame('token', { text: 'The trace id is' }),
          sseFrame('error', { error_kind: 'timeout' }),
        ],
        { trace: TRACE },
      ),
    );
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'timeout', traceId: TRACE });
    expect(h.onToken).toHaveBeenCalledWith('The trace id is'); // what streamed before is kept
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it.each([{ error_kind: '<img onerror=x>' }, { error_kind: 7 }, {}])(
    'uses a generic code for an error frame with an unsafe kind (%j)',
    async (data) => {
      const h = await run(sseResponse([sseFrame('error', data)], { trace: TRACE }));
      expect(h.onError).toHaveBeenCalledWith({ code: 'error', traceId: TRACE });
    },
  );

  it('stops at the first terminal frame', async () => {
    const h = await run(
      sseResponse([
        sseFrame('error', { error_kind: 'timeout' }),
        sseFrame('token', { text: 'late' }),
        sseFrame('done', { citations: [] }),
      ]),
    );
    expect(h.onToken).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it('is a failure, never "done", when the stream ends without a terminal frame', async () => {
    const h = await run(
      sseResponse(
        [sseFrame('sources', { citations: [A], count: 1 }), sseFrame('token', { text: 'part' })],
        { trace: TRACE },
      ),
    );
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'stream_ended', traceId: TRACE });
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onSources).toHaveBeenCalledWith([A]);
  });

  it('is a failure for a stream with no frames at all', async () => {
    const h = await run(sseResponse([]));
    expect(h.onError).toHaveBeenCalledWith({ code: 'stream_ended', traceId: undefined });
  });

  it('reports a read error mid-stream as stream_error, and an abort as aborted', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const h1 = await run(
      new Response(broken, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(h1.onError).toHaveBeenCalledExactlyOnceWith({
      code: 'stream_error',
      traceId: undefined,
    });

    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException('aborted', 'AbortError'));
      },
    });
    const h2 = await run(new Response(cut, { headers: { 'content-type': 'text/event-stream' } }));
    expect(h2.onError).toHaveBeenCalledExactlyOnceWith({ code: 'aborted', traceId: undefined });
  });
});

describe('parseCitations', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      parseCitations([A, null, 'x', 5, { title: 'no path' }, { path: '' }, { path: 7 }, B, []]),
    ).toEqual([A, B]);
  });

  it('falls back to the file name when the title is missing or empty', () => {
    expect(
      parseCitations([{ path: 'docs/guide/setup.md' }, { title: '', path: 'a\\b\\c.md' }]),
    ).toEqual([
      { title: 'setup.md', path: 'docs/guide/setup.md' },
      { title: 'c.md', path: 'a\\b\\c.md' },
    ]);
  });

  it.each([undefined, null, 'x', 5, {}, { 0: A, length: 1 }])('gives [] for %j', (value) => {
    expect(parseCitations(value)).toEqual([]);
  });

  it('caps the number of citations and the length of each field', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ title: `t${i}`, path: `docs/${i}.md` }));
    expect(parseCitations(many)).toHaveLength(50);
    const [long] = parseCitations([{ title: 'x'.repeat(2000), path: 'p'.repeat(2000) }]);
    expect(long.title).toHaveLength(500);
    expect(long.path).toHaveLength(500);
  });

  it('passes hostile text through untouched — it is the renderer that must not interpret it', () => {
    const hostile = { title: '<img src=x onerror=alert(1)>', path: 'javascript:alert(1)' };
    expect(parseCitations([hostile])).toEqual([hostile]);
  });
});

describe('parseCitations — invisible characters', () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const LRI = String.fromCharCode(0x2066);
  const BOM = String.fromCharCode(0xfeff);
  const NUL = String.fromCharCode(0);

  it('strips bidi overrides, zero-width and control characters from titles and paths', () => {
    expect(
      parseCitations([
        {
          title: `Re${RLO}ad${ZWSP}me${LRI}${BOM}`,
          path: `docs/${RLO}evil${NUL}.md\n`,
        },
      ]),
    ).toEqual([{ title: 'Readme', path: 'docs/evil.md' }]);
  });

  it.each([0x00ad, 0x061c, 0x180e, 0x2028, 0x2029, 0xfff9, 0xe0041])(
    'strips the invisible character U+%s',
    (code) => {
      const c = String.fromCodePoint(code);
      expect(parseCitations([{ title: `a${c}b`, path: `d${c}.md` }])).toEqual([
        { title: 'ab', path: 'd.md' },
      ]);
    },
  );

  it('falls back to the file name when a title is nothing but invisible characters', () => {
    expect(parseCitations([{ title: `${RLO}${ZWSP}`, path: 'docs/a/setup.md' }])).toEqual([
      { title: 'setup.md', path: 'docs/a/setup.md' },
    ]);
  });

  it('drops an entry whose path is nothing but invisible characters', () => {
    expect(parseCitations([{ title: 'T', path: `${RLO}${ZWSP}` }, A])).toEqual([A]);
  });

  it('leaves ordinary non-Latin text alone', () => {
    const arabic = { title: 'دليل الإعداد', path: 'docs/ar/دليل.md' };
    expect(parseCitations([arabic])).toEqual([arabic]);
  });
});

describe('askStream — hardening', () => {
  it('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([sseFrame('done', { citations: [] })]));
    await askStream('/x', 'q', handlers(), { fetchImpl, signal: controller.signal });
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it.each([
    'https://evil.example/x',
    'http://localhost:3000/api',
    '//evil.example/x',
    'javascript:alert(1)',
    'api/v1/x',
    '',
    ' /x',
    '/a b',
  ])(
    'refuses endpoint %j without calling fetch (the BFF rule: same-origin paths only)',
    async (endpoint) => {
      const fetchImpl = vi.fn();
      const h = handlers();
      await askStream(endpoint, 'q', h, { fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'bad_endpoint' });
    },
  );

  it('accepts a same-origin path with a query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([sseFrame('done', { citations: [] })]));
    const h = handlers();
    await askStream('/api/v1/conversations/x/ask/stream?a=1', 'q', h, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalled();
  });

  it('cancels the response body once a terminal frame has been read', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseFrame('done', { citations: [] })));
        // never closed: the server keeps the connection open
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = await run(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    expect(h.onDone).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });

  it('does not read an error body beyond the cap', async () => {
    const huge = JSON.stringify({ error: 'not_found', trace_id: TRACE, pad: 'x'.repeat(10_000) });
    const h = await run(
      new Response(huge, {
        status: 404,
        headers: { 'content-type': 'application/json', 'x-trace-id': OTHER_TRACE },
      }),
    );
    // too long to trust: a class code and the header's trace id, not the body's
    expect(h.onError).toHaveBeenCalledWith({ code: 'request_rejected', traceId: OTHER_TRACE });
  });

  it('does not read an endless non-error event stream on a failed response', async () => {
    const frames = Array.from({ length: 200 }, () => sseFrame('token', { text: 'x' }));
    const h = await run(sseResponse(frames, { status: 502, trace: TRACE }));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'upstream_error', traceId: TRACE });
  });

  it('refuses a frame that never ends instead of buffering it forever', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: token\ndata: ' + 'x'.repeat(1_200_000)),
        );
      },
    });
    const h = await run(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith({ code: 'stream_error', traceId: undefined });
    expect(h.onToken).not.toHaveBeenCalled();
  });

  describe('Retry-After on a failed response', () => {
    const failed = (headers: Record<string, string>) =>
      new Response(JSON.stringify({ error: 'rate_limited', trace_id: '0eb01' + 'a'.repeat(27) }), {
        status: 429,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const run = async (res: Response) => {
      let error: unknown = null;
      await askStream(
        '/api/v1/conversations/x/ask/stream',
        'q',
        { onSources: () => {}, onToken: () => {}, onDone: () => {}, onError: (e) => (error = e) },
        { fetchImpl: (async () => res) as unknown as typeof fetch },
      );
      return error;
    };

    it('hands over a sane Retry-After with the error code', async () => {
      expect(await run(failed({ 'retry-after': '12' }))).toMatchObject({
        code: 'rate_limited',
        retryAfterSeconds: 12,
      });
    });

    it.each(['', '0', '-1', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '99999'])(
      'leaves out an unusable Retry-After (%j)',
      async (value) => {
        const error = (await run(failed(value === '' ? {} : { 'retry-after': value }))) as Record<
          string,
          unknown
        >;
        expect(error.code).toBe('rate_limited');
        expect('retryAfterSeconds' in error).toBe(false);
      },
    );
  });

  describe('a 429 whose body is not ours', () => {
    const run = async (res: Response) => {
      let error: unknown = null;
      await askStream(
        '/api/v1/conversations/x/ask/stream',
        'q',
        { onSources: () => {}, onToken: () => {}, onDone: () => {}, onError: (e) => (error = e) },
        { fetchImpl: (async () => res) as unknown as typeof fetch },
      );
      return error;
    };

    it.each([
      ['an HTML page', 'text/html', '<html>Too Many Requests</html>'],
      ['an empty body', '', ''],
      ['JSON without a code', 'application/json', '{"message":"slow down"}'],
    ])('is still a rate limit, with its Retry-After, for %s', async (_label, type, body) => {
      const res = new Response(body, {
        status: 429,
        headers: { ...(type ? { 'content-type': type } : {}), 'retry-after': '8' },
      });
      expect(await run(res)).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 8 });
    });

    it('does not turn other 4xx into a rate limit', async () => {
      expect(await run(new Response('x', { status: 403 }))).toMatchObject({
        code: 'request_rejected',
      });
    });
  });
});
