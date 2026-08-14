import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDeviceScope, deviceMiddleware } from '../src/lib/auth';
import { DISPLAY_TTL_SECONDS, displayKey } from '../src/lib/cache-keys';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import { ApiError } from '../src/lib/errors';
import { createLogger } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import {
  MAX_DISPLAY_GAMES,
  buildQrCode,
  getDisplayPayload,
  type DisplayServiceDeps,
} from '../src/services/display';
import type * as DbNamespace from '../src/lib/db';
import type * as DevicesNamespace from '../src/services/devices';
import type * as DisplayNamespace from '../src/services/display';

const silent = createLogger({ level: 'silent' });

const VENUE_A = trustedUuid('11111111-1111-1111-1111-111111111111');
const DEVICE_A = trustedUuid('44444444-4444-4444-4444-444444444444');
const DEVICE_B = trustedUuid('55555555-5555-5555-5555-555555555555');

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

function gameRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    league: 'NFL',
    home_team: 'Bears',
    away_team: 'Packers',
    home_score: null,
    away_score: null,
    status: 'scheduled',
    scheduled_at: new Date('2025-01-19T18:00:00Z'),
    home_logo_url: 'https://example.test/h.png',
    away_logo_url: 'https://example.test/a.png',
    ...overrides,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    rank: 1,
    player_session_id: 'bbbbbbbb-0000-0000-0000-000000000001',
    nickname: 'Alice',
    wins: 2,
    losses: 1,
    points: 20,
    ...overrides,
  };
}

function fakeDb(options: { games?: unknown[]; leaderboard?: unknown[] } = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db: SqlExecutor = {
    query: async <T,>(sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = sql.includes('FROM games')
        ? (options.games ?? [gameRow()])
        : (options.leaderboard ?? [snapshotRow()]);
      return result(rows as T[]);
    },
  };
  return { db, calls };
}

function fakeCache(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const written: { key: string; value: string; ttl?: number }[] = [];
  return {
    store,
    written,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, ttl?: number) => {
      store.set(key, value);
      written.push({ key, value, ...(ttl === undefined ? {} : { ttl }) });
    }),
  };
}

function deps(overrides: Partial<DisplayServiceDeps>): Partial<DisplayServiceDeps> {
  return {
    logger: silent,
    publicBaseUrl: () => 'https://fanboard.com',
    ...overrides,
  };
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected rejection with ${status}, but it resolved`);
}

// ---------------------------------------------------------------------------

describe('buildQrCode', () => {
  it('points at the venue join URL', () => {
    expect(buildQrCode('https://fanboard.com', VENUE_A)).toBe(`https://fanboard.com/v/${VENUE_A}`);
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildQrCode('https://fanboard.com/', VENUE_A)).toBe(`https://fanboard.com/v/${VENUE_A}`);
  });
});

describe('display payload', () => {
  it('returns games and leaderboard together', async () => {
    const { db } = fakeDb();
    const cache = fakeCache();

    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));

    expect(payload.qrCode).toBe(`https://fanboard.com/v/${VENUE_A}`);
    expect(payload.games).toHaveLength(1);
    expect(payload.games[0]).toMatchObject({
      league: 'NFL',
      homeTeam: 'Bears',
      awayTeam: 'Packers',
      status: 'scheduled',
    });
    expect(payload.leaderboard).toEqual([
      { rank: 1, nickname: 'Alice', wins: 2, losses: 1, points: 20 },
    ]);
    expect(payload.refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('orders games so the client can group LIVE / COMING_UP / FINAL in one pass', async () => {
    const { db, calls } = fakeDb();
    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    const gameQuery = calls.find((call) => call.sql.includes('FROM games'));
    expect(gameQuery?.sql).toContain("WHEN 'live'      THEN 0");
    expect(gameQuery?.sql).toContain("WHEN 'scheduled' THEN 1");
    expect(gameQuery?.sql).toContain('scheduled_at ASC');
  });

  it('carries every status through untouched so the client can section them', async () => {
    const { db } = fakeDb({
      games: [
        gameRow({ id: 'g-live', status: 'live', home_score: 14, away_score: 7 }),
        gameRow({ id: 'g-next', status: 'scheduled' }),
        gameRow({ id: 'g-done', status: 'final', home_score: 24, away_score: 17 }),
      ],
    });

    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    expect(payload.games.map((game) => [game.id, game.status])).toEqual([
      ['g-live', 'live'],
      ['g-next', 'scheduled'],
      ['g-done', 'final'],
    ]);
    expect(payload.games[0]?.homeScore).toBe(14);
  });

  it('reports quarter, period and inning as null', async () => {
    // No column holds them and eventsday.php does not return them; the fields
    // exist so the client can be written against the final contract.
    const { db } = fakeDb();
    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    expect(payload.games[0]).toMatchObject({ quarter: null, period: null, inning: null });
  });

  it('scopes both queries to the venue', async () => {
    const { db, calls } = fakeDb();
    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.params[0]).toBe(VENUE_A);
      expect(call.sql).toContain('venue_id = $1::uuid');
    }
  });

  it('bounds the number of games it will return', async () => {
    const { db, calls } = fakeDb();
    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    const gameQuery = calls.find((call) => call.sql.includes('FROM games'));
    expect(gameQuery?.params[1]).toBe(MAX_DISPLAY_GAMES);
  });

  it('reads the leaderboard from the materialised snapshot, not from picks', async () => {
    const { db, calls } = fakeDb();
    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    const boardQuery = calls.find((call) => call.sql.includes('leaderboard_snapshot'));
    expect(boardQuery).toBeDefined();
    expect(boardQuery?.params[1]).toBe('daily');
    for (const call of calls) {
      expect(call.sql).not.toContain('FROM picks');
    }
  });
});

describe('display payload — caching', () => {
  it('caches the payload for 10 seconds under the device key', async () => {
    const { db } = fakeDb();
    const cache = fakeCache();

    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));

    expect(cache.written).toHaveLength(1);
    expect(cache.written[0]?.key).toBe(displayKey(DEVICE_A));
    expect(cache.written[0]?.ttl).toBe(DISPLAY_TTL_SECONDS);
  });

  it('serves a second poll from cache without touching the database', async () => {
    const { db, calls } = fakeDb();
    const cache = fakeCache();

    const first = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));
    const second = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.payload).toEqual(first.payload);
    // Two statements total, from the first call only.
    expect(calls).toHaveLength(2);
  });

  it('keys the cache per device', async () => {
    const { db, calls } = fakeDb();
    const cache = fakeCache();

    await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));
    await getDisplayPayload(DEVICE_B, VENUE_A, deps({ db, ...cache }));

    expect(cache.store.has(displayKey(DEVICE_A))).toBe(true);
    expect(cache.store.has(displayKey(DEVICE_B))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('falls through to the database when Redis is unavailable', async () => {
    const { db } = fakeDb();
    const { payload } = await getDisplayPayload(
      DEVICE_A,
      VENUE_A,
      deps({
        db,
        cacheGet: async () => {
          throw new Error('redis down');
        },
        cacheSet: async () => {
          throw new Error('redis down');
        },
      }),
    );

    expect(payload.games).toHaveLength(1);
  });

  it('ignores a poisoned cache entry rather than serving it', async () => {
    const { db } = fakeDb();
    const cache = fakeCache({ [displayKey(DEVICE_A)]: 'not json at all' });

    const { payload, cached } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...cache }));

    expect(cached).toBe(false);
    expect(payload.games).toHaveLength(1);
  });
});

describe('display payload — data exposure', () => {
  it('never includes player_session_id', async () => {
    const { db } = fakeDb();
    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('bbbbbbbb-0000-0000-0000-000000000001');
    expect(serialised).not.toContain('playerSessionId');
    expect(serialised).not.toContain('player_session_id');
  });

  it('never includes credentials or admin fields', async () => {
    const { db } = fakeDb();
    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    const serialised = JSON.stringify(payload).toLowerCase();
    for (const forbidden of [
      'api_key',
      'apikey',
      'display_key',
      'displaykey',
      'session_token',
      'sessiontoken',
      'password',
      'secret',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('exposes exactly the documented top-level shape', async () => {
    const { db } = fakeDb();
    const { payload } = await getDisplayPayload(DEVICE_A, VENUE_A, deps({ db, ...fakeCache() }));

    expect(Object.keys(payload).sort()).toEqual([
      'games',
      'leaderboard',
      'qrCode',
      'refreshedAt',
    ]);
    expect(Object.keys(payload.leaderboard[0] ?? {}).sort()).toEqual([
      'losses',
      'nickname',
      'points',
      'rank',
      'wins',
    ]);
  });
});

describe('display key scope', () => {
  function dbWithDevice(rawKey: string, deviceId: UUID, venueId: UUID): SqlExecutor {
    return {
      query: async <T,>(_sql: string, params?: readonly unknown[]) => {
        const presented = String(params?.[0] ?? '');
        return (presented === hashToken(rawKey)
          ? result([{ id: deviceId, venue_id: venueId }])
          : result([])) as SqlResult<T>;
      },
    };
  }

  const RAW_KEY = 'display-key-abcdefghijklmnop';

  it('accepts the device its key was issued for', async () => {
    const db = dbWithDevice(RAW_KEY, DEVICE_A, VENUE_A);
    const request = new Request('https://fanboard.test/x', {
      headers: { 'x-display-key': RAW_KEY },
    });

    const context = await deviceMiddleware({ db })(request);
    expect(() => assertDeviceScope(context, DEVICE_A)).not.toThrow();
  });

  it('rejects a display key used against another device with 404', async () => {
    // Without this, a paired display could read any other display by editing
    // the URL, since the path id is redundant with the authenticated one.
    const db = dbWithDevice(RAW_KEY, DEVICE_A, VENUE_A);
    const request = new Request('https://fanboard.test/x', {
      headers: { 'x-display-key': RAW_KEY },
    });

    const context = await deviceMiddleware({ db })(request);
    try {
      assertDeviceScope(context, DEVICE_B);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('rejects an unknown display key with 401', async () => {
    const db = dbWithDevice(RAW_KEY, DEVICE_A, VENUE_A);
    const request = new Request('https://fanboard.test/x', {
      headers: { 'x-display-key': 'not-the-real-key' },
    });

    await expectApiError(deviceMiddleware({ db })(request), 401);
  });

  it('rejects a session cookie presented instead of a display key', async () => {
    const db = dbWithDevice(RAW_KEY, DEVICE_A, VENUE_A);
    const request = new Request('https://fanboard.test/x', {
      headers: { cookie: `session_token=${RAW_KEY}` },
    });

    await expectApiError(deviceMiddleware({ db })(request), 401);
  });
});

// ---------------------------------------------------------------------------
// Against real PostgreSQL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('display against real PostgreSQL', () => {
  let db: typeof DbNamespace;
  let devices: typeof DevicesNamespace;
  let display: typeof DisplayNamespace;
  let venueId: UUID;
  let otherVenueId: UUID;
  let deviceId: UUID;

  const PREFIX = 'disp-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.com';
    db = await import('../src/lib/db');
    devices = await import('../src/services/devices');
    display = await import('../src/services/display');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
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
    venueId = await seedVenue('primary');
    otherVenueId = await seedVenue('other');
    const paired = await devices.pairDevice({
      venueId,
      displayName: 'Main Bar TV',
      fireTvDeviceId: `fire-${Math.random().toString(36).slice(2)}`,
    });
    deviceId = paired.deviceId;
  });

  const noCache = {
    cacheGet: async () => null,
    cacheSet: async () => undefined,
    logger: silent,
    publicBaseUrl: () => 'https://fanboard.com',
  };

  async function seedGame(venue: UUID, externalId: string, status: string, hoursFromNow: number) {
    await db.query(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at, status)
       VALUES ($1,$2,'NFL','American Football','Bears','Packers',
               date_trunc('day', NOW()) + make_interval(hours => $3::int), $4)`,
      [venue, externalId, hoursFromNow, status],
    );
  }

  it('returns only today\'s games for this venue', async () => {
    await seedGame(venueId, 'today-1', 'scheduled', 20);
    await seedGame(otherVenueId, 'other-venue', 'scheduled', 20);
    // Yesterday, so outside the window.
    await db.query(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at, status)
       VALUES ($1,'yesterday','NFL','American Football','A','B', NOW() - INTERVAL '2 days','final')`,
      [venueId],
    );

    const payload = await display.buildDisplayPayload(venueId, { db: db.sql, ...noCache });

    expect(payload.games).toHaveLength(1);
    expect(payload.games[0]?.homeTeam).toBe('Bears');
  });

  it('orders live games ahead of upcoming, and finished last', async () => {
    await seedGame(venueId, 'final-1', 'final', 1);
    await seedGame(venueId, 'sched-1', 'scheduled', 22);
    await seedGame(venueId, 'live-1', 'live', 12);

    const payload = await display.buildDisplayPayload(venueId, { db: db.sql, ...noCache });

    expect(payload.games.map((game) => game.status)).toEqual(['live', 'scheduled', 'final']);
  });

  it('includes the venue leaderboard snapshot and nothing from another venue', async () => {
    const session = await db.query<{ id: string }>(
      `INSERT INTO player_sessions (venue_id, nickname, session_token)
       VALUES ($1,'Alice',$2) RETURNING id`,
      [venueId, hashToken(`t-${Math.random()}`)],
    );
    await db.query(
      `INSERT INTO leaderboard_snapshot (venue_id, period, player_session_id, nickname, wins, losses, points, rank)
       VALUES ($1,'daily',$2,'Alice',3,1,30,1)`,
      [venueId, session.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO leaderboard_snapshot (venue_id, period, player_session_id, nickname, wins, losses, points, rank)
       VALUES ($1,'daily',NULL,'Mallory',9,0,99,1)`,
      [otherVenueId],
    );

    const payload = await display.buildDisplayPayload(venueId, { db: db.sql, ...noCache });

    expect(payload.leaderboard).toEqual([
      { rank: 1, nickname: 'Alice', wins: 3, losses: 1, points: 30 },
    ]);
    expect(JSON.stringify(payload)).not.toContain('Mallory');
    expect(JSON.stringify(payload)).not.toContain(session.rows[0]!.id);
  });

  it('builds the QR code from the device\'s own venue', async () => {
    const payload = await display.buildDisplayPayload(venueId, { db: db.sql, ...noCache });
    expect(payload.qrCode).toBe(`https://fanboard.com/v/${venueId}`);
    expect(payload.qrCode).not.toContain(otherVenueId);
  });

  it('returns an empty payload for a venue with nothing scheduled', async () => {
    const payload = await display.buildDisplayPayload(otherVenueId, { db: db.sql, ...noCache });
    expect(payload.games).toEqual([]);
    expect(payload.leaderboard).toEqual([]);
  });

  it('resolves a device to its venue and caches the mapping', async () => {
    const lookup = await import('../src/lib/device-lookup');
    const cache = new Map<string, string>();

    const first = await lookup.getVenueIdFromDevice(deviceId, {
      db: db.sql,
      logger: silent,
      cacheGet: async (key) => cache.get(key) ?? null,
      cacheSet: async (key, value) => {
        cache.set(key, value);
      },
    });

    expect(first).toBe(venueId);
    expect([...cache.values()]).toContain(venueId);
  });

  it('rejects a lookup for a device that does not exist', async () => {
    const lookup = await import('../src/lib/device-lookup');
    await expectApiError(
      lookup.getVenueIdFromDevice(trustedUuid('99999999-9999-9999-9999-999999999999'), {
        db: db.sql,
        logger: silent,
        cacheGet: async () => null,
        cacheSet: async () => undefined,
      }),
      404,
    );
  });
});
