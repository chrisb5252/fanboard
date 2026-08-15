import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import { SportsProvider, type FetchGamesOptions, type NormalizedGame } from '../src/lib/sports-provider';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as CacheKeysNamespace from '../src/lib/cache-keys';
import type * as DbNamespace from '../src/lib/db';
import type * as RedisNamespace from '../src/lib/redis';
import type * as WsNamespace from '../src/lib/websocket';
import type * as GamesRoute from '../src/app/api/venues/[venueId]/games/route';
import type * as LeaderboardRoute from '../src/app/api/venues/[venueId]/leaderboard/route';
import type * as PicksRoute from '../src/app/api/venues/[venueId]/picks/route';
import type * as PlayersRoute from '../src/app/api/venues/[venueId]/players/route';
import type * as GradeGames from '../src/workers/grade-games';
import type * as LockGames from '../src/workers/lock-games';
import type * as UpdateLeaderboard from '../src/workers/update-leaderboard';

/**
 * End-to-end: one patron's whole evening, against a real database, a real Redis
 * and a real WebSocket server.
 *
 * The route handlers are invoked directly with a plain `Request` rather than
 * through a booted Next server. That is the same surface the framework calls,
 * so the middleware chain is the only thing not exercised here — and that is
 * covered separately in security.test.ts, which can drive it without a server.
 *
 * Time is not mocked. Games are seeded relative to NOW() and then moved by
 * updating `scheduled_at`, which is how a game actually becomes locked: nothing
 * in the pick path reads a clock supplied by the caller, so shifting the row is
 * the only honest way to simulate the passage of kick-off.
 */

const silent = createLogger({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const WS_TEST_PORT = 3198;

/** Kept distinct from every other integration file's prefix; they run in parallel. */
const PREFIX = 'e2e-int';

/** A finished fixture the stub provider will report for a given external id. */
function finalGame(externalId: string, winner: 'home' | 'away'): NormalizedGame {
  return {
    externalId,
    league: 'NFL',
    sport: 'American Football',
    homeTeam: 'Bears',
    awayTeam: 'Packers',
    homeLogoUrl: null,
    awayLogoUrl: null,
    scheduledAt: new Date(),
    status: 'final',
    homeScore: winner === 'home' ? 24 : 17,
    awayScore: winner === 'home' ? 17 : 24,
    winner,
  };
}

/** Stands in for TheSportsDB. Returns whatever the test says the world looks like. */
class StubProvider extends SportsProvider {
  readonly name = 'e2e-stub';
  constructor(private games: NormalizedGame[]) {
    super();
  }
  setGames(games: NormalizedGame[]): void {
    this.games = games;
  }
  fetchGames(_date: string, _options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    return Promise.resolve(this.games);
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)('end-to-end: patron journey', () => {
  let db: typeof DbNamespace;
  let redis: typeof RedisNamespace;
  let cacheKeys: typeof CacheKeysNamespace;
  let ws: typeof WsNamespace;
  let playersRoute: typeof PlayersRoute;
  let picksRoute: typeof PicksRoute;
  let gamesRoute: typeof GamesRoute;
  let leaderboardRoute: typeof LeaderboardRoute;
  let lockGames: typeof LockGames;
  let gradeGames: typeof GradeGames;
  let updateLeaderboard: typeof UpdateLeaderboard;

  let venueId: UUID;
  let otherVenueId: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.test';
    process.env['TRUSTED_PROXY_HOPS'] = '1';

    db = await import('../src/lib/db');
    redis = await import('../src/lib/redis');
    cacheKeys = await import('../src/lib/cache-keys');
    ws = await import('../src/lib/websocket');
    playersRoute = await import('../src/app/api/venues/[venueId]/players/route');
    picksRoute = await import('../src/app/api/venues/[venueId]/picks/route');
    gamesRoute = await import('../src/app/api/venues/[venueId]/games/route');
    leaderboardRoute = await import('../src/app/api/venues/[venueId]/leaderboard/route');
    lockGames = await import('../src/workers/lock-games');
    gradeGames = await import('../src/workers/grade-games');
    updateLeaderboard = await import('../src/workers/update-leaderboard');

    await cleanup();
    venueId = await seedVenue('home');
    otherVenueId = await seedVenue('away');

    ws.startWebSocketServer({ db: db.sql, logger: silent, port: WS_TEST_PORT });
    await sleep(200);
  }, 60_000);

  afterAll(async () => {
    await ws.stopWebSocketServer();
    await cleanup();
    await db.closePool();
    await redis.closeRedis();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  /** `offsetSql` is an interval expression applied to NOW(), e.g. `'+ INTERVAL '1 hour''`. */
  async function seedGame(
    venue: UUID,
    externalId: string,
    scheduledAtSql: string,
  ): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at)
       VALUES ($1::uuid, $2, 'NFL', 'American Football', 'Bears', 'Packers', ${scheduledAtSql})
       RETURNING id`,
      [venue, externalId],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** A fresh address per join, so the 5-per-IP session limit never fires. */
  function uniqueIp(): string {
    return `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  }

  // -------------------------------------------------------------------------
  // HTTP helpers — these call the real handlers with a real Request
  // -------------------------------------------------------------------------

  function join(venue: UUID, nickname: string): Promise<Response> {
    return playersRoute.POST(
      new Request(`https://fanboard.test/api/venues/${venue}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': uniqueIp() },
        body: JSON.stringify({ nickname }),
      }),
      { params: Promise.resolve({ venueId: venue }) },
    );
  }

  /** Pulls the session cookie back out of a Set-Cookie header. */
  function sessionCookie(response: Response): string {
    const raw = response.headers.get('set-cookie');
    expect(raw).not.toBeNull();
    const value = /session_token=([^;]+)/.exec(raw as string)?.[1];
    expect(value).toBeDefined();
    return `session_token=${value}`;
  }

  function pick(
    venue: UUID,
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return picksRoute.POST(
      new Request(`https://fanboard.test/api/venues/${venue}/picks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ venueId: venue }) },
    );
  }

  function listGames(venue: UUID): Promise<Response> {
    return gamesRoute.GET(
      new Request(`https://fanboard.test/api/venues/${venue}/games`),
      { params: Promise.resolve({ venueId: venue }) },
    );
  }

  function readLeaderboard(venue: UUID, period = 'today'): Promise<Response> {
    return leaderboardRoute.GET(
      new Request(`https://fanboard.test/api/venues/${venue}/leaderboard?period=${period}`),
      { params: Promise.resolve({ venueId: venue }) },
    );
  }

  /** Opens an authenticated realtime socket for a session cookie. */
  async function openSocket(cookie: string): Promise<{ socket: WebSocket; received: unknown[] }> {
    const received: unknown[] = [];
    const socket = new WebSocket(`ws://localhost:${WS_TEST_PORT}/ws`, { headers: { cookie } });

    // Attached before the open await: the server greets on upgrade, so a
    // listener added afterwards has already missed the first frame.
    socket.on('message', (raw: Buffer) => {
      received.push(JSON.parse(raw.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    return { socket, received };
  }

  function typesOf(received: unknown[]): string[] {
    return received.map((message) => (message as { type: string }).type);
  }

  // -------------------------------------------------------------------------
  // The journey
  // -------------------------------------------------------------------------

  it('runs the whole flow: join, pick, lock, grade, leaderboard, realtime', async () => {
    // -- 1. The patron scans the QR code and joins -------------------------
    const joined = await join(venueId, 'Ada');
    expect(joined.status).toBe(201);

    const cookie = sessionCookie(joined);
    const joinBody = (await joined.json()) as { playerId: string; nickname: string };
    expect(joinBody.nickname).toBe('Ada');

    // The credential is httpOnly and same-site; a script on another origin can
    // neither read it nor cause the browser to send it on a cross-site POST.
    const setCookie = joined.headers.get('set-cookie') as string;
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');

    // -- 11a. The realtime socket comes up alongside the app ---------------
    const stream = await openSocket(cookie);
    expect(typesOf(stream.received)).toContain('connected');

    // -- 2. Today's fixtures ------------------------------------------------
    // Seeded at noon so it lands inside the endpoint's "today" window whatever
    // time the suite runs; a game seeded relative to NOW() would fall into
    // tomorrow for a run just before midnight.
    const middayGame = await seedGame(
      venueId,
      `${PREFIX}-midday`,
      `date_trunc('day', NOW()) + INTERVAL '12 hours'`,
    );

    const gamesResponse = await listGames(venueId);
    expect(gamesResponse.status).toBe(200);
    const games = (await gamesResponse.json()) as { id: string }[];
    expect(games.map((game) => game.id)).toContain(middayGame);

    // -- 3. A pick, while the game is still open ---------------------------
    const target = await seedGame(venueId, `${PREFIX}-target`, `NOW() + INTERVAL '30 minutes'`);

    const firstPick = await pick(venueId, cookie, { gameId: target, predictedWinner: 'home' });
    expect(firstPick.status).toBe(201);
    const pickBody = (await firstPick.json()) as { predictedWinner: string; locked: boolean };
    expect(pickBody.predictedWinner).toBe('home');
    expect(pickBody.locked).toBe(false);

    // Changing your mind before kick-off is allowed, and updates rather than
    // duplicating: 200, not 201.
    const changed = await pick(venueId, cookie, { gameId: target, predictedWinner: 'away' });
    expect(changed.status).toBe(200);

    // Settle on 'home' so the grading assertion below has a known answer.
    expect((await pick(venueId, cookie, { gameId: target, predictedWinner: 'home' })).status).toBe(
      200,
    );

    // -- 5. Kick-off arrives -----------------------------------------------
    // Moving the row is the simulation. Nothing in the pick path reads a
    // client-supplied clock, so there is no other way to make this happen.
    await db.query(
      `UPDATE games SET scheduled_at = NOW() - INTERVAL '45 minutes' WHERE id = $1::uuid`,
      [target],
    );

    const lockResult = await lockGames.lockGamesOnce();
    expect(lockResult.locked).toBeGreaterThan(0);

    // Asserted on the row rather than the count: the worker is global, and
    // another suite's fixtures may be locked in the same pass.
    const lockedRow = await db.query<{ locked_at: Date | null }>(
      'SELECT locked_at FROM games WHERE id = $1::uuid',
      [target],
    );
    expect(lockedRow.rows[0]?.locked_at).not.toBeNull();

    // -- 6. The lock is visible in Redis -----------------------------------
    // This is the fast path the pick service checks before touching Postgres.
    const cachedLock = await redis.get(cacheKeys.gameLockKey(target));
    expect(cachedLock).not.toBeNull();

    // -- 11b. ...and the lock reached the socket ---------------------------
    await sleep(400);
    expect(typesOf(stream.received)).toContain('game_locked');

    // -- 4 & 7. Picks are refused now ---------------------------------------
    const afterLock = await pick(venueId, cookie, { gameId: target, predictedWinner: 'away' });
    expect(afterLock.status).toBe(423);

    // The existing pick is untouched: a rejected change must not silently
    // rewrite what the player already committed to.
    const stored = await db.query<{ predicted_winner: string }>(
      'SELECT predicted_winner FROM picks WHERE game_id = $1::uuid',
      [target],
    );
    expect(stored.rows[0]?.predicted_winner).toBe('home');

    // -- 8 & 9. The game finishes and grading runs -------------------------
    const provider = new StubProvider([finalGame(`${PREFIX}-target`, 'home')]);
    const graded = await gradeGames.gradeGamesOnce({
      logger: silent,
      provider,
      broadcastGraded: async () => undefined,
    });
    expect(graded.errors).toBe(0);

    const gradedPick = await db.query<{ correct: boolean; points: number; graded_at: Date }>(
      'SELECT correct, points, graded_at FROM picks WHERE game_id = $1::uuid',
      [target],
    );
    // Picked 'home', 'home' won.
    expect(gradedPick.rows[0]?.correct).toBe(true);
    expect(gradedPick.rows[0]?.points).toBe(10);
    expect(gradedPick.rows[0]?.graded_at).not.toBeNull();

    // -- 10. The leaderboard reflects it -----------------------------------
    await updateLeaderboard.updateLeaderboardsOnce({
      logger: silent,
      listVenueIds: async () => [venueId],
      broadcast: async () => undefined,
    });

    // The route reads Redis first; clear it so this asserts the materialised
    // snapshot rather than whatever the worker happened to warm.
    await redis.del(cacheKeys.leaderboardKey(venueId, 'today'));

    const board = await readLeaderboard(venueId);
    expect(board.status).toBe(200);
    const standings = (await board.json()) as {
      rank: number;
      nickname: string;
      points: number;
      wins: number;
    }[];

    const ada = standings.find((entry) => entry.nickname === 'Ada');
    expect(ada).toBeDefined();
    expect(ada?.points).toBe(10);
    expect(ada?.wins).toBe(1);
    expect(ada?.rank).toBe(1);

    // player_session_id is tenant-internal and this endpoint is public.
    expect(Object.keys(standings[0] ?? {})).not.toContain('playerSessionId');

    stream.socket.close();
  }, 120_000);

  // -------------------------------------------------------------------------
  // A wrong pick scores zero — the other half of grading
  // -------------------------------------------------------------------------

  it('scores an incorrect pick at zero rather than skipping it', async () => {
    const joined = await join(venueId, 'Grace');
    const cookie = sessionCookie(joined);

    const game = await seedGame(venueId, `${PREFIX}-wrong`, `NOW() + INTERVAL '30 minutes'`);
    expect((await pick(venueId, cookie, { gameId: game, predictedWinner: 'home' })).status).toBe(
      201,
    );

    await db.query(
      `UPDATE games SET scheduled_at = NOW() - INTERVAL '45 minutes' WHERE id = $1::uuid`,
      [game],
    );

    // Away won; the pick was home.
    await gradeGames.gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([finalGame(`${PREFIX}-wrong`, 'away')]),
      broadcastGraded: async () => undefined,
    });

    const row = await db.query<{ correct: boolean; points: number }>(
      'SELECT correct, points FROM picks WHERE game_id = $1::uuid',
      [game],
    );
    expect(row.rows[0]?.correct).toBe(false);
    expect(row.rows[0]?.points).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Realtime, on the path production actually uses
  // -------------------------------------------------------------------------

  it('pushes a leaderboard update to a connected phone', async () => {
    const joined = await join(venueId, 'Linus');
    const stream = await openSocket(sessionCookie(joined));

    // Scoped to this suite's venue. The worker materialises every venue in the
    // database by default, and the integration suites run in parallel — an
    // unscoped run here publishes events for another file's venues and breaks
    // its isolation assertions. The broadcast itself is left real, so this
    // still exercises publish -> Redis -> subscriber -> socket.
    await updateLeaderboard.updateLeaderboardsOnce({
      logger: silent,
      listVenueIds: async () => [venueId],
    });
    await sleep(600);

    expect(typesOf(stream.received)).toContain('leaderboard_updated');
    stream.socket.close();
  }, 60_000);

  it('never delivers another venue’s events', async () => {
    const here = await openSocket(sessionCookie(await join(venueId, 'Insider')));
    const elsewhere = await openSocket(sessionCookie(await join(otherVenueId, 'Outsider')));

    const { broadcastLeaderboard } = await import('../src/lib/leaderboard-broadcaster');
    await broadcastLeaderboard(venueId, 'today', []);
    await sleep(500);

    expect(typesOf(here.received)).toContain('leaderboard_updated');
    expect(typesOf(elsewhere.received)).not.toContain('leaderboard_updated');

    here.socket.close();
    elsewhere.socket.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe('error cases', () => {
    it('refuses a session used against another venue with 403', async () => {
      // The brief called for 404 here. The shipped guard is assertVenueScope,
      // which answers 403: the caller is authenticated, just not for this
      // venue. The 404 case is the one below — a *game* in another venue —
      // where 404 is the right answer because 403 would confirm the id exists.
      const cookie = sessionCookie(await join(venueId, 'Wanderer'));
      const game = await seedGame(otherVenueId, `${PREFIX}-x1`, `NOW() + INTERVAL '1 hour'`);

      const response = await pick(otherVenueId, cookie, {
        gameId: game,
        predictedWinner: 'home',
      });
      expect(response.status).toBe(403);
    }, 30_000);

    it('answers 404 for a game that belongs to another venue', async () => {
      // Not 403, deliberately: a 403 would confirm the game id is real, which
      // is enough to enumerate another venue's fixtures one guess at a time.
      const cookie = sessionCookie(await join(venueId, 'Prober'));
      const foreignGame = await seedGame(otherVenueId, `${PREFIX}-x2`, `NOW() + INTERVAL '1 hour'`);

      const response = await pick(venueId, cookie, {
        gameId: foreignGame,
        predictedWinner: 'home',
      });
      expect(response.status).toBe(404);
    }, 30_000);

    it('writes no pick row for a cross-venue attempt', async () => {
      const cookie = sessionCookie(await join(venueId, 'Ghost'));
      const foreignGame = await seedGame(otherVenueId, `${PREFIX}-x3`, `NOW() + INTERVAL '1 hour'`);

      await pick(venueId, cookie, { gameId: foreignGame, predictedWinner: 'home' });

      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM picks WHERE game_id = $1::uuid',
        [foreignGame],
      );
      expect(rows.rows[0]?.count).toBe('0');
    }, 30_000);

    it('holds a nickname against a second session at the same venue', async () => {
      // The brief expected duplicates to be allowed. The shipped behaviour is a
      // 60-minute hold added deliberately in the session-hardening pass: two
      // players called "Mike" on one leaderboard is indistinguishable to
      // everyone reading the TV. Asserting the built behaviour, not the brief.
      const first = await join(venueId, 'Duplicate');
      expect(first.status).toBe(201);

      const second = await join(venueId, 'Duplicate');
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe('nickname_taken');
    }, 30_000);

    it('allows the same nickname at a different venue', async () => {
      // The hold is per venue. Two bars are not one room.
      expect((await join(venueId, 'Shared')).status).toBe(201);
      expect((await join(otherVenueId, 'Shared')).status).toBe(201);
    }, 30_000);

    it('rejects a malformed game id with 400', async () => {
      const cookie = sessionCookie(await join(venueId, 'Malformed'));
      const response = await pick(venueId, cookie, {
        gameId: 'not-a-uuid',
        predictedWinner: 'home',
      });
      expect(response.status).toBe(400);
    }, 30_000);

    it('rejects a missing gameId with 400', async () => {
      const cookie = sessionCookie(await join(venueId, 'NoGame'));
      const response = await pick(venueId, cookie, { predictedWinner: 'home' });
      expect(response.status).toBe(400);
    }, 30_000);

    it('rejects a missing predictedWinner with 400', async () => {
      const cookie = sessionCookie(await join(venueId, 'NoWinner'));
      const game = await seedGame(venueId, `${PREFIX}-nw`, `NOW() + INTERVAL '1 hour'`);
      const response = await pick(venueId, cookie, { gameId: game });
      expect(response.status).toBe(400);
    }, 30_000);

    it('rejects a predictedWinner outside the whitelist with 400', async () => {
      // 'draw' is a real game outcome but not a pickable one, so it must fail
      // validation rather than reach the database and violate a CHECK.
      const cookie = sessionCookie(await join(venueId, 'DrawPicker'));
      const game = await seedGame(venueId, `${PREFIX}-draw`, `NOW() + INTERVAL '1 hour'`);
      const response = await pick(venueId, cookie, { gameId: game, predictedWinner: 'draw' });
      expect(response.status).toBe(400);
    }, 30_000);

    it('rejects an unauthenticated pick with 401', async () => {
      const game = await seedGame(venueId, `${PREFIX}-anon`, `NOW() + INTERVAL '1 hour'`);
      const response = await picksRoute.POST(
        new Request(`https://fanboard.test/api/venues/${venueId}/picks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gameId: game, predictedWinner: 'home' }),
        }),
        { params: Promise.resolve({ venueId }) },
      );
      expect(response.status).toBe(401);
    }, 30_000);

    it('rejects a nickname that is too short with 400', async () => {
      expect((await join(venueId, 'A')).status).toBe(400);
    }, 30_000);

    it('answers 404 for a player joining a venue that does not exist', async () => {
      const missing = trustedUuid('00000000-0000-0000-0000-0000000000ff');
      expect((await join(missing, 'Nobody')).status).toBe(404);
    }, 30_000);
  });
});
