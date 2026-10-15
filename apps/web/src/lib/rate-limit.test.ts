import { describe, expect, it, vi } from 'vitest';
import {
  RATE_LIMIT_DEFAULTS,
  RateLimiter,
  StreamSlots,
  UNKNOWN_CLIENT,
  clientKey,
  readRateLimitConfig,
  releaseWhenDone,
  type RateLimitConfig,
} from './rate-limit';

const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  ...RATE_LIMIT_DEFAULTS,
  ...over,
});
const h = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff });

describe('readRateLimitConfig', () => {
  it('uses the defaults when nothing is set', () => {
    expect(readRateLimitConfig({})).toEqual(RATE_LIMIT_DEFAULTS);
  });

  it('reads the five settings', () => {
    expect(
      readRateLimitConfig({
        RATE_LIMIT_ASKS_PER_MINUTE: '3',
        RATE_LIMIT_CREATES_PER_MINUTE: '4',
        RATE_LIMIT_STREAMS_PER_CLIENT: '5',
        RATE_LIMIT_TRUSTED_PROXY_HOPS: '2',
        RATE_LIMIT_MAX_CLIENTS: '50',
      }),
    ).toMatchObject({
      asksPerMinute: 3,
      createsPerMinute: 4,
      streamsPerClient: 5,
      trustedHops: 2,
      maxClients: 50,
    });
  });

  it.each(['', 'abc', '0', '-1', '1.5', '1e3', '99999999999', '10001'])(
    'falls back to the default for the invalid value %j (a typo is never "no limit")',
    (bad) => {
      expect(readRateLimitConfig({ RATE_LIMIT_ASKS_PER_MINUTE: bad }).asksPerMinute).toBe(
        RATE_LIMIT_DEFAULTS.asksPerMinute,
      );
    },
  );
});

describe('clientKey', () => {
  it('is the address the trusted proxy appended: the last entry for one hop', () => {
    expect(clientKey(h('203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientKey(h('9.9.9.9, 203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('cannot be chosen by the browser: entries in front of the trusted one are ignored', () => {
    expect(clientKey(h('1.1.1.1, 203.0.113.7'), 1)).toBe(clientKey(h('2.2.2.2, 203.0.113.7'), 1));
  });

  it('counts hops from the end', () => {
    expect(clientKey(h('1.1.1.1, 2.2.2.2, 3.3.3.3'), 2)).toBe('2.2.2.2');
    expect(clientKey(h('1.1.1.1, 2.2.2.2, 3.3.3.3'), 3)).toBe('1.1.1.1');
  });

  it('strips a port and brackets', () => {
    expect(clientKey(h('203.0.113.7:51234'), 1)).toBe('203.0.113.7');
    expect(clientKey(h('[2001:DB8::1]:443'), 1)).toBe(clientKey(h('2001:db8::1'), 1));
  });

  it('keys an IPv6 client by its /64: addresses in one block are one client, other blocks are not', () => {
    const a = clientKey(h('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), 1);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(clientKey(h('2001:db8:1:2::1'), 1)).toBe(a);
    expect(clientKey(h('2001:DB8:1:2:ffff:ffff:ffff:ffff'), 1)).toBe(a);
    expect(clientKey(h('2001:db8:1:3::1'), 1)).not.toBe(a);
    expect(clientKey(h('2001:db8::1'), 1)).toBe('2001:db8:0:0::/64'); // a compressed address expands
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 client', () => {
    expect(clientKey(h('::ffff:203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientKey(h('::FFFF:cb00:7107'), 1)).toBe('203.0.113.7');
    expect(clientKey(h('[::ffff:203.0.113.7]:443'), 1)).toBe('203.0.113.7');
  });

  it('drops an IPv6 zone id', () => {
    expect(clientKey(h('fe80::1%eth0'), 1)).toBe(clientKey(h('fe80::1'), 1));
  });

  it('is not fooled by leading zeros or a padded header: the trusted entry is the LAST one', () => {
    expect(clientKey(h('203.0.113.007'), 1)).toBe('203.0.113.7');
    const padded = '9.9.9.9, '.repeat(500) + '203.0.113.7';
    expect(clientKey(h(padded), 1)).toBe('203.0.113.7'); // a long header does not make it "unknown"
  });

  it.each([
    ['no header', undefined, 1],
    ['an empty header', '', 1],
    ['fewer entries than trusted hops', '1.2.3.4', 2],
    ['a name instead of an address', 'evil.example', 1],
    ['an out-of-range IPv4', '999.1.1.1', 1],
    ['script in the header', '<script>alert(1)</script>', 1],
    ['an entry that is far too long', '1'.repeat(200), 1],
    ['a malformed IPv6 (two ::)', '1::2::3', 1],
    ['an IPv6 with too many groups', '1:2:3:4:5:6:7:8:9', 1],
  ])('is the shared "unknown" client for %s', (_label, value, hops) => {
    expect(clientKey(h(value), hops)).toBe(UNKNOWN_CLIENT);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then says how long to wait', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(cfg({ asksPerMinute: 3 }), () => now);
    for (let i = 0; i < 3; i++) expect(limiter.check('ask', 'a')).toEqual({ ok: true });
    now += 20_000;
    expect(limiter.check('ask', 'a')).toEqual({ ok: false, retryAfterSeconds: 40 });
  });

  it('starts a new window after a minute', () => {
    let now = 0;
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1 }), () => now);
    expect(limiter.check('ask', 'a').ok).toBe(true);
    expect(limiter.check('ask', 'a').ok).toBe(false);
    now += 60_000;
    expect(limiter.check('ask', 'a').ok).toBe(true);
  });

  it('tells a wait of at least one second', () => {
    let now = 0;
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1 }), () => now);
    limiter.check('ask', 'a');
    now = 59_999;
    expect(limiter.check('ask', 'a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('keeps clients and buckets apart', () => {
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1, createsPerMinute: 1 }), () => 0);
    expect(limiter.check('ask', 'a').ok).toBe(true);
    expect(limiter.check('ask', 'a').ok).toBe(false);
    expect(limiter.check('ask', 'b').ok).toBe(true); // another client
    expect(limiter.check('create', 'a').ok).toBe(true); // another bucket
  });

  it('uses the create limit for the create bucket', () => {
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1, createsPerMinute: 3 }), () => 0);
    for (let i = 0; i < 3; i++) expect(limiter.check('create', 'a').ok).toBe(true);
    expect(limiter.check('create', 'a').ok).toBe(false);
  });

  it('never tracks more than maxClients, and a flood of new addresses cannot lock a real client out', () => {
    let now = 0;
    const limiter = new RateLimiter(cfg({ asksPerMinute: 2, maxClients: 3 }), () => now);
    expect(limiter.check('ask', 'real').ok).toBe(true);
    expect(limiter.check('ask', 'real').ok).toBe(true);
    expect(limiter.check('ask', 'real').ok).toBe(false); // over its own allowance
    // an attacker floods with distinct addresses
    for (let i = 0; i < 50; i++) limiter.check('ask', 'attacker-' + i);
    expect(limiter.size).toBeLessThanOrEqual(3);
    // the real client is never refused because of the flood: its entry may be evicted (counter
    // reset), which errs towards letting it through; it is never sent to a shared bucket
    expect(limiter.check('ask', 'real').ok).toBe(true);
    expect(limiter.check('ask', 'newcomer').ok).toBe(true);
    expect(limiter.check('ask', 'newcomer-2').ok).toBe(true);
  });

  it('evicts the oldest entry first', () => {
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1, maxClients: 2 }), () => 0);
    limiter.check('ask', 'first');
    limiter.check('ask', 'second');
    limiter.check('ask', 'third'); // evicts "first"
    expect(limiter.check('ask', 'second').ok).toBe(false); // still counted
    expect(limiter.check('ask', 'first').ok).toBe(true); // forgotten: a fresh counter
  });

  it('drops expired entries when the table is full, so it recovers without evicting live ones', () => {
    let now = 0;
    const limiter = new RateLimiter(cfg({ asksPerMinute: 1, maxClients: 2 }), () => now);
    limiter.check('ask', 'a');
    now += 30_000;
    limiter.check('ask', 'b');
    now += 31_000; // "a" has expired, "b" has not
    expect(limiter.check('ask', 'c').ok).toBe(true);
    expect(limiter.check('ask', 'b').ok).toBe(false); // "b" kept its count: only "a" was dropped
  });
});

describe('StreamSlots', () => {
  it('gives each client its allowance and then refuses', () => {
    const slots = new StreamSlots(2);
    const a = slots.acquire('a');
    const b = slots.acquire('a');
    expect(a && b).toBeTruthy();
    expect(slots.acquire('a')).toBeNull();
    expect(slots.acquire('other')).not.toBeNull();
    expect(slots.active).toBe(3);
  });

  it('frees a slot on release, and release is idempotent', () => {
    const slots = new StreamSlots(1);
    const release = slots.acquire('a')!;
    expect(slots.acquire('a')).toBeNull();
    release();
    release();
    release();
    expect(slots.active).toBe(0);
    const again = slots.acquire('a');
    expect(again).not.toBeNull();
    expect(slots.acquire('a')).toBeNull(); // a double release did not hand out extra slots
  });

  it('keeps no entry for a client with nothing streaming', () => {
    const slots = new StreamSlots(3);
    const release = slots.acquire('a')!;
    release();
    expect(slots.active).toBe(0);
  });
});

describe('releaseWhenDone', () => {
  const body = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    });

  it('releases when the body has been read to the end, and passes the bytes and headers through', async () => {
    let released = 0;
    const res = releaseWhenDone(
      new Response(body(['a', 'b']), { status: 200, headers: { 'x-test': '1' } }),
      () => released++,
    );
    expect(released).toBe(0);
    expect(res.headers.get('x-test')).toBe('1');
    expect(await res.text()).toBe('ab');
    expect(released).toBe(1);
  });

  it('releases when the reader cancels (the browser left)', async () => {
    let released = 0;
    const res = releaseWhenDone(new Response(body(['a', 'b', 'c'])), () => released++);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(released).toBe(1);
  });

  it('releases when the source stream fails', async () => {
    let released = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('boom'));
      },
    });
    const res = releaseWhenDone(new Response(failing), () => released++);
    await expect(res.text()).rejects.toThrow();
    expect(released).toBe(1);
  });

  it('releases at once for a response with no body', () => {
    let released = 0;
    releaseWhenDone(new Response(null, { status: 204 }), () => released++);
    expect(released).toBe(1);
  });

  it('releases after the hard limit even when nobody reads or cancels, and stops the source', async () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      let cancelled = false;
      const idle = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined); // never produces anything
        },
        cancel() {
          cancelled = true;
        },
      });
      // the real release (StreamSlots) is idempotent; mirror that here
      let done = false;
      const release = () => {
        if (!done) {
          done = true;
          released++;
        }
      };
      const res = releaseWhenDone(new Response(idle), release, 5_000);
      expect(released).toBe(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(released).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(released).toBe(1);
      expect(cancelled).toBe(true);
      await res.body!.cancel().catch(() => undefined);
      expect(released).toBe(1); // idempotent with the other exits
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a slot held by a client that keeps the connection open but stops reading', async () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      let done = false;
      const release = () => {
        if (!done) {
          done = true;
          released++;
        }
      };
      // plenty of data is available, but nobody reads it: no read is pending when the timer fires
      const endless = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array([1]));
        },
      });
      releaseWhenDone(new Response(endless), release, 5_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(released).toBe(0);
      await vi.advanceTimersByTimeAsync(4_100);
      expect(released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timer after the stream has finished', async () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      const res = releaseWhenDone(new Response(body(['a'])), () => released++, 5_000);
      const text = res.text();
      await vi.advanceTimersByTimeAsync(1);
      expect(await text).toBe('a');
      expect(released).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
