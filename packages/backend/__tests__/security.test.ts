import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as AuthNamespace from '../src/lib/auth';
import type * as DbNamespace from '../src/lib/db';
import type * as RedisNamespace from '../src/lib/redis';
import type * as MiddlewareNamespace from '../src/middleware';
import type * as ApiKeysNamespace from '../src/services/api-keys';
import type * as HealthRoute from '../src/app/api/health/route';
import type * as RotateRoute from '../src/app/api/admin/venues/[venueId]/rotate-key/route';

/**
 * The controls that only exist to be exercised by an attacker.
 *
 * Everything here is written from the refusal side: the assertions that matter
 * are the ones proving a request is *denied*, since a permissive bug in any of
 * this fails silently and looks exactly like working software.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PREFIX = 'sec-int';

// ---------------------------------------------------------------------------
// CORS — pure request/response, no infrastructure needed
// ---------------------------------------------------------------------------

describe('CORS middleware', () => {
  let mw: typeof MiddlewareNamespace;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    mw = await import('../src/middleware');
  });

  /**
   * @types/node declares NODE_ENV as read-only, so it cannot be assigned
   * through `process.env` directly. The variable is an ordinary string at
   * runtime; this is a types-only restriction, and the middleware reads it the
   * same way regardless.
   */
  function setEnv(name: string, value: string | undefined): void {
    const env = process.env as Record<string, string | undefined>;
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }

  afterEach(() => {
    setEnv('NODE_ENV', originalEnv['NODE_ENV']);
    setEnv('CORS_ALLOWED_ORIGINS', originalEnv['CORS_ALLOWED_ORIGINS']);
  });

  function request(
    origin: string | null,
    init: { method?: string; proto?: string; path?: string } = {},
  ): Request {
    const headers = new Headers();
    if (origin !== null) {
      headers.set('origin', origin);
    }
    if (init.proto !== undefined) {
      headers.set('x-forwarded-proto', init.proto);
    }
    return new Request(
      `https://api.fanboard.test${init.path ?? '/api/venues/x/games'}`,
      { method: init.method ?? 'GET', headers },
    );
  }

  /** NextRequest and Request share the surface middleware actually reads. */
  function run(req: Request): Response {
    return mw.middleware(req as never);
  }

  it('allows every client dev origin, not just the two in the brief', () => {
    // admin-web is 3001, but mobile-web is 3002 and fire-tv is 3003. Omitting
    // them would break the phone and the TV the first time either was pointed
    // at the API directly rather than through the Vite proxy.
    for (const port of [3000, 3001, 3002, 3003]) {
      const response = run(request(`http://localhost:${port}`));
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        `http://localhost:${port}`,
      );
    }
  });

  it('withholds CORS headers from an unknown origin', () => {
    const response = run(request('https://evil.example'));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('never answers with a wildcard, which credentials mode forbids', () => {
    const response = run(request('http://localhost:3002'));
    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('varies on Origin so a shared cache cannot leak one origin’s allowance', () => {
    const response = run(request('http://localhost:3002'));
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('passes through a request with no Origin header', () => {
    // curl, server-to-server, same-origin navigation. Not a CORS case at all.
    const response = run(request(null));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers a valid preflight with 204 and the allowed methods', () => {
    const response = run(request('http://localhost:3001', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('refuses a preflight from an unknown origin with 403', () => {
    const response = run(request('https://evil.example', { method: 'OPTIONS' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('trusts no origin in production until one is configured', () => {
    // A deployment that forgets CORS_ALLOWED_ORIGINS must fail closed. Leaking
    // the dev allowlist into production would make localhost a trusted origin
    // on the public internet.
    setEnv('NODE_ENV', 'production');
    setEnv('CORS_ALLOWED_ORIGINS', '');

    expect(mw.isOriginAllowed('http://localhost:3001')).toBe(false);
    expect(mw.allowedOrigins().size).toBe(0);
  });

  it('allows exactly the configured production origins', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('CORS_ALLOWED_ORIGINS', 'https://app.fanboard.com, https://tv.fanboard.com');

    expect(mw.isOriginAllowed('https://app.fanboard.com')).toBe(true);
    expect(mw.isOriginAllowed('https://tv.fanboard.com')).toBe(true);
    expect(mw.isOriginAllowed('https://app.fanboard.com.evil.example')).toBe(false);
    expect(mw.isOriginAllowed('http://app.fanboard.com')).toBe(false);
  });

  it('sends HSTS in production and never in development', () => {
    // A dev server sending HSTS pins localhost to https in the developer's
    // browser for a year — a breakage that outlives the process causing it.
    expect(run(request(null)).headers.get('Strict-Transport-Security')).toBeNull();

    setEnv('NODE_ENV', 'production');
    const production = run(request(null));
    expect(production.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  });

  it('redirects plain HTTP to HTTPS in production, preserving the method', () => {
    setEnv('NODE_ENV', 'production');
    const response = run(request(null, { method: 'POST', proto: 'http' }));

    // 308, not 302: a 302 would let the retry become a GET and silently drop
    // the body of a POST.
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toMatch(/^https:/);
  });

  it('never redirects the health probe, even over plain HTTP in production', () => {
    // Caught by running the built image rather than by any unit test: Next sets
    // x-forwarded-proto: http on a direct connection, so the probe was getting
    // a 308. A liveness probe reads that as a failure and the orchestrator
    // restarts a perfectly healthy container, forever.
    setEnv('NODE_ENV', 'production');

    const response = run(request(null, { proto: 'http', path: '/api/health' }));
    expect(response.status).not.toBe(308);

    // Everything else still gets pushed to HTTPS.
    expect(run(request(null, { proto: 'http', path: '/api/venues/x/picks' })).status).toBe(308);
  });

  it('applies nosniff and frame-deny to every response', () => {
    const response = run(request(null));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------
// API key rotation, health — against real infrastructure
// ---------------------------------------------------------------------------

describe.skipIf(TEST_DATABASE_URL === undefined)('api key rotation', () => {
  let db: typeof DbNamespace;
  let redis: typeof RedisNamespace;
  let apiKeys: typeof ApiKeysNamespace;
  let rotateRoute: typeof RotateRoute;
  let healthRoute: typeof HealthRoute;
  let auth: typeof AuthNamespace;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.test';

    db = await import('../src/lib/db');
    redis = await import('../src/lib/redis');
    apiKeys = await import('../src/services/api-keys');
    auth = await import('../src/lib/auth');
    rotateRoute = await import('../src/app/api/admin/venues/[venueId]/rotate-key/route');
    healthRoute = await import('../src/app/api/health/route');

    await cleanup();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.closePool();
    await redis.closeRedis();
  }, 30_000);

  /** Seeds a venue and returns its id plus the raw key. */
  async function seedVenue(): Promise<{ venueId: UUID; apiKey: string }> {
    const apiKey = apiKeys.generateApiKey();
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${Math.random().toString(36).slice(2)}`, hashToken(apiKey)],
    );
    return { venueId: trustedUuid(row.rows[0]!.id), apiKey };
  }

  function rotate(venueId: UUID, key: string): Promise<Response> {
    return rotateRoute.POST(
      new Request(`https://fanboard.test/api/admin/venues/${venueId}/rotate-key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      }),
      { params: Promise.resolve({ venueId }) },
    );
  }

  function revoke(venueId: UUID, key: string): Promise<Response> {
    return rotateRoute.DELETE(
      new Request(`https://fanboard.test/api/admin/venues/${venueId}/rotate-key`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${key}` },
      }),
      { params: Promise.resolve({ venueId }) },
    );
  }

  /** Does this key authenticate as this venue right now? */
  async function keyWorks(key: string, venueId: UUID): Promise<boolean> {
    try {
      const context = await auth.adminMiddleware()(
        new Request('https://fanboard.test/api/admin/x', {
          headers: { authorization: `Bearer ${key}` },
        }),
      );
      return context.venueId === venueId;
    } catch {
      return false;
    }
  }

  it('issues a new key that authenticates', async () => {
    const { venueId, apiKey } = await seedVenue();

    const response = await rotate(venueId, apiKey);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { apiKey: string; previousKeyExpiresAt: string };
    expect(body.apiKey).not.toBe(apiKey);
    expect(await keyWorks(body.apiKey, venueId)).toBe(true);
  }, 30_000);

  it('keeps the old key working through the grace window', async () => {
    // The whole point. If rotation severed live clients instantly, an operator
    // would learn that once and never rotate again.
    const { venueId, apiKey } = await seedVenue();
    await rotate(venueId, apiKey);

    expect(await keyWorks(apiKey, venueId)).toBe(true);
  }, 30_000);

  it('stores only hashes, never a usable key', async () => {
    const { venueId, apiKey } = await seedVenue();
    const response = await rotate(venueId, apiKey);
    const body = (await response.json()) as { apiKey: string };

    const stored = await db.query<{ api_key: string; previous_api_key: string | null }>(
      'SELECT api_key, previous_api_key FROM venues WHERE id = $1::uuid',
      [venueId],
    );
    expect(stored.rows[0]?.api_key).toBe(hashToken(body.apiKey));
    expect(stored.rows[0]?.api_key).not.toBe(body.apiKey);
    expect(stored.rows[0]?.previous_api_key).toBe(hashToken(apiKey));
  }, 30_000);

  it('stops accepting the old key once revoked', async () => {
    const { venueId, apiKey } = await seedVenue();
    const rotated = (await (await rotate(venueId, apiKey)).json()) as { apiKey: string };

    const response = await revoke(venueId, rotated.apiKey);
    expect(response.status).toBe(200);
    expect((await response.json()) as { revoked: boolean }).toEqual({ revoked: true });

    expect(await keyWorks(apiKey, venueId)).toBe(false);
    expect(await keyWorks(rotated.apiKey, venueId)).toBe(true);
  }, 30_000);

  it('reports revoked:false when there was nothing to revoke', async () => {
    // Idempotent on purpose: someone reacting to a suspected leak should not
    // have to reason about whether the first attempt took.
    const { venueId, apiKey } = await seedVenue();
    const response = await revoke(venueId, apiKey);
    expect((await response.json()) as { revoked: boolean }).toEqual({ revoked: false });
  }, 30_000);

  it('refuses to accept an expired grace key', async () => {
    const { venueId, apiKey } = await seedVenue();
    await rotate(venueId, apiKey);

    // Wind the window back rather than waiting 24 hours for it.
    await db.query(
      `UPDATE venues SET previous_api_key_expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = $1::uuid`,
      [venueId],
    );

    expect(await keyWorks(apiKey, venueId)).toBe(false);
  }, 30_000);

  it('refuses rotation from an unauthenticated caller', async () => {
    const { venueId } = await seedVenue();
    const response = await rotateRoute.POST(
      new Request(`https://fanboard.test/api/admin/venues/${venueId}/rotate-key`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ venueId }) },
    );
    expect(response.status).toBe(401);
  }, 30_000);

  it('refuses to let one venue rotate another venue’s key', async () => {
    // The privilege-escalation case: a valid credential for venue A must not
    // reach venue B by editing the URL.
    const a = await seedVenue();
    const b = await seedVenue();

    const response = await rotate(b.venueId, a.apiKey);
    expect(response.status).toBe(403);

    // And B's key is untouched.
    expect(await keyWorks(b.apiKey, b.venueId)).toBe(true);
  }, 30_000);

  it('never writes the key into the audit trail', async () => {
    const { venueId, apiKey } = await seedVenue();
    const body = (await (await rotate(venueId, apiKey)).json()) as { apiKey: string };

    const entries = await db.query<{ details: unknown }>(
      `SELECT details FROM audit_logs WHERE venue_id = $1::uuid AND action = 'venue.api_key.rotated'`,
      [venueId],
    );
    expect(entries.rows.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(entries.rows);
    expect(serialised).not.toContain(body.apiKey);
    expect(serialised).not.toContain(apiKey);
  }, 30_000);

  it('reports 503 when the worker scheduler is not running', async () => {
    // No scheduler runs in a test process, which is precisely the condition
    // this check exists to catch: a host that answers HTTP perfectly well
    // while games quietly stop grading. Reachable database and Redis are not
    // enough to call the service healthy.
    delete process.env['WORKERS_ENABLED'];

    const response = await healthRoute.GET();
    const body = (await response.json()) as {
      status: string;
      dependencies: {
        database: { healthy: boolean };
        redis: { healthy: boolean };
        workers: { healthy: boolean; running: boolean };
      };
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.database.healthy).toBe(true);
    expect(body.dependencies.redis.healthy).toBe(true);
    expect(body.dependencies.workers.healthy).toBe(false);
    expect(body.dependencies.workers.running).toBe(false);
  }, 30_000);

  it('reports 200 when workers are intentionally disabled', async () => {
    // A web-only deployment sets WORKERS_ENABLED=false — the same flag
    // instrumentation.ts reads — and must not be marked down for honouring it.
    process.env['WORKERS_ENABLED'] = 'false';
    try {
      const response = await healthRoute.GET();
      const body = (await response.json()) as {
        status: string;
        dependencies: { database: { healthy: boolean }; redis: { healthy: boolean } };
      };

      expect(response.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.dependencies.database.healthy).toBe(true);
      expect(body.dependencies.redis.healthy).toBe(true);
    } finally {
      delete process.env['WORKERS_ENABLED'];
    }
  }, 30_000);

  it('leaks nothing about the infrastructure from the health endpoint', async () => {
    // Unauthenticated by necessity — a load balancer has no credential — so it
    // must reveal dependency names and booleans and nothing else.
    const body = await (await healthRoute.GET()).text();

    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('redis://');
    expect(body).not.toContain('password');
    expect(body).not.toMatch(/localhost:\d+/);
  }, 30_000);
});
