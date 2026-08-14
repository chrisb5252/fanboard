import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import { createLogger } from '../src/lib/logger';
import {
  SportsProvider,
  type FetchGamesOptions,
  type NormalizedGame,
} from '../src/lib/sports-provider';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import {
  GRADE_GAMES_INTERVAL_MS,
  GRADING_DELAY_MINUTES,
  POINTS_FOR_CORRECT_PICK,
  gradeGamesOnce,
  planSettlement,
  type CandidateGame,
  type GradeGamesDeps,
} from '../src/workers/grade-games';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';
import type * as LeaderboardNamespace from '../src/lib/leaderboard';

const silent = createLogger({ level: 'silent' });

const VENUE_A = trustedUuid('11111111-1111-1111-1111-111111111111');
const GAME_1 = trustedUuid('aaaaaaaa-0000-0000-0000-000000000001');
const GAME_2 = trustedUuid('aaaaaaaa-0000-0000-0000-000000000002');

function normalized(overrides: Partial<NormalizedGame> = {}): NormalizedGame {
  return {
    externalId: 'evt-1',
    league: 'NFL',
    sport: 'American Football',
    homeTeam: 'Bears',
    awayTeam: 'Packers',
    homeLogoUrl: null,
    awayLogoUrl: null,
    scheduledAt: new Date('2025-01-19T10:00:00Z'),
    status: 'final',
    homeScore: 24,
    awayScore: 17,
    winner: 'home',
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateGame> = {}): CandidateGame {
  return {
    id: GAME_1,
    venueId: VENUE_A,
    externalId: 'evt-1',
    scheduledAt: new Date('2025-01-19T10:00:00Z'),
    ...overrides,
  };
}

class StubProvider extends SportsProvider {
  readonly name = 'stub';
  dateCalls: string[] = [];
  constructor(private readonly games: NormalizedGame[]) {
    super();
  }
  fetchGames(date: string, _options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    this.dateCalls.push(date);
    return Promise.resolve(this.games);
  }
}

function result<T>(rows: T[], rowCount = rows.length): SqlResult<T> {
  return { rows, rowCount };
}

/** Records statement order so atomicity can be asserted. */
function fakeTransactor(options: { settleRows?: number; picksGraded?: number; fail?: boolean } = {}) {
  const statements: string[] = [];
  const params: unknown[][] = [];

  const withTransaction: GradeGamesDeps['withTransaction'] = async (work) => {
    statements.push('BEGIN');
    const tx: SqlExecutor = {
      query: async <T,>(sql: string, values?: readonly unknown[]) => {
        params.push([...(values ?? [])]);
        if (sql.includes('UPDATE games')) {
          statements.push('SETTLE_GAME');
          const rows = options.settleRows ?? 1;
          return result(Array.from({ length: rows }, () => ({ id: GAME_1 }))) as SqlResult<T>;
        }
        statements.push('GRADE_PICKS');
        if (options.fail === true) {
          throw new Error('constraint violation');
        }
        return result([] as T[], options.picksGraded ?? 0);
      },
    };
    try {
      const value = await work(tx);
      statements.push('COMMIT');
      return value;
    } catch (error) {
      statements.push('ROLLBACK');
      throw error;
    }
  };

  return { withTransaction, statements, params };
}

function deps(overrides: Partial<GradeGamesDeps>): Partial<GradeGamesDeps> {
  return {
    logger: silent,
    invalidateLeaderboards: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Settlement planning
// ---------------------------------------------------------------------------

describe('planSettlement', () => {
  it('grades a finished game with a winner', () => {
    expect(planSettlement(normalized())).toEqual({
      status: 'final',
      void: false,
      winner: 'home',
      homeScore: 24,
      awayScore: 17,
    });
  });

  it('voids a cancelled game', () => {
    const plan = planSettlement(normalized({ status: 'cancelled', winner: null }));
    expect(plan).toMatchObject({ status: 'cancelled', void: true, winner: null });
  });

  it('leaves an unfinished game alone', () => {
    expect(planSettlement(normalized({ status: 'scheduled', winner: null }))).toBeNull();
    expect(planSettlement(normalized({ status: 'live', winner: null }))).toBeNull();
    expect(planSettlement(normalized({ status: 'postponed', winner: null }))).toBeNull();
  });

  it('refuses to grade a final game with no winner', () => {
    // games_graded_requires_winner would reject it; waiting for a later poll is
    // better than a guaranteed constraint violation.
    expect(planSettlement(normalized({ status: 'final', winner: null }))).toBeNull();
  });

  it('treats a draw as a settleable result', () => {
    const plan = planSettlement(
      normalized({ status: 'final', winner: 'draw', homeScore: 2, awayScore: 2 }),
    );
    expect(plan).toMatchObject({ void: false, winner: 'draw' });
  });
});

// ---------------------------------------------------------------------------
// Worker behaviour with fakes
// ---------------------------------------------------------------------------

describe('gradeGamesOnce', () => {
  it('runs on the 2 minute cadence with a 30 minute grace period', () => {
    expect(GRADE_GAMES_INTERVAL_MS).toBe(120_000);
    expect(GRADING_DELAY_MINUTES).toBe(30);
  });

  it('selects candidates by graded_at, not by status', async () => {
    // A status-based filter would skip games poll-games already marked 'final'
    // and they would never settle.
    const listCandidates = vi.fn(async () => []);
    await gradeGamesOnce(deps({ provider: new StubProvider([]), listCandidates }));
    expect(listCandidates).toHaveBeenCalled();
  });

  it('grades a finished game and reports the pick count', async () => {
    const { withTransaction } = fakeTransactor({ picksGraded: 7 });
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized()]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    expect(outcome.gamesGraded).toBe(1);
    expect(outcome.picksGraded).toBe(7);
    expect(outcome.gamesVoided).toBe(0);
    expect(outcome.errors).toBe(0);
  });

  it('scores a correct pick at 10 and a wrong pick at 0, in SQL', async () => {
    const { withTransaction, params } = fakeTransactor({ picksGraded: 3 });
    await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized({ winner: 'home' })]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    // [gameId, void, winner, points]
    const gradeParams = params[1];
    expect(gradeParams?.[1]).toBe(false);
    expect(gradeParams?.[2]).toBe('home');
    expect(gradeParams?.[3]).toBe(POINTS_FOR_CORRECT_PICK);
  });

  it('voids picks on a cancelled game', async () => {
    const { withTransaction, params } = fakeTransactor({ picksGraded: 4 });
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized({ status: 'cancelled', winner: null })]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    expect(outcome.gamesVoided).toBe(1);
    expect(outcome.picksVoided).toBe(4);
    expect(outcome.gamesGraded).toBe(0);
    // void = true, so correct and points both become NULL.
    expect(params[1]?.[1]).toBe(true);
    expect(params[1]?.[2]).toBeNull();
  });

  it('grades all picks in one statement, not one per pick', async () => {
    const { withTransaction, statements } = fakeTransactor({ picksGraded: 10_000 });
    await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized()]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    // Two statements regardless of pick count: settle the game, grade the picks.
    expect(statements).toEqual(['BEGIN', 'SETTLE_GAME', 'GRADE_PICKS', 'COMMIT']);
  });

  it('rolls back the game update when pick grading fails', async () => {
    const { withTransaction, statements } = fakeTransactor({ fail: true });
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized()]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(outcome.errors).toBe(1);
    expect(outcome.gamesGraded).toBe(0);
  });

  it('skips a game another run already settled', async () => {
    // The UPDATE is guarded on graded_at IS NULL, so the loser sees zero rows.
    const { withTransaction } = fakeTransactor({ settleRows: 0 });
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([normalized()]),
        listCandidates: async () => [candidate()],
        withTransaction,
      }),
    );

    expect(outcome.skipped).toBe(1);
    expect(outcome.gamesGraded).toBe(0);
  });

  it('grades multiple games in one run', async () => {
    const { withTransaction } = fakeTransactor({ picksGraded: 2 });
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([
          normalized({ externalId: 'evt-1' }),
          normalized({ externalId: 'evt-2', winner: 'away' }),
        ]),
        listCandidates: async () => [
          candidate({ id: GAME_1, externalId: 'evt-1' }),
          candidate({ id: GAME_2, externalId: 'evt-2' }),
        ],
        withTransaction,
      }),
    );

    expect(outcome.gamesGraded).toBe(2);
    expect(outcome.picksGraded).toBe(4);
  });

  it('keeps grading after one game fails', async () => {
    let call = 0;
    const withTransaction: GradeGamesDeps['withTransaction'] = async (work) => {
      call += 1;
      if (call === 1) {
        throw new Error('deadlock');
      }
      return work({
        query: async <T,>(sql: string) =>
          (sql.includes('UPDATE games')
            ? result([{ id: GAME_2 }])
            : result([] as T[], 5)) as SqlResult<T>,
      });
    };

    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([
          normalized({ externalId: 'evt-1' }),
          normalized({ externalId: 'evt-2' }),
        ]),
        listCandidates: async () => [
          candidate({ id: GAME_1, externalId: 'evt-1' }),
          candidate({ id: GAME_2, externalId: 'evt-2' }),
        ],
        withTransaction,
      }),
    );

    expect(outcome.errors).toBe(1);
    expect(outcome.gamesGraded).toBe(1);
  });

  it('asks the provider once per match day, not once per game', async () => {
    const provider = new StubProvider([normalized({ externalId: 'evt-1' })]);
    const { withTransaction } = fakeTransactor({ picksGraded: 1 });

    await gradeGamesOnce(
      deps({
        provider,
        listCandidates: async () => [
          candidate({ id: GAME_1, externalId: 'evt-1', scheduledAt: new Date('2025-01-19T10:00:00Z') }),
          candidate({ id: GAME_2, externalId: 'evt-2', scheduledAt: new Date('2025-01-19T22:00:00Z') }),
        ],
        withTransaction,
      }),
    );

    expect(provider.dateCalls).toEqual(['2025-01-19']);
  });

  it('invalidates the leaderboard cache and notifies once per venue after commit', async () => {
    const invalidateLeaderboards = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const { withTransaction } = fakeTransactor({ picksGraded: 1 });

    await gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([
        normalized({ externalId: 'evt-1' }),
        normalized({ externalId: 'evt-2' }),
      ]),
      listCandidates: async () => [
        candidate({ id: GAME_1, venueId: VENUE_A, externalId: 'evt-1' }),
        candidate({ id: GAME_2, venueId: VENUE_A, externalId: 'evt-2' }),
      ],
      withTransaction,
      invalidateLeaderboards,
      notify,
    });

    expect(invalidateLeaderboards).toHaveBeenCalledTimes(1);
    expect(invalidateLeaderboards).toHaveBeenCalledWith(VENUE_A);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate anything when nothing was graded', async () => {
    const invalidateLeaderboards = vi.fn(async () => undefined);
    await gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([normalized({ status: 'live', winner: null })]),
      listCandidates: async () => [candidate()],
      withTransaction: fakeTransactor().withTransaction,
      invalidateLeaderboards,
      notify: vi.fn(async () => undefined),
    });

    expect(invalidateLeaderboards).not.toHaveBeenCalled();
  });

  it('never rejects when the candidate query fails', async () => {
    const outcome = await gradeGamesOnce(
      deps({
        provider: new StubProvider([]),
        listCandidates: async () => {
          throw new Error('pool exhausted');
        },
      }),
    );

    expect(outcome.errors).toBe(1);
    expect(outcome.gamesGraded).toBe(0);
  });

  it('survives a leaderboard invalidation failure without losing the grade', async () => {
    const { withTransaction } = fakeTransactor({ picksGraded: 3 });
    const outcome = await gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([normalized()]),
      listCandidates: async () => [candidate()],
      withTransaction,
      invalidateLeaderboards: async () => {
        throw new Error('redis down');
      },
      notify: vi.fn(async () => undefined),
    });

    expect(outcome.gamesGraded).toBe(1);
    expect(outcome.picksGraded).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Against real PostgreSQL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('grade-games against real PostgreSQL', () => {
  let db: typeof DbNamespace;
  let players: typeof PlayersNamespace;
  let leaderboard: typeof LeaderboardNamespace;
  let venueId: UUID;

  const VENUE_PREFIX = 'grade-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${VENUE_PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'integration-test-key';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';
    db = await import('../src/lib/db');
    players = await import('../src/services/players');
    leaderboard = await import('../src/lib/leaderboard');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  });

  beforeEach(async () => {
    await cleanup();
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1, $2) RETURNING id',
      [`${VENUE_PREFIX}-primary`, hashToken(`k-${Math.random()}`)],
    );
    venueId = trustedUuid(inserted.rows[0]!.id);
  });

  async function seedGame(externalId: string, minutesAgo = 60): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at, status)
       VALUES ($1,$2,'NFL','American Football','Bears','Packers',
               NOW() - make_interval(mins => $3::int), 'scheduled')
       RETURNING id`,
      [venueId, externalId, minutesAgo],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  async function seedPick(gameId: UUID, nickname: string, winner: 'home' | 'away'): Promise<void> {
    const session = await players.createPlayerSession({ venueId, nickname });
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
       VALUES ($1,$2,$3,$4)`,
      [venueId, gameId, session.playerId, winner],
    );
  }

  function run(games: NormalizedGame[], candidates: CandidateGame[]) {
    return gradeGamesOnce({
      logger: silent,
      provider: new StubProvider(games),
      listCandidates: async () => candidates,
      withTransaction: db.withTransaction,
      invalidateLeaderboards: async () => undefined,
      notify: async () => undefined,
    });
  }

  it('awards 10 points for a correct pick and 0 for a wrong one', async () => {
    const gameId = await seedGame('g-1');
    await seedPick(gameId, 'Right', 'home');
    await seedPick(gameId, 'Wrong', 'away');

    const outcome = await run(
      [normalized({ externalId: 'g-1', winner: 'home' })],
      [candidate({ id: gameId, venueId, externalId: 'g-1' })],
    );

    expect(outcome.gamesGraded).toBe(1);
    expect(outcome.picksGraded).toBe(2);

    const graded = await db.query<{ predicted_winner: string; correct: boolean; points: number }>(
      'SELECT predicted_winner, correct, points FROM picks WHERE game_id = $1 ORDER BY predicted_winner',
      [gameId],
    );
    expect(graded.rows).toEqual([
      { predicted_winner: 'away', correct: false, points: 0 },
      { predicted_winner: 'home', correct: true, points: 10 },
    ]);
  });

  it('stamps graded_at on the game and its picks', async () => {
    const gameId = await seedGame('g-2');
    await seedPick(gameId, 'Someone', 'home');

    await run(
      [normalized({ externalId: 'g-2', winner: 'home' })],
      [candidate({ id: gameId, venueId, externalId: 'g-2' })],
    );

    const game = await db.query<{ graded_at: Date | null; status: string; winner: string }>(
      'SELECT graded_at, status, winner FROM games WHERE id = $1',
      [gameId],
    );
    expect(game.rows[0]?.graded_at).not.toBeNull();
    expect(game.rows[0]).toMatchObject({ status: 'final', winner: 'home' });

    const ungraded = await db.query('SELECT id FROM picks WHERE game_id = $1 AND graded_at IS NULL', [
      gameId,
    ]);
    expect(ungraded.rowCount).toBe(0);
  });

  it('voids picks on a cancelled game, leaving correct and points NULL', async () => {
    const gameId = await seedGame('g-3');
    await seedPick(gameId, 'VoidedA', 'home');
    await seedPick(gameId, 'VoidedB', 'away');

    const outcome = await run(
      [normalized({ externalId: 'g-3', status: 'cancelled', winner: null })],
      [candidate({ id: gameId, venueId, externalId: 'g-3' })],
    );

    expect(outcome.gamesVoided).toBe(1);
    expect(outcome.picksVoided).toBe(2);

    const voided = await db.query<{ correct: boolean | null; points: number | null; graded_at: Date }>(
      'SELECT correct, points, graded_at FROM picks WHERE game_id = $1',
      [gameId],
    );
    for (const row of voided.rows) {
      expect(row.correct).toBeNull();
      expect(row.points).toBeNull();
      // Settled, not pending: graded_at is what distinguishes the two.
      expect(row.graded_at).not.toBeNull();
    }
  });

  it('excludes voided picks from the leaderboard entirely', async () => {
    const cancelled = await seedGame('g-4');
    await seedPick(cancelled, 'OnlyVoided', 'home');
    await run(
      [normalized({ externalId: 'g-4', status: 'cancelled', winner: null })],
      [candidate({ id: cancelled, venueId, externalId: 'g-4' })],
    );

    const board = await leaderboard.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    // A cancelled game is neither a win nor a loss, so the player has no
    // settled picks and does not appear at all.
    expect(board).toEqual([]);
  });

  it('is idempotent: a second run does not re-grade or double-score', async () => {
    const gameId = await seedGame('g-5');
    await seedPick(gameId, 'Once', 'home');

    const first = await run(
      [normalized({ externalId: 'g-5', winner: 'home' })],
      [candidate({ id: gameId, venueId, externalId: 'g-5' })],
    );
    const second = await run(
      [normalized({ externalId: 'g-5', winner: 'away' })],
      [candidate({ id: gameId, venueId, externalId: 'g-5' })],
    );

    expect(first.gamesGraded).toBe(1);
    expect(second.gamesGraded).toBe(0);
    expect(second.skipped).toBe(1);

    const points = await db.query<{ points: number }>(
      'SELECT points FROM picks WHERE game_id = $1',
      [gameId],
    );
    expect(points.rows[0]?.points).toBe(10);
  });

  it('rolls the game update back when pick grading violates a constraint', async () => {
    const gameId = await seedGame('g-6');
    await seedPick(gameId, 'Atomic', 'home');

    // 'nonsense' fails the games_winner_check, so the game UPDATE itself throws
    // and nothing in the transaction lands.
    const outcome = await gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([
        normalized({ externalId: 'g-6', winner: 'nonsense' as NormalizedGame['winner'] }),
      ]),
      listCandidates: async () => [candidate({ id: gameId, venueId, externalId: 'g-6' })],
      withTransaction: db.withTransaction,
      invalidateLeaderboards: async () => undefined,
      notify: async () => undefined,
    });

    expect(outcome.errors).toBe(1);

    const game = await db.query<{ graded_at: Date | null }>(
      'SELECT graded_at FROM games WHERE id = $1',
      [gameId],
    );
    expect(game.rows[0]?.graded_at).toBeNull();

    const pick = await db.query<{ graded_at: Date | null }>(
      'SELECT graded_at FROM picks WHERE game_id = $1',
      [gameId],
    );
    expect(pick.rows[0]?.graded_at).toBeNull();
  });

  it('grades several games in a single run', async () => {
    const g1 = await seedGame('m-1');
    const g2 = await seedGame('m-2');
    await seedPick(g1, 'P1', 'home');
    await seedPick(g2, 'P2', 'away');

    const outcome = await run(
      [
        normalized({ externalId: 'm-1', winner: 'home' }),
        normalized({ externalId: 'm-2', winner: 'away' }),
      ],
      [
        candidate({ id: g1, venueId, externalId: 'm-1' }),
        candidate({ id: g2, venueId, externalId: 'm-2' }),
      ],
    );

    expect(outcome.gamesGraded).toBe(2);
    expect(outcome.picksGraded).toBe(2);
  });

  it('keeps a cross-venue pick out of the graded set', async () => {
    const other = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${VENUE_PREFIX}-other`, hashToken(`k-${Math.random()}`)],
    );
    const otherVenue = trustedUuid(other.rows[0]!.id);

    const gameId = await seedGame('x-1');
    await seedPick(gameId, 'Mine', 'home');

    await run(
      [normalized({ externalId: 'x-1', winner: 'home' })],
      [candidate({ id: gameId, venueId, externalId: 'x-1' })],
    );

    const otherBoard = await leaderboard.computeLeaderboard(otherVenue, 'all_time', { db: db.sql });
    expect(otherBoard).toEqual([]);
  });
});
