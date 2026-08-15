import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYER_SESSIONS_PER_IP,
  PLAYER_SESSIONS_PER_VENUE,
  RATE_LIMIT_WINDOW_MS,
} from '../src/lib/cache-keys';
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  getClientIP,
  getClientIpDetailed,
  normaliseIp,
  trustedProxyHops,
} from '../src/lib/ip-extractor';
import { createLogger } from '../src/lib/logger';
import { checkRateLimit, consumeRateLimit } from '../src/lib/rate-limiter';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as DbNamespace from '../src/lib/db';
import type * as RedisNamespace from '../src/lib/redis';
import type * as PlayersRoute from '../src/app/api/venues/[venueId]/players/route';

const silent = createLogger({ level: 'silent' });

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://fanboard.test/api/venues/x/players', { method: 'POST', headers });
}

// ---------------------------------------------------------------------------
// Client IP resolution — the half that decides whether any of this works
// ---------------------------------------------------------------------------

describe('getClientIP', () => {
  const original = process.env['TRUSTED_PROXY_HOPS'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['TRUSTED_PROXY_HOPS'];
    } else {
      process.env['TRUSTED_PROXY_HOPS'] = original;
    }
  });

  it('defaults to trusting exactly one proxy', () => {
    delete process.env['TRUSTED_PROXY_HOPS'];
    expect(trustedProxyHops()).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
  });

  it('takes the address the trusted proxy appended', () => {
    expect(getClientIP(request({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('IGNORES attacker-supplied entries to the left of the proxy hop', () => {
    // This is the whole point. Reading the leftmost value -- the usual "get the
    // real client IP" recipe -- lets a caller send a fresh forged address on
    // every request, so the limiter counts to one forever and never fires.
    const spoofed = getClientIP(
      request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' }),
    );
    expect(spoofed).toBe('203.0.113.7');
    expect(spoofed).not.toBe('1.1.1.1');
  });

  it('gives one attacker the same bucket however many addresses they forge', () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) =>
        getClientIP(request({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` })),
      ),
    );
    expect(buckets.size).toBe(1);
    expect([...buckets]).toEqual(['203.0.113.7']);
  });

  it('counts in from the right by the configured hop count', () => {
    process.env['TRUSTED_PROXY_HOPS'] = '2';
    expect(getClientIP(request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
  });

  it('trusts nothing when no proxy is configured', () => {
    process.env['TRUSTED_PROXY_HOPS'] = '0';
    expect(getClientIP(request({ 'x-forwarded-for': '203.0.113.7' }))).toBeNull();
    expect(getClientIP(request({ 'x-real-ip': '203.0.113.7' }))).toBeNull();
  });

  it('falls back to x-real-ip, which proxies overwrite rather than append', () => {
    const resolved = getClientIpDetailed(request({ 'x-real-ip': '198.51.100.4' }));
    expect(resolved).toEqual({ ip: '198.51.100.4', source: 'x-real-ip' });
  });

  it('reports null rather than inventing an address', () => {
    expect(getClientIpDetailed(request())).toEqual({ ip: null, source: 'none' });
    expect(getClientIP(request({ 'x-forwarded-for': '   ' }))).toBeNull();
    expect(getClientIP(request({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
  });

  it('refuses to turn a hostile header into a Redis key', () => {
    for (const hostile of [
      'a'.repeat(500),
      '../../etc/passwd',
      '999.999.999.999',
      '::::::',
      'localhost',
      '1.2.3.4 OR 1=1',
    ]) {
      expect(getClientIP(request({ 'x-forwarded-for': hostile }))).toBeNull();
    }
  });

  it('rejects control characters and injection attempts at the parser', () => {
    // The Request constructor already refuses a CRLF header value, so these
    // cannot arrive over HTTP at all -- but normaliseIp is the layer that must
    // hold if a value ever reaches it another way.
    for (const hostile of ['1.2.3.4\r\nDEL *', '1.2.3.4\nFLUSHALL', 'ratelimit:*', '']) {
      expect(normaliseIp(hostile)).toBeNull();
    }
  });

  it('strips ports', () => {
    expect(normaliseIp('203.0.113.7:44321')).toBe('203.0.113.7');
    expect(normaliseIp('[2001:db8::1]:443')).toBe('2001:db8:0:0::/64');
  });

  it('buckets IPv6 by /64, not by address', () => {
    // A single subscriber gets a /64. Limiting per full address would give one
    // attacker 2^64 free buckets without leaving their own allocation.
    const a = normaliseIp('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = normaliseIp('2001:db8:1234:5678:1111:2222:3333:4444');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:1234:5678::/64');

    const other = normaliseIp('2001:db8:1234:9999::1');
    expect(other).not.toBe(a);
  });

  it('unwraps IPv4-mapped IPv6 to the v4 address it is', () => {
    expect(normaliseIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});

// ---------------------------------------------------------------------------
// Limiter mechanics
// ---------------------------------------------------------------------------

describe('consumeRateLimit', () => {
  function fakeRedis(counts: number[]) {
    let call = 0;
    return vi.fn(async () => {
      const count = counts[call] ?? counts[counts.length - 1] ?? 1;
      call += 1;
      return [count, RATE_LIMIT_WINDOW_MS];
    });
  }

  it('allows up to the limit and rejects beyond it', async () => {
    const evalScript = fakeRedis([1, 2, 3, 4, 5, 6]);
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push((await consumeRateLimit('k', 5, 1000, { evalScript, logger: silent })).allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('namespaces keys so buckets cannot collide with other Redis data', async () => {
    const evalScript = vi.fn(async () => [1, 1000]);
    await consumeRateLimit('player_session:v:1.2.3.4', 5, 1000, { evalScript, logger: silent });
    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      ['ratelimit:player_session:v:1.2.3.4'],
      ['1000'],
    );
  });

  it('arms the expiry in the same atomic script as the increment', async () => {
    // Two round trips would leave a key with no TTL if the process died between
    // them -- locking that client out permanently.
    const evalScript = vi.fn(
      async (_script: string, _keys: string[], _args: string[]) => [1, 1000] as unknown,
    );
    await consumeRateLimit('k', 5, 1000, { evalScript, logger: silent });

    const script = String(evalScript.mock.calls[0]?.[0]);
    expect(script).toContain('INCR');
    expect(script).toContain('PEXPIRE');
    expect(script).toContain('PTTL');
    expect(evalScript).toHaveBeenCalledTimes(1);
  });

  it('re-arms a TTL that has gone missing', async () => {
    const evalScript = vi.fn(async () => [3, -1]);
    const decision = await consumeRateLimit('k', 5, 1000, { evalScript, logger: silent });
    // The script sets it; the negative reply is clamped rather than surfaced.
    expect(decision.resetInMs).toBe(0);
  });

  it('reports remaining window for Retry-After', async () => {
    const evalScript = vi.fn(async () => [6, 1_800_000]);
    const decision = await consumeRateLimit('k', 5, RATE_LIMIT_WINDOW_MS, {
      evalScript,
      logger: silent,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.resetInMs).toBe(1_800_000);
  });

  it('fails open when Redis is unreachable', async () => {
    const evalScript = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const decision = await consumeRateLimit('k', 5, 1000, { evalScript, logger: silent });

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
  });

  it('fails open on a malformed reply rather than throwing', async () => {
    const evalScript = vi.fn(async () => 'unexpected');
    const decision = await consumeRateLimit('k', 5, 1000, { evalScript, logger: silent });
    expect(decision).toMatchObject({ allowed: true, degraded: true });
  });

  it('logs a degraded limiter at error level', async () => {
    const lines: string[] = [];
    const capturing = createLogger({ level: 'error', sink: (line) => lines.push(line) });
    await consumeRateLimit('k', 5, 1000, {
      evalScript: async () => {
        throw new Error('down');
      },
      logger: capturing,
    });
    // A silently disabled rate limiter is the thing nobody notices.
    expect(lines.some((l) => l.includes('failing open'))).toBe(true);
  });

  it('exposes the boolean form the brief specified', async () => {
    const evalScript = vi.fn(async () => [1, 1000]);
    await expect(checkRateLimit('k', 5, 1000, { evalScript, logger: silent })).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Against real Redis
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('rate limiter against real Redis', () => {
  let redis: typeof RedisNamespace;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.com';
    redis = await import('../src/lib/redis');
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('counts a real window and then blocks', async () => {
    const key = `test:${Math.random()}`;
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push((await consumeRateLimit(key, 5, 60_000)).allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('sets a TTL, so a bucket cannot become permanent', async () => {
    const key = `test:${Math.random()}`;
    await consumeRateLimit(key, 5, 30_000);
    const decision = await consumeRateLimit(key, 5, 30_000);
    expect(decision.resetInMs).toBeGreaterThan(0);
    expect(decision.resetInMs).toBeLessThanOrEqual(30_000);
  });

  it('lets requests through again once the window expires', async () => {
    // A real expiry against Redis's own clock. Fake timers cannot move it.
    const key = `test:${Math.random()}`;
    expect((await consumeRateLimit(key, 1, 1000)).allowed).toBe(true);
    expect((await consumeRateLimit(key, 1, 1000)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect((await consumeRateLimit(key, 1, 1000)).allowed).toBe(true);
  });

  it('keeps separate keys independent', async () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    await consumeRateLimit(a, 1, 60_000);
    expect((await consumeRateLimit(a, 1, 60_000)).allowed).toBe(false);
    expect((await consumeRateLimit(b, 1, 60_000)).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route itself
// ---------------------------------------------------------------------------

describe.skipIf(TEST_DATABASE_URL === undefined)('POST /players rate limiting', () => {
  let db: typeof DbNamespace;
  let redis: typeof RedisNamespace;
  let route: typeof PlayersRoute;
  let venueId: UUID;
  let otherVenueId: UUID;

  const PREFIX = 'rl-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.com';
    process.env['TRUSTED_PROXY_HOPS'] = '1';
    db = await import('../src/lib/db');
    redis = await import('../src/lib/redis');
    route = await import('../src/app/api/venues/[venueId]/players/route');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
    await redis.closeRedis();
  });

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}`, hashToken(`k-${name}-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  beforeEach(async () => {
    await cleanup();
    venueId = await seedVenue(`a-${Math.random().toString(36).slice(2)}`);
    otherVenueId = await seedVenue(`b-${Math.random().toString(36).slice(2)}`);
  });

  function join(venue: UUID, ip: string | null, nickname: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ip !== null) {
      headers['x-forwarded-for'] = ip;
    }
    return route.POST(
      new Request(`https://fanboard.test/api/venues/${venue}/players`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nickname }),
      }),
      { params: Promise.resolve({ venueId: venue }) },
    );
  }

  /** A fresh address per test, so buckets never leak between them. */
  function uniqueIp(): string {
    return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  }

  it('allows 5 sessions per IP per venue', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP; i += 1) {
      const response = await join(venueId, ip, `Player${i}`);
      expect(response.status).toBe(201);
    }
  });

  it('rejects the 6th with 429 and a Retry-After header', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP; i += 1) {
      await join(venueId, ip, `Player${i}`);
    }

    const response = await join(venueId, ip, 'Player5');

    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS / 1000);
  });

  it('writes no row for a rejected request', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP + 3; i += 1) {
      await join(venueId, ip, `Player${i}`);
    }

    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM player_sessions WHERE venue_id = $1',
      [venueId],
    );
    expect(count.rows[0]?.count).toBe(String(PLAYER_SESSIONS_PER_IP));
  });

  it('lets a different IP join independently', async () => {
    const blocked = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP + 1; i += 1) {
      await join(venueId, blocked, `P${i}`);
    }
    expect((await join(venueId, blocked, 'Blocked')).status).toBe(429);

    const fresh = await join(venueId, '198.51.100.77', 'Alice');
    expect(fresh.status).toBe(201);
  });

  it('scopes the bucket per venue, so one venue cannot lock out another', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP + 1; i += 1) {
      await join(venueId, ip, `P${i}`);
    }
    expect((await join(venueId, ip, 'Blocked')).status).toBe(429);
    expect((await join(otherVenueId, ip, 'Elsewhere')).status).toBe(201);
  });

  it('cannot be bypassed by forging X-Forwarded-For', async () => {
    // The attack the leftmost-value approach permits: a new fake address on
    // every request. All of these share one bucket because the proxy-appended
    // entry on the right is the only one read.
    const real = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await join(venueId, `10.0.0.${i}, ${real}`, `Spoof${i}`)).status);
    }

    expect(statuses.slice(0, PLAYER_SESSIONS_PER_IP)).toEqual(
      Array.from({ length: PLAYER_SESSIONS_PER_IP }, () => 201),
    );
    expect(statuses.slice(PLAYER_SESSIONS_PER_IP)).toEqual([429, 429, 429]);
  });

  it('rate limits before touching the database or reading the body', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP; i += 1) {
      await join(venueId, ip, `P${i}`);
    }

    // An invalid body would be a 400 if validation ran first; 429 proves the
    // limiter short-circuits ahead of any parsing or insert.
    const response = await route.POST(
      new Request(`https://fanboard.test/api/venues/${venueId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: 'not json at all',
      }),
      { params: Promise.resolve({ venueId }) },
    );
    expect(response.status).toBe(429);
  });

  it('still enforces the venue ceiling when no client IP can be trusted', async () => {
    // A deployment with no proxy loses the per-IP limit entirely. The venue
    // ceiling is what stops that becoming unlimited writes.
    const previous = process.env['TRUSTED_PROXY_HOPS'];
    process.env['TRUSTED_PROXY_HOPS'] = '0';
    try {
      const first = await join(venueId, null, 'NoProxy');
      expect(first.status).toBe(201);

      // Burn the venue budget.
      await redis.set(
        `ratelimit:player_session_venue:${venueId}`,
        String(PLAYER_SESSIONS_PER_VENUE + 1),
        3600,
      );

      const blocked = await join(venueId, null, 'Blocked');
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { error: { details: { scope: string } } };
      expect(body.error.details.scope).toBe('venue');
    } finally {
      if (previous === undefined) {
        delete process.env['TRUSTED_PROXY_HOPS'];
      } else {
        process.env['TRUSTED_PROXY_HOPS'] = previous;
      }
    }
  });

  it('does not spend the venue budget on a request the IP limit already rejected', async () => {
    // Otherwise one abusive host could exhaust the shared ceiling and lock out
    // every real patron -- the limiter causing the outage it prevents.
    const ip = uniqueIp();
    const venueKey = `ratelimit:player_session_venue:${venueId}`;
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP; i += 1) {
      await join(venueId, ip, `P${i}`);
    }
    const spent = Number(await redis.get(venueKey));

    for (let i = 0; i < 10; i += 1) {
      await join(venueId, ip, `Rejected${i}`);
    }

    expect(Number(await redis.get(venueKey))).toBe(spent);
  });

  it('still sets the session cookie on an allowed request', async () => {
    const response = await join(venueId, uniqueIp(), 'Cookied');
    expect(response.status).toBe(201);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('session_token=');
    expect(cookie).toContain('HttpOnly');
  });

  it('returns a 429 body that leaks nothing', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < PLAYER_SESSIONS_PER_IP + 1; i += 1) {
      await join(venueId, ip, `P${i}`);
    }
    const response = await join(venueId, ip, 'Blocked');
    const text = await response.text();

    expect(text).not.toContain(ip);
    expect(text).not.toContain('session_token');
    expect(text.toLowerCase()).not.toContain('redis');
  });
});
