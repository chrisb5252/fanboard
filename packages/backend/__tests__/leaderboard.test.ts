import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADERBOARD_TTL_SECONDS, leaderboardKey } from '../src/lib/cache-keys';
import { ApiError } from '../src/lib/errors';
import {
  LEADERBOARD_PERIODS,
  PERIOD_TO_SNAPSHOT,
  isLeaderboardPeriod,
  validatePeriod,
} from '../src/lib/leaderboard';
import { createLogger } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import { updateLeaderboardsOnce } from '../src/workers/update-leaderboard';
import type * as DbNamespace from '../src/lib/db';
import type * as LeaderboardNamespace from '../src/lib/leaderboard';
import type * as PlayersNamespace from '../src/services/players';

const silent = createLogger({ level: 'silent' });

/**
 * Stubs the realtime fan-out. Without it these tests open a real Redis client,
 * which resolves and memoises the environment — pinning DATABASE_URL from
 * `.env.local` before the integration block below gets to set its own.
 */
const noBroadcast = async (): Promise<void> => undefined;
const VENUE_A = trustedUuid('11111111-1111-1111-1111-111111111111');
const VENUE_B = trustedUuid('22222222-2222-2222-2222-222222222222');

// ---------------------------------------------------------------------------
// Period vocabulary
// ---------------------------------------------------------------------------

describe('period handling', () => {
  it('accepts the three API periods', () => {
    for (const period of LEADERBOARD_PERIODS) {
      expect(validatePeriod(period)).toBe(period);
    }
  });

  it('defaults to today when absent', () => {
    expect(validatePeriod(null)).toBe('today');
    expect(validatePeriod(undefined)).toBe('today');
    expect(validatePeriod('')).toBe('today');
  });

  it('rejects anything else with 400', () => {
    for (const bad of ['yesterday', 'daily', 'ALL_TIME', 42, {}]) {
      try {
        validatePeriod(bad);
        throw new Error(`expected ${JSON.stringify(bad)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
      }
    }
  });

  it('maps every API period onto a value the snapshot CHECK allows', () => {
    // Storing "today" directly would violate leaderboard_snapshot's constraint.
    const allowed = new Set(['daily', 'weekly', 'monthly', 'all_time']);
    for (const period of LEADERBOARD_PERIODS) {
      expect(allowed.has(PERIOD_TO_SNAPSHOT[period])).toBe(true);
    }
  });

  it('narrows correctly', () => {
    expect(isLeaderboardPeriod('today')).toBe(true);
    expect(isLeaderboardPeriod('daily')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Materialisation worker with fakes
// ---------------------------------------------------------------------------

describe('updateLeaderboardsOnce', () => {
  it('computes every period for every venue', async () => {
    const computeLeaderboard = vi.fn(async () => []);
    const outcome = await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => [VENUE_A, VENUE_B],
      computeLeaderboard,
      cacheSet: async () => undefined,
    });

    expect(outcome.venues).toBe(2);
    expect(outcome.leaderboards).toBe(6);
    expect(computeLeaderboard).toHaveBeenCalledTimes(6);
  });

  it('warms the cache with a 60 second TTL', async () => {
    const cacheSet = vi.fn(async () => undefined);
    await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => [VENUE_A],
      computeLeaderboard: async () => [
        { rank: 1, playerSessionId: null, nickname: 'A', wins: 1, losses: 0, points: 10 },
      ],
      cacheSet,
    });

    expect(cacheSet).toHaveBeenCalledWith(
      leaderboardKey(VENUE_A, 'today'),
      expect.any(String),
      LEADERBOARD_TTL_SECONDS,
    );
  });

  it('keeps going when one venue fails', async () => {
    let call = 0;
    const outcome = await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => [VENUE_A, VENUE_B],
      computeLeaderboard: async () => {
        call += 1;
        if (call === 1) {
          throw new Error('statement timeout');
        }
        return [];
      },
      cacheSet: async () => undefined,
    });

    expect(outcome.errors).toBe(1);
    expect(outcome.leaderboards).toBe(5);
  });

  it('still stores the snapshot when the cache write fails', async () => {
    const outcome = await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => [VENUE_A],
      computeLeaderboard: async () => [],
      cacheSet: async () => {
        throw new Error('redis down');
      },
    });

    expect(outcome.leaderboards).toBe(3);
    expect(outcome.errors).toBe(0);
  });

  it('never rejects when the venue list fails', async () => {
    const outcome = await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => {
        throw new Error('pool exhausted');
      },
      computeLeaderboard: async () => [],
      cacheSet: async () => undefined,
    });

    expect(outcome.errors).toBe(1);
    expect(outcome.venues).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Against real PostgreSQL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('leaderboard against real PostgreSQL', () => {
  let db: typeof DbNamespace;
  let lb: typeof LeaderboardNamespace;
  let players: typeof PlayersNamespace;
  let venueId: UUID;
  let otherVenueId: UUID;

  const VENUE_PREFIX = 'lb-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${VENUE_PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'integration-test-key';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';
    db = await import('../src/lib/db');
    lb = await import('../src/lib/leaderboard');
    players = await import('../src/services/players');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  });

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${VENUE_PREFIX}-${name}`, hashToken(`k-${name}-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  beforeEach(async () => {
    await cleanup();
    venueId = await seedVenue('primary');
    otherVenueId = await seedVenue('other');
  });

  async function seedGame(venue: UUID, externalId: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at, status, winner, graded_at)
       VALUES ($1,$2,'NFL','American Football','Bears','Packers', NOW() - INTERVAL '2 hours', 'final', 'home', NOW())
       RETURNING id`,
      [venue, externalId],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  /** Inserts an already-graded pick, optionally backdated. */
  async function seedGradedPick(
    venue: UUID,
    gameId: UUID,
    playerId: string,
    options: { correct: boolean | null; points: number | null; daysAgo?: number },
  ): Promise<void> {
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at, created_at, submitted_at)
       VALUES ($1,$2,$3,'home',$4,$5, NOW(), NOW() - make_interval(days => $6::int), NOW() - make_interval(days => $6::int))`,
      [venue, gameId, playerId, options.correct, options.points, options.daysAgo ?? 0],
    );
  }

  async function seedPlayer(venue: UUID, nickname: string): Promise<string> {
    const session = await players.createPlayerSession({ venueId: venue, nickname });
    return session.playerId;
  }

  it('ranks by total points descending', async () => {
    const g1 = await seedGame(venueId, 'lb-1');
    const g2 = await seedGame(venueId, 'lb-2');
    const low = await seedPlayer(venueId, 'Low');
    const high = await seedPlayer(venueId, 'High');

    await seedGradedPick(venueId, g1, low, { correct: true, points: 10 });
    await seedGradedPick(venueId, g1, high, { correct: true, points: 10 });
    await seedGradedPick(venueId, g2, high, { correct: true, points: 10 });

    const board = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });

    expect(board.map((entry) => [entry.rank, entry.nickname, entry.points])).toEqual([
      [1, 'High', 20],
      [2, 'Low', 10],
    ]);
  });

  it('counts wins and losses, ignoring voided picks', async () => {
    const g1 = await seedGame(venueId, 'lb-3');
    const g2 = await seedGame(venueId, 'lb-4');
    const g3 = await seedGame(venueId, 'lb-5');
    const player = await seedPlayer(venueId, 'Mixed');

    await seedGradedPick(venueId, g1, player, { correct: true, points: 10 });
    await seedGradedPick(venueId, g2, player, { correct: false, points: 0 });
    await seedGradedPick(venueId, g3, player, { correct: null, points: null });

    const board = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });

    expect(board[0]).toMatchObject({ nickname: 'Mixed', wins: 1, losses: 1, points: 10 });
  });

  it('breaks a points tie by wins descending', async () => {
    const games = [
      await seedGame(venueId, 'tie-1'),
      await seedGame(venueId, 'tie-2'),
      await seedGame(venueId, 'tie-3'),
    ];
    const fewer = await seedPlayer(venueId, 'FewerWins');
    const more = await seedPlayer(venueId, 'MoreWins');

    // Same points, different win counts: 10+10 vs 20 is not expressible with a
    // flat 10 per win, so give the tie-breaker loser a single high-value pick.
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at)
       VALUES ($1,$2,$3,'home',TRUE,20,NOW())`,
      [venueId, games[0], fewer],
    );
    await seedGradedPick(venueId, games[1]!, more, { correct: true, points: 10 });
    await seedGradedPick(venueId, games[2]!, more, { correct: true, points: 10 });

    const board = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });

    expect(board.map((entry) => [entry.rank, entry.nickname, entry.points, entry.wins])).toEqual([
      [1, 'MoreWins', 20, 2],
      [2, 'FewerWins', 20, 1],
    ]);
  });

  it('breaks a points-and-wins tie by earliest pick', async () => {
    const g1 = await seedGame(venueId, 'early-1');
    const g2 = await seedGame(venueId, 'early-2');
    const late = await seedPlayer(venueId, 'Late');
    const early = await seedPlayer(venueId, 'Early');

    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at, submitted_at)
       VALUES ($1,$2,$3,'home',TRUE,10,NOW(), NOW() - INTERVAL '1 hour')`,
      [venueId, g1, late],
    );
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at, submitted_at)
       VALUES ($1,$2,$3,'home',TRUE,10,NOW(), NOW() - INTERVAL '5 hours')`,
      [venueId, g2, early],
    );

    const board = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    expect(board.map((entry) => entry.nickname)).toEqual(['Early', 'Late']);
  });

  it('filters by period: today excludes an older pick that all_time includes', async () => {
    const g1 = await seedGame(venueId, 'p-1');
    const g2 = await seedGame(venueId, 'p-2');
    const recent = await seedPlayer(venueId, 'Recent');
    const old = await seedPlayer(venueId, 'Old');

    await seedGradedPick(venueId, g1, recent, { correct: true, points: 10, daysAgo: 0 });
    await seedGradedPick(venueId, g2, old, { correct: true, points: 10, daysAgo: 30 });

    const today = await lb.computeLeaderboard(venueId, 'today', { db: db.sql });
    const allTime = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });

    expect(today.map((entry) => entry.nickname)).toEqual(['Recent']);
    expect(allTime.map((entry) => entry.nickname).sort()).toEqual(['Old', 'Recent']);
  });

  it('this_week excludes a pick from last month', async () => {
    const g1 = await seedGame(venueId, 'w-1');
    const player = await seedPlayer(venueId, 'LastMonth');
    await seedGradedPick(venueId, g1, player, { correct: true, points: 10, daysAgo: 30 });

    const week = await lb.computeLeaderboard(venueId, 'this_week', { db: db.sql });
    expect(week).toEqual([]);
  });

  it('isolates venues: venue A never sees venue B players', async () => {
    const gameA = await seedGame(venueId, 'iso-a');
    const gameB = await seedGame(otherVenueId, 'iso-b');
    const playerA = await seedPlayer(venueId, 'PlayerA');
    const playerB = await seedPlayer(otherVenueId, 'PlayerB');

    await seedGradedPick(venueId, gameA, playerA, { correct: true, points: 10 });
    await seedGradedPick(otherVenueId, gameB, playerB, { correct: true, points: 99 });

    const boardA = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    const boardB = await lb.computeLeaderboard(otherVenueId, 'all_time', { db: db.sql });

    expect(boardA.map((entry) => entry.nickname)).toEqual(['PlayerA']);
    expect(boardB.map((entry) => entry.nickname)).toEqual(['PlayerB']);
  });

  it('writes the snapshot under the mapped period and replaces it on recompute', async () => {
    const g1 = await seedGame(venueId, 'snap-1');
    const player = await seedPlayer(venueId, 'Snap');
    await seedGradedPick(venueId, g1, player, { correct: true, points: 10 });

    await lb.computeLeaderboard(venueId, 'today', { db: db.sql });
    await lb.computeLeaderboard(venueId, 'today', { db: db.sql });

    const stored = await db.query<{ period: string; count: string }>(
      'SELECT period, count(*)::text AS count FROM leaderboard_snapshot WHERE venue_id = $1 GROUP BY period',
      [venueId],
    );

    // Replaced, not appended.
    expect(stored.rows).toEqual([{ period: 'daily', count: '1' }]);
  });

  it('reads back exactly what it stored', async () => {
    const g1 = await seedGame(venueId, 'read-1');
    const player = await seedPlayer(venueId, 'Reader');
    await seedGradedPick(venueId, g1, player, { correct: true, points: 10 });

    const computed = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    const read = await lb.readLeaderboardSnapshot(venueId, 'all_time', { db: db.sql });

    expect(read).toEqual(computed);
  });

  it('returns an empty board for a venue with no graded picks', async () => {
    expect(await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql })).toEqual([]);
    expect(await lb.readLeaderboardSnapshot(venueId, 'today', { db: db.sql })).toEqual([]);
  });

  it('reflects grading: a board changes after picks are settled', async () => {
    const gameId = await seedGame(venueId, 'after-1');
    const player = await seedPlayer(venueId, 'Grader');

    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
       VALUES ($1,$2,$3,'home')`,
      [venueId, gameId, player],
    );

    const before = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    expect(before).toEqual([]);

    await db.query(
      'UPDATE picks SET correct = TRUE, points = 10, graded_at = NOW() WHERE game_id = $1',
      [gameId],
    );

    const after = await lb.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    expect(after[0]).toMatchObject({ nickname: 'Grader', points: 10, wins: 1, rank: 1 });
  });

  it('materialises all three periods for every venue through the worker', async () => {
    const gameId = await seedGame(venueId, 'mat-1');
    const player = await seedPlayer(venueId, 'Mat');
    await seedGradedPick(venueId, gameId, player, { correct: true, points: 10 });

    const cache = new Map<string, string>();
    const outcome = await updateLeaderboardsOnce({
      broadcast: noBroadcast,
      logger: silent,
      listVenueIds: async () => [venueId, otherVenueId],
      computeLeaderboard: (venue, period) => lb.computeLeaderboard(venue, period, { db: db.sql }),
      cacheSet: async (key, value) => {
        cache.set(key, value);
      },
    });

    expect(outcome.leaderboards).toBe(6);
    expect(outcome.errors).toBe(0);
    expect(cache.has(leaderboardKey(venueId, 'today'))).toBe(true);

    const periods = await db.query<{ period: string }>(
      'SELECT DISTINCT period FROM leaderboard_snapshot WHERE venue_id = $1 ORDER BY period',
      [venueId],
    );
    expect(periods.rows.map((row) => row.period)).toEqual(['all_time', 'daily', 'weekly']);
  });
});
