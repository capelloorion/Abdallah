import { errorResponse } from '@/lib/bff-json';
import { log } from '@/lib/logger';
import { recordRateLimited } from '@/lib/metrics';
import { STREAM_TIMEOUT_MS } from '@/lib/stream';

/**
 * Per-client limits at the BFF (web 4.2): how often one client may ask or start a chat, and how
 * many answers it may have streaming at once. The api only ever sees the BFF, so only the BFF
 * can tell clients apart (api 5.2 keeps its own global caps).
 *
 * IN MEMORY, PER PROCESS, BY DESIGN: with several replicas the allowance multiplies, and a
 * shared store would need an ADR.
 *
 * WHAT IS BOUNDED, AND HOW IT FAILS: the table of counters holds at most `maxClients` entries,
 * and expired ones are dropped. When it is full the OLDEST entry is evicted to make room, so a
 * flood of distinct addresses can never lock a real client out: the worst it does is reset
 * someone's counter, which errs towards letting a request through. (Telling an attacker's many
 * addresses from many real clients is not possible here; an IPv6 client is keyed by its /64, the
 * smallest block one subscriber normally holds, so one host cannot mint endless identities.)
 *
 * PRIVACY: the client address is only ever a map key. It is never logged, never a metric
 * attribute, never returned, and gone with the process.
 */
export type RateBucket = 'ask' | 'create';

export interface RateLimitConfig {
  asksPerMinute: number;
  createsPerMinute: number;
  streamsPerClient: number;
  /** How many proxies we trust: the address in `x-forwarded-for` this many entries from the END. */
  trustedHops: number;
  maxClients: number;
  windowMs: number;
}

export const RATE_LIMIT_DEFAULTS: RateLimitConfig = {
  asksPerMinute: 10,
  createsPerMinute: 20,
  streamsPerClient: 2,
  trustedHops: 1,
  maxClients: 10_000,
  windowMs: 60_000,
};

/** Upper bounds, so a typo cannot turn a limit into "no limit". */
const CEILING = {
  asksPerMinute: 10_000,
  createsPerMinute: 10_000,
  streamsPerClient: 100,
  trustedHops: 10,
  maxClients: 1_000_000,
} as const;

function positiveInt(raw: string | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n >= 1 && n <= ceiling ? n : fallback;
}

/** Read the limits from the environment; anything invalid or out of range falls back to the default. */
export function readRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): RateLimitConfig {
  return {
    asksPerMinute: positiveInt(
      env.RATE_LIMIT_ASKS_PER_MINUTE,
      RATE_LIMIT_DEFAULTS.asksPerMinute,
      CEILING.asksPerMinute,
    ),
    createsPerMinute: positiveInt(
      env.RATE_LIMIT_CREATES_PER_MINUTE,
      RATE_LIMIT_DEFAULTS.createsPerMinute,
      CEILING.createsPerMinute,
    ),
    streamsPerClient: positiveInt(
      env.RATE_LIMIT_STREAMS_PER_CLIENT,
      RATE_LIMIT_DEFAULTS.streamsPerClient,
      CEILING.streamsPerClient,
    ),
    trustedHops: positiveInt(
      env.RATE_LIMIT_TRUSTED_PROXY_HOPS,
      RATE_LIMIT_DEFAULTS.trustedHops,
      CEILING.trustedHops,
    ),
    maxClients: positiveInt(
      env.RATE_LIMIT_MAX_CLIENTS,
      RATE_LIMIT_DEFAULTS.maxClients,
      CEILING.maxClients,
    ),
    windowMs: RATE_LIMIT_DEFAULTS.windowMs,
  };
}

export const UNKNOWN_CLIENT = 'unknown';
const MAX_ENTRY_CHARS = 64;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4(value: string): string | null {
  const m = IPV4.exec(value);
  if (!m || m.slice(1).some((octet) => Number(octet) > 255)) return null;
  return m
    .slice(1)
    .map((octet) => String(Number(octet)))
    .join('.');
}

/** Expand an IPv6 address to eight 16-bit groups, or `null` when it is not one. */
function ipv6Groups(value: string): number[] | null {
  if (!/^[0-9a-f:.]{2,45}$/.test(value) || !value.includes(':')) return null;
  let text = value;
  // a trailing dotted quad (::ffff:1.2.3.4) is two groups
  const dotted = /(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = ipv4(dotted[2]);
    if (!v4) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * One key per client: IPv4 as dotted decimal; IPv6 by its /64 (the first four groups), with an
 * IPv4-mapped address (`::ffff:1.2.3.4`) treated as that IPv4 address. Ports, brackets and zone
 * ids are dropped. Anything else is the shared "unknown" client.
 */
function normaliseAddress(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value === '' || value.length > MAX_ENTRY_CHARS) return UNKNOWN_CLIENT;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value); // [::1]:443
  if (bracketed) value = bracketed[1];
  else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value); // 1.2.3.4:5678
    if (withPort) value = withPort[1];
  }
  value = value.split('%')[0]; // a zone id (fe80::1%eth0) is not part of the address
  const v4 = ipv4(value);
  if (v4) return v4;
  const groups = ipv6Groups(value);
  if (!groups) return UNKNOWN_CLIENT;
  // ::ffff:a.b.c.d (and ::a.b.c.d is not mapped: only ::ffff:) is the IPv4 client
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * Who is calling: the address the platform ingress appended to `x-forwarded-for`, counting
 * `hops` entries from the END. Entries before it were written by the client and are never used:
 * a browser that sends `x-forwarded-for: 9.9.9.9` only adds an entry in front of the real one,
 * however long it makes the header. No readable address means the one shared "unknown" client
 * (which is therefore stricter per caller, as everyone without an address shares one allowance).
 */
export function clientKey(headers: Headers, hops: number): string {
  const raw = headers.get('x-forwarded-for');
  if (!raw) return UNKNOWN_CLIENT;
  const parts = raw.split(',').filter((p) => p.trim() !== '');
  const entry = parts[parts.length - hops];
  return entry === undefined ? UNKNOWN_CLIENT : normaliseAddress(entry);
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Counter {
  start: number;
  count: number;
}

/** A fixed-window counter per (bucket, client), with a bounded table. */
export class RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private lastPurge = 0;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.counters.size;
  }

  private limitFor(bucket: RateBucket): number {
    return bucket === 'ask' ? this.config.asksPerMinute : this.config.createsPerMinute;
  }

  private purge(now: number): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.start >= this.config.windowMs) this.counters.delete(key);
    }
    this.lastPurge = now;
  }

  /** Make room for a new key: drop expired entries, then, if still full, the oldest one. */
  private makeRoom(now: number): void {
    if (now - this.lastPurge >= 1000) this.purge(now); // at most once a second
    while (this.counters.size >= this.config.maxClients) {
      const oldest = this.counters.keys().next().value;
      if (oldest === undefined) break;
      this.counters.delete(oldest);
    }
  }

  check(bucket: RateBucket, client: string): RateDecision {
    const now = this.now();
    const key = `${bucket}:${client}`;
    let counter = this.counters.get(key);
    if (counter && now - counter.start >= this.config.windowMs) {
      this.counters.delete(key); // expired: start over, as the newest entry
      counter = undefined;
    }
    if (!counter) {
      if (this.counters.size >= this.config.maxClients) this.makeRoom(now);
      counter = { start: now, count: 0 };
      this.counters.set(key, counter);
    }
    if (counter.count >= this.limitFor(bucket)) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((counter.start + this.config.windowMs - now) / 1000),
      );
      return { ok: false, retryAfterSeconds };
    }
    counter.count += 1;
    return { ok: true };
  }
}

/** Answers one client may have streaming at once. Entries exist only while a stream is open. */
export class StreamSlots {
  private readonly open = new Map<string, number>();

  constructor(private readonly perClient: number) {}

  get active(): number {
    let total = 0;
    for (const n of this.open.values()) total += n;
    return total;
  }

  /** A release function, or `null` when this client already has its allowance streaming. */
  acquire(client: string): (() => void) | null {
    const current = this.open.get(client) ?? 0;
    if (current >= this.perClient) return null;
    this.open.set(client, current + 1);
    let released = false;
    return () => {
      if (released) return; // idempotent: every exit path may call it
      released = true;
      const left = (this.open.get(client) ?? 1) - 1;
      if (left <= 0) this.open.delete(client);
      else this.open.set(client, left);
    };
  }
}

let state: { config: RateLimitConfig; limiter: RateLimiter; slots: StreamSlots } | undefined;

function current() {
  if (!state) {
    const config = readRateLimitConfig();
    state = {
      config,
      limiter: new RateLimiter(config),
      slots: new StreamSlots(config.streamsPerClient),
    };
  }
  return state;
}

/** TEST-ONLY: forget the limits, so the next request re-reads the environment. */
export function __resetRateLimitForTests(): void {
  state = undefined;
}

/** How long a client that hit its stream cap is asked to wait. */
const STREAM_RETRY_AFTER_SECONDS = 5;

function tooMany(traceId: string, routeClass: string, retryAfterSeconds: number): Response {
  recordRateLimited(routeClass);
  log('info', 'bff rate limited', { route: routeClass }); // no client address, ever
  const res = errorResponse('rate_limited', 429, traceId);
  res.headers.set('retry-after', String(retryAfterSeconds));
  return res;
}

/** `429` when this client is over its allowance for `bucket`, else `null` (carry on). */
export function enforceRateLimit(
  req: Request,
  bucket: RateBucket,
  routeClass: string,
  traceId: string,
): Response | null {
  const { limiter, config } = current();
  const decision = limiter.check(bucket, clientKey(req.headers, config.trustedHops));
  return decision.ok ? null : tooMany(traceId, routeClass, decision.retryAfterSeconds);
}

/** A slot for one streaming answer, or the `429` to return when the client has no slot left. */
export function acquireStreamSlot(
  req: Request,
  routeClass: string,
  traceId: string,
): { release: () => void } | { limited: Response } {
  const { slots, config } = current();
  const release = slots.acquire(clientKey(req.headers, config.trustedHops));
  return release
    ? { release }
    : { limited: tooMany(traceId, routeClass, STREAM_RETRY_AFTER_SECONDS) };
}

/**
 * Release the slot when the response body ends, fails or is cancelled (the browser left), and
 * ALSO after `maxMs` whatever happens: a client that keeps its connection open but stops reading
 * would otherwise hold the slot until the socket closes. When the timer fires the body is
 * cancelled, so the upstream answer stops too.
 */
export function releaseWhenDone(
  res: Response,
  release: () => void,
  maxMs: number = STREAM_TIMEOUT_MS,
): Response {
  if (!res.body) {
    release();
    return res;
  }
  const reader = res.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (timer) clearTimeout(timer);
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        release();
        reader.cancel().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed or errored: nothing left to end
        }
      }, maxMs);
      timer.unref?.(); // never keep the process alive for this
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        finish();
        try {
          controller.error(err);
        } catch {
          // the timer already closed it
        }
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}
