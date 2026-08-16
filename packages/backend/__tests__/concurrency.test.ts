import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger';
import { SportsProvider, type FetchGamesOptions, type NormalizedGame } from '../src/lib/sports-provider';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as DbNamespace from '../src/lib/db';
import type * as GradeGames from '../src/workers/grade-games';
import type * as LeaderboardNamespace from '../src/lib/leaderboard';
import type * as PicksNamespace from '../src/services/picks';
import type * as PlayersNamespace from '../src/services/players';

/**
 * Concurrency and data-integrity invariants, against real PostgreSQL.
 *
 * The distinction that makes this file worth having: the existing worker tests
 * drive these paths through fake transactors, which prove the *shape* of a
 * statement but cannot prove anything about what two connections do to one row
 * at the same instant. Every test here opens genuinely parallel connections
 * and asserts on committed state afterwards.
 *
 * Ground truth is recomputed from the raw rows rather than compared against
 * another derived value, so a bug in the aggregate cannot agree with itself.
 *
 * NOTE ON SCOPE: the brief this came from also asked for bankroll integrity —
 * double-spend, stake deduction, profit_loss payouts. FanBoard has no such
 * concept: there is no balance, stake, odds or payout column anywhere in the
 * schema, and scoring is flat (POINTS_FOR_CORRECT_PICK = 10 for a correct
 * pick, 0 otherwise). Those tests are not written because there is nothing for
 * them to assert against. The remaining five invariants are covered here.
 */

const silent = createLogger({ level: 'silent' });
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PREFIX = 'conc-int';

/** Stands in for the sports provider; returns whatever the test declares. */
class StubProvider extends SportsProvider {
  readonly name = 'conc-stub';
  constructor(private readonly games: NormalizedGame[]) {
    super();
  }
  fetchGames(_date: string, _options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    return Promise.resolve(this.games);
  }
}

function finished(externalId: string, winner: 'home' | 'away'): NormalizedGame {
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
    homeScore: winner === 'home' ? 21 : 14,
    awayScore: winner === 'home' ? 14 : 21,
    winner,
  };
}

describe.skipIf(TEST_DATABASE_URL === undefined)('concurrency and integrity', () => {
  let db: typeof DbNamespace;
  let picks: typeof PicksNamespace;
  let players: typeof PlayersNamespace;
  let leaderboard: typeof LeaderboardNamespace;
  let grade: typeof GradeGames;

  let venueA: UUID;
  let venueB: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    picks = await import('../src/services/picks');
    players = await import('../src/services/players');
    leaderboard = await import('../src/lib/leaderboard');
    grade = await import('../src/workers/grade-games');

    await cleanup();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  }, 30_000);

  beforeEach(async () => {
    await cleanup();
    venueA = await seedVenue('a');
    venueB = await seedVenue('b');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedVenue(label: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${label}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  /** `whenSql` is an interval expression applied to NOW(). */
  async function seedGame(venueId: UUID, externalId: string, whenSql: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at)
       VALUES ($1::uuid,$2,'NFL','American Football','Bears','Packers', ${whenSql})
       RETURNING id`,
      [venueId, externalId],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  async function seedPlayer(venueId: UUID, nickname: string): Promise<UUID> {
    const session = await players.createPlayerSession({ venueId, nickname });
    return session.playerId;
  }

  /**
   * Grades one game, scoped to it.
   *
   * The worker's own candidate query is global, and the integration suites run
   * in parallel — an unscoped run would settle another file's fixtures.
   */
  function gradeOne(
    venueId: UUID,
    gameId: UUID,
    externalId: string,
    winner: 'home' | 'away',
  ): Promise<GradeGames.GradeGamesResult> {
    return grade.gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([finished(externalId, winner)]),
      listCandidates: async () => [
        { id: gameId, venueId, externalId, scheduledAt: new Date(Date.now() - 3_600_000) },
      ],
      invalidateLeaderboards: async () => undefined,
      notify: async () => undefined,
      broadcastGraded: async () => undefined,
    });
  }

  // -------------------------------------------------------------------------
  // 1. Race conditions on pick placement
  // -------------------------------------------------------------------------

  describe('pick placement under concurrency', () => {
    it('writes exactly one row when a session submits twice simultaneously', async () => {
      const game = await seedGame(venueA, `${PREFIX}-p1`, `NOW() + INTERVAL '1 hour'`);
      const player = await seedPlayer(venueA, 'Simultaneous');

      // Both in flight at once, on separate pool connections. The UNIQUE
      // (game_id, player_session_id) plus ON CONFLICT is what has to hold; a
      // SELECT-then-INSERT would let both observe an empty table and write.
      const results = await Promise.allSettled([
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'home' }),
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'away' }),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(rows.rows[0]?.count).toBe('1');
    }, 30_000);

    it('leaves the surviving pick at one of the two submitted values', async () => {
      // Either may win the race; what must not happen is a torn row holding
      // neither value, or a row whose grading columns survived the update.
      const game = await seedGame(venueA, `${PREFIX}-p2`, `NOW() + INTERVAL '1 hour'`);
      const player = await seedPlayer(venueA, 'Torn');

      await Promise.allSettled([
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'home' }),
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'away' }),
      ]);

      const row = await db.query<{ predicted_winner: string; points: number | null; graded_at: Date | null }>(
        'SELECT predicted_winner, points, graded_at FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(['home', 'away']).toContain(row.rows[0]?.predicted_winner);
      expect(row.rows[0]?.points).toBeNull();
      expect(row.rows[0]?.graded_at).toBeNull();
    }, 30_000);

    it('admits 100 distinct players to one game with no lost writes', async () => {
      const game = await seedGame(venueA, `${PREFIX}-burst`, `NOW() + INTERVAL '1 hour'`);
      const sessions = await Promise.all(
        Array.from({ length: 100 }, (_, i) => seedPlayer(venueA, `Burst${String.fromCharCode(97 + (i % 26))}${i}`)),
      );

      const outcomes = await Promise.allSettled(
        sessions.map((playerSessionId, i) =>
          picks.submitPick({
            venueId: venueA,
            gameId: game,
            playerSessionId,
            predictedWinner: i % 2 === 0 ? 'home' : 'away',
          }),
        ),
      );

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(100);

      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(rows.rows[0]?.count).toBe('100');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 2. Immutability after lock
  // -------------------------------------------------------------------------

  describe('picks after lock', () => {
    it('refuses a new pick on a locked game', async () => {
      const game = await seedGame(venueA, `${PREFIX}-l1`, `NOW() - INTERVAL '1 minute'`);
      const player = await seedPlayer(venueA, 'TooLate');

      await expect(
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'home' }),
      ).rejects.toMatchObject({ status: 423 });
    }, 30_000);

    it('refuses to edit an existing pick once the game locks, leaving it untouched', async () => {
      // The pick is the player's committed answer. A rejected edit must not
      // silently rewrite it, or a late tap changes a prediction after kick-off.
      const game = await seedGame(venueA, `${PREFIX}-l2`, `NOW() + INTERVAL '2 seconds'`);
      const player = await seedPlayer(venueA, 'Committed');

      await picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'home' });
      const before = await db.query<{ submitted_at: Date }>(
        'SELECT submitted_at FROM picks WHERE game_id = $1::uuid',
        [game],
      );

      await db.query(`UPDATE games SET scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1::uuid`, [game]);

      await expect(
        picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: player, predictedWinner: 'away' }),
      ).rejects.toMatchObject({ status: 423 });

      const after = await db.query<{ predicted_winner: string; submitted_at: Date }>(
        'SELECT predicted_winner, submitted_at FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(after.rows[0]?.predicted_winner).toBe('home');
      expect(after.rows[0]?.submitted_at.toISOString()).toBe(
        before.rows[0]?.submitted_at.toISOString(),
      );
    }, 30_000);

    it('refuses every pick in a concurrent burst against a locked game', async () => {
      const game = await seedGame(venueA, `${PREFIX}-l3`, `NOW() - INTERVAL '1 minute'`);
      const sessions = await Promise.all(
        Array.from({ length: 20 }, (_, i) => seedPlayer(venueA, `Late${String.fromCharCode(97 + i)}`)),
      );

      const outcomes = await Promise.allSettled(
        sessions.map((playerSessionId) =>
          picks.submitPick({ venueId: venueA, gameId: game, playerSessionId, predictedWinner: 'home' }),
        ),
      );

      expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);

      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(rows.rows[0]?.count).toBe('0');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 3. Double settlement
  // -------------------------------------------------------------------------

  describe('settlement', () => {
    it('settles once when two grading runs race on the same game', async () => {
      // The interesting case, and the one fakes cannot reach: both runs read
      // graded_at IS NULL, then contend for the row lock. The loser must
      // re-evaluate its predicate against the committed row and match nothing.
      const game = await seedGame(venueA, `${PREFIX}-s1`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueA, 'Raced');
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueA, game, player],
      );

      const [first, second] = await Promise.all([
        gradeOne(venueA, game, `${PREFIX}-s1`, 'home'),
        gradeOne(venueA, game, `${PREFIX}-s1`, 'home'),
      ]);

      // Exactly one run settles it; the other skips.
      expect(first.gamesGraded + second.gamesGraded).toBe(1);
      expect(first.errors + second.errors).toBe(0);

      const row = await db.query<{ points: number; correct: boolean }>(
        'SELECT points, correct FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      // Not 20: a double settlement would score the pick twice.
      expect(row.rows[0]?.points).toBe(10);
      expect(row.rows[0]?.correct).toBe(true);
    }, 60_000);

    it('settles once when two separate instances grade the same game', async () => {
      // The Promise.all above races two runs over one shared pool. This races
      // two runs over two *independent* pools, which is what two containers
      // actually are: no shared client, no shared transaction state, nothing in
      // common but the database. The guard has to hold there or it does not
      // hold in production.
      const { Pool } = await import('pg');
      const instanceA = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
      const instanceB = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });

      /** withTransaction bound to one instance's own pool. */
      const transactorFor =
        (pool: InstanceType<typeof Pool>) =>
        async <T>(work: (tx: DbNamespace.SqlExecutor) => Promise<T>): Promise<T> => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const value = await work({
              query: async <R>(text: string, params?: readonly unknown[]) => {
                const r = await client.query(text, params as unknown[]);
                return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
              },
            });
            await client.query('COMMIT');
            return value;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };

      try {
        const game = await seedGame(venueA, `${PREFIX}-mi`, `NOW() - INTERVAL '2 hours'`);
        const player = await seedPlayer(venueA, 'MultiInstance');
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
          [venueA, game, player],
        );

        const runOn = (pool: InstanceType<typeof Pool>) =>
          grade.gradeGamesOnce({
            logger: silent,
            provider: new StubProvider([finished(`${PREFIX}-mi`, 'home')]),
            listCandidates: async () => [
              { id: game, venueId: venueA, externalId: `${PREFIX}-mi`, scheduledAt: new Date() },
            ],
            withTransaction: transactorFor(pool),
            invalidateLeaderboards: async () => undefined,
            notify: async () => undefined,
            broadcastGraded: async () => undefined,
          });

        const [a, b] = await Promise.all([runOn(instanceA), runOn(instanceB)]);

        expect(a.gamesGraded + b.gamesGraded).toBe(1);
        expect(a.errors + b.errors).toBe(0);

        const row = await db.query<{ points: number; graded_at: Date | null }>(
          'SELECT points, graded_at FROM picks WHERE game_id = $1::uuid',
          [game],
        );
        // 10, not 20: the loser re-evaluated `graded_at IS NULL` against the
        // committed row after waiting on the lock, and matched nothing.
        expect(row.rows[0]?.points).toBe(10);
        expect(row.rows[0]?.graded_at).not.toBeNull();
      } finally {
        await instanceA.end();
        await instanceB.end();
      }
    }, 60_000);

    it('does not re-score when a later run reports a different winner', async () => {
      // A provider that changes its mind after a game is settled must not be
      // able to rewrite history, or a leaderboard silently restates itself.
      const game = await seedGame(venueA, `${PREFIX}-s2`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueA, 'Settled');
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueA, game, player],
      );

      await gradeOne(venueA, game, `${PREFIX}-s2`, 'home');
      const second = await gradeOne(venueA, game, `${PREFIX}-s2`, 'away');

      expect(second.gamesGraded).toBe(0);

      const row = await db.query<{ points: number; correct: boolean }>(
        'SELECT points, correct FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(row.rows[0]?.points).toBe(10);
      expect(row.rows[0]?.correct).toBe(true);
    }, 60_000);

    it('holds the standings steady across a repeated grading run', async () => {
      const game = await seedGame(venueA, `${PREFIX}-s3`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueA, 'Stable');
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueA, game, player],
      );

      await gradeOne(venueA, game, `${PREFIX}-s3`, 'home');
      const before = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      await gradeOne(venueA, game, `${PREFIX}-s3`, 'home');
      const after = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      expect(after).toEqual(before);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 4. Leaderboard accuracy
  // -------------------------------------------------------------------------

  describe('leaderboard accuracy', () => {
    it('matches a ground-truth aggregate computed from the raw picks', async () => {
      // Ten players, a deterministic spread of right and wrong answers, then
      // the board is compared against SQL that counts the picks directly
      // rather than against another derived value.
      const game = await seedGame(venueA, `${PREFIX}-lb1`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all(
        Array.from({ length: 10 }, (_, i) => seedPlayer(venueA, `Board${String.fromCharCode(97 + i)}`)),
      );

      for (const [index, playerSessionId] of roster.entries()) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text)`,
          [venueA, game, playerSessionId, index % 3 === 0 ? 'home' : 'away'],
        );
      }

      await gradeOne(venueA, game, `${PREFIX}-lb1`, 'home');

      const board = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      const truth = await db.query<{ nickname: string; wins: string; losses: string; points: string }>(
        `SELECT s.nickname,
                count(*) FILTER (WHERE p.correct IS TRUE)::text  AS wins,
                count(*) FILTER (WHERE p.correct IS FALSE)::text AS losses,
                COALESCE(sum(p.points), 0)::text                 AS points
           FROM picks p
           JOIN player_sessions s ON s.id = p.player_session_id
          WHERE p.venue_id = $1::uuid AND p.graded_at IS NOT NULL
          GROUP BY s.nickname`,
        [venueA],
      );

      const expected = new Map(
        truth.rows.map((r) => [r.nickname, { wins: Number(r.wins), losses: Number(r.losses), points: Number(r.points) }]),
      );

      expect(board).toHaveLength(expected.size);
      for (const entry of board) {
        expect(entry).toMatchObject(expected.get(entry.nickname) as object);
      }
    }, 60_000);

    it('orders by points descending with dense, gapless ranks', async () => {
      const game = await seedGame(venueA, `${PREFIX}-lb2`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all(
        Array.from({ length: 6 }, (_, i) => seedPlayer(venueA, `Rank${String.fromCharCode(97 + i)}`)),
      );
      for (const [index, playerSessionId] of roster.entries()) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text)`,
          [venueA, game, playerSessionId, index < 3 ? 'home' : 'away'],
        );
      }
      await gradeOne(venueA, game, `${PREFIX}-lb2`, 'home');

      const board = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      for (let i = 1; i < board.length; i += 1) {
        expect(board[i]!.points).toBeLessThanOrEqual(board[i - 1]!.points);
        expect(board[i]!.rank).toBeGreaterThanOrEqual(board[i - 1]!.rank);
      }
      expect(board[0]?.rank).toBe(1);
    }, 60_000);

    it('breaks a tie by who picked first, and repeats identically', async () => {
      // Three players with identical records. Ranking is ROW_NUMBER over
      // (points, wins, first_pick_at, player_session_id), so tied players get
      // distinct consecutive ranks rather than a shared one, decided by who
      // committed earliest.
      //
      // The property that matters operationally is the second assertion:
      // recomputing must produce the identical assignment. Without a total
      // ordering the tie would resolve differently on each five-minute pass and
      // the TV would reshuffle players who had done nothing.
      const game = await seedGame(venueA, `${PREFIX}-lb3`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all([
        seedPlayer(venueA, 'TieEarly'),
        seedPlayer(venueA, 'TieMiddle'),
        seedPlayer(venueA, 'TieLate'),
      ]);

      // Explicit, distinct submission times so the expected order is knowable
      // rather than incidental.
      for (const [index, playerSessionId] of roster.entries()) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, submitted_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home', NOW() - make_interval(mins => $4::int))`,
          [venueA, game, playerSessionId, 30 - index * 10],
        );
      }
      await gradeOne(venueA, game, `${PREFIX}-lb3`, 'home');

      const first = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });
      const second = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      expect(first.map((e) => e.points)).toEqual([10, 10, 10]);
      expect(first.map((e) => e.rank)).toEqual([1, 2, 3]);
      expect(first.map((e) => e.nickname)).toEqual(['TieEarly', 'TieMiddle', 'TieLate']);

      expect(second.map((e) => `${e.nickname}:${e.rank}`)).toEqual(
        first.map((e) => `${e.nickname}:${e.rank}`),
      );
    }, 60_000);

    it('stays correct when the board is recomputed while grading runs', async () => {
      // A read racing a settlement must never produce a half-graded board: it
      // sees the game either settled or not, never partly.
      const game = await seedGame(venueA, `${PREFIX}-lb4`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all(
        Array.from({ length: 8 }, (_, i) => seedPlayer(venueA, `Mid${String.fromCharCode(97 + i)}`)),
      );
      for (const playerSessionId of roster) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
          [venueA, game, playerSessionId],
        );
      }

      const [, ...boards] = await Promise.all([
        gradeOne(venueA, game, `${PREFIX}-lb4`, 'home'),
        leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql }),
        leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql }),
      ]);

      for (const board of boards) {
        // Either nobody is on it yet, or everyone is — never a partial slice.
        expect([0, roster.length]).toContain(board.length);
        for (const entry of board) {
          expect(entry.points).toBe(10);
        }
      }

      const settled = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });
      expect(settled).toHaveLength(roster.length);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 4b. Leaderboard snapshot under concurrent computation
  // -------------------------------------------------------------------------

  describe('snapshot materialisation under concurrency', () => {
    /** Seeds `count` players with graded picks on one settled game. */
    async function seedSettledBoard(venueId: UUID, label: string, count: number): Promise<void> {
      const game = await seedGame(venueId, `${PREFIX}-${label}`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          seedPlayer(venueId, `Snap${label}${String.fromCharCode(97 + i)}`),
        ),
      );
      for (const [index, playerSessionId] of roster.entries()) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text)`,
          [venueId, game, playerSessionId, index % 2 === 0 ? 'home' : 'away'],
        );
      }
      await gradeOne(venueId, game, `${PREFIX}-${label}`, 'home');
    }

    it('holds one row per player when two instances materialise at once', async () => {
      // Two instances both run update-leaderboard on a five minute cadence, and
      // grading triggers an extra pass, so simultaneous materialisation of the
      // same venue and period is ordinary rather than exotic.
      await seedSettledBoard(venueA, 'x', 10);

      await Promise.all([
        leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql }),
        leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql }),
      ]);

      const stored = await db.query<{ count: string; distinct: string }>(
        `SELECT count(*)::text AS count,
                count(DISTINCT player_session_id)::text AS distinct
           FROM leaderboard_snapshot
          WHERE venue_id = $1::uuid AND period = 'all_time'`,
        [venueA],
      );

      // Duplicated rows would render every player twice on the TV.
      expect(stored.rows[0]?.count).toBe('10');
      expect(stored.rows[0]?.distinct).toBe('10');
    }, 60_000);

    it('leaves exactly one row per rank after concurrent materialisation', async () => {
      await seedSettledBoard(venueA, 'y', 6);

      await Promise.all([
        leaderboard.computeLeaderboard(venueA, 'this_week', { db: db.sql }),
        leaderboard.computeLeaderboard(venueA, 'this_week', { db: db.sql }),
        leaderboard.computeLeaderboard(venueA, 'this_week', { db: db.sql }),
      ]);

      const ranks = await db.query<{ rank: number; n: string }>(
        `SELECT rank, count(*)::text AS n
           FROM leaderboard_snapshot
          WHERE venue_id = $1::uuid AND period = 'weekly'
          GROUP BY rank ORDER BY rank`,
        [venueA],
      );

      expect(ranks.rows).toHaveLength(6);
      for (const row of ranks.rows) {
        expect(row.n).toBe('1');
      }
    }, 60_000);

    it('serves a read that races materialisation without duplicates', async () => {
      await seedSettledBoard(venueA, 'z', 8);
      await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });

      const [, ...reads] = await Promise.all([
        leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql }),
        leaderboard.readLeaderboardSnapshot(venueA, 'all_time', { db: db.sql }),
        leaderboard.readLeaderboardSnapshot(venueA, 'all_time', { db: db.sql }),
      ]);

      for (const board of reads) {
        const names = board.map((e) => e.nickname);
        expect(new Set(names).size).toBe(names.length);
      }
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 5. Venue isolation
  // -------------------------------------------------------------------------

  describe('venue isolation', () => {
    it('keeps grading in one venue out of another venue’s standings', async () => {
      const gameA = await seedGame(venueA, `${PREFIX}-vA`, `NOW() - INTERVAL '2 hours'`);
      const gameB = await seedGame(venueB, `${PREFIX}-vB`, `NOW() - INTERVAL '2 hours'`);
      const playerA = await seedPlayer(venueA, 'InsiderA');
      const playerB = await seedPlayer(venueB, 'InsiderB');

      for (const [venueId, gameId, playerSessionId] of [
        [venueA, gameA, playerA],
        [venueB, gameB, playerB],
      ] as const) {
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
          [venueId, gameId, playerSessionId],
        );
      }

      await gradeOne(venueA, gameA, `${PREFIX}-vA`, 'home');

      const boardA = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });
      const boardB = await leaderboard.computeLeaderboard(venueB, 'all_time', { db: db.sql });

      expect(boardA.map((e) => e.nickname)).toEqual(['InsiderA']);
      // B's game was never graded, so B's board is still empty.
      expect(boardB).toEqual([]);

      const bPick = await db.query<{ points: number | null; graded_at: Date | null }>(
        'SELECT points, graded_at FROM picks WHERE game_id = $1::uuid',
        [gameB],
      );
      expect(bPick.rows[0]?.points).toBeNull();
      expect(bPick.rows[0]?.graded_at).toBeNull();
    }, 60_000);

    it('holds isolation while both venues are graded at once', async () => {
      const gameA = await seedGame(venueA, `${PREFIX}-cA`, `NOW() - INTERVAL '2 hours'`);
      const gameB = await seedGame(venueB, `${PREFIX}-cB`, `NOW() - INTERVAL '2 hours'`);
      const playerA = await seedPlayer(venueA, 'BothA');
      const playerB = await seedPlayer(venueB, 'BothB');

      // A picks correctly, B picks wrongly, and both are settled in parallel.
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueA, gameA, playerA],
      );
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueB, gameB, playerB],
      );

      await Promise.all([
        gradeOne(venueA, gameA, `${PREFIX}-cA`, 'home'),
        gradeOne(venueB, gameB, `${PREFIX}-cB`, 'away'),
      ]);

      const boardA = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });
      const boardB = await leaderboard.computeLeaderboard(venueB, 'all_time', { db: db.sql });

      expect(boardA).toHaveLength(1);
      expect(boardA[0]).toMatchObject({ nickname: 'BothA', wins: 1, points: 10 });

      expect(boardB).toHaveLength(1);
      expect(boardB[0]).toMatchObject({ nickname: 'BothB', losses: 1, points: 0 });
    }, 60_000);

    it('refuses a pick aimed at another venue’s game', async () => {
      // Belt and braces over the composite foreign key: the service answers 404
      // rather than letting the write reach a constraint violation.
      const gameB = await seedGame(venueB, `${PREFIX}-x`, `NOW() + INTERVAL '1 hour'`);
      const playerA = await seedPlayer(venueA, 'Crosser');

      await expect(
        picks.submitPick({ venueId: venueA, gameId: gameB, playerSessionId: playerA, predictedWinner: 'home' }),
      ).rejects.toMatchObject({ status: 404 });

      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM picks WHERE game_id = $1::uuid',
        [gameB],
      );
      expect(rows.rows[0]?.count).toBe('0');
    }, 30_000);

    it('cannot be tricked into writing a pick across venues by the database', async () => {
      // The composite FK (venue_id, game_id) is the last line of defence: even
      // a direct insert that claims the wrong venue must be rejected, so an
      // application bug cannot produce a pick straddling two tenants.
      const gameB = await seedGame(venueB, `${PREFIX}-fk`, `NOW() + INTERVAL '1 hour'`);
      const playerA = await seedPlayer(venueA, 'Forger');

      await expect(
        db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
          [venueA, gameB, playerA],
        ),
      ).rejects.toThrow();
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // 6. End to end
  // -------------------------------------------------------------------------

  it('runs pick, lock, settle, recompute and settle again without drift', async () => {
    const game = await seedGame(venueA, `${PREFIX}-e2e`, `NOW() + INTERVAL '2 seconds'`);
    const roster = await Promise.all([
      seedPlayer(venueA, 'FlowOne'),
      seedPlayer(venueA, 'FlowTwo'),
      seedPlayer(venueA, 'FlowThree'),
    ]);

    // 1. Everyone picks while the game is open; two right, one wrong.
    await Promise.all(
      roster.map((playerSessionId, i) =>
        picks.submitPick({
          venueId: venueA,
          gameId: game,
          playerSessionId,
          predictedWinner: i < 2 ? 'home' : 'away',
        }),
      ),
    );

    // 2. Kick-off passes.
    await db.query(`UPDATE games SET scheduled_at = NOW() - INTERVAL '2 hours' WHERE id = $1::uuid`, [game]);

    // 3. No further picks.
    const latecomer = await seedPlayer(venueA, 'FlowLate');
    await expect(
      picks.submitPick({ venueId: venueA, gameId: game, playerSessionId: latecomer, predictedWinner: 'home' }),
    ).rejects.toMatchObject({ status: 423 });

    // 4. Settle.
    const first = await gradeOne(venueA, game, `${PREFIX}-e2e`, 'home');
    expect(first.gamesGraded).toBe(1);
    expect(first.picksGraded).toBe(3);

    const board = await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql });
    expect(board.filter((e) => e.points === 10)).toHaveLength(2);
    expect(board.filter((e) => e.points === 0)).toHaveLength(1);

    // 5. Settle again — nothing moves.
    const second = await gradeOne(venueA, game, `${PREFIX}-e2e`, 'home');
    expect(second.gamesGraded).toBe(0);
    expect(await leaderboard.computeLeaderboard(venueA, 'all_time', { db: db.sql })).toEqual(board);
  }, 90_000);
});
