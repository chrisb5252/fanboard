import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger';
import { SportsProvider, type FetchGamesOptions, type NormalizedGame } from '../src/lib/sports-provider';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as DbNamespace from '../src/lib/db';
import type * as GradeGames from '../src/workers/grade-games';
import type * as LeaderboardNamespace from '../src/lib/leaderboard';
import type * as OpsNamespace from '../src/services/ops';
import type * as PicksNamespace from '../src/services/picks';
import type * as PlayersNamespace from '../src/services/players';
import type * as SuspendRoute from '../src/app/api/admin/venues/[venueId]/suspend/route';
import type * as PickRoute from '../src/app/api/admin/venues/[venueId]/picks/[pickId]/route';
import type * as ReconcileRoute from '../src/app/api/admin/venues/[venueId]/reconcile/route';
import type * as AuditRoute from '../src/app/api/admin/venues/[venueId]/audit-log/route';

/**
 * Operator tools, against real PostgreSQL.
 *
 * These exist to be used in an emergency by someone who did not build the
 * system, so the tests lean on the properties that matter under pressure:
 * repeating an action is safe, the blast radius is what was intended and no
 * wider, and the response says what actually happened.
 */

const silent = createLogger({ level: 'silent' });
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PREFIX = 'ops-int';

class StubProvider extends SportsProvider {
  readonly name = 'ops-stub';
  constructor(private readonly games: NormalizedGame[]) {
    super();
  }
  fetchGames(_d: string, _o?: FetchGamesOptions): Promise<NormalizedGame[]> {
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

describe.skipIf(TEST_DATABASE_URL === undefined)('operator tools', () => {
  let db: typeof DbNamespace;
  let ops: typeof OpsNamespace;
  let picks: typeof PicksNamespace;
  let players: typeof PlayersNamespace;
  let leaderboard: typeof LeaderboardNamespace;
  let grade: typeof GradeGames;

  let venueId: UUID;
  let otherVenueId: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    ops = await import('../src/services/ops');
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
    venueId = await seedVenue('main');
    otherVenueId = await seedVenue('other');
  });

  async function seedVenue(label: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${label}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  async function seedGame(venue: UUID, externalId: string, whenSql: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at)
       VALUES ($1::uuid,$2,'NFL','American Football','Bears','Packers', ${whenSql}) RETURNING id`,
      [venue, externalId],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  const seedPlayer = async (venue: UUID, nickname: string): Promise<UUID> =>
    (await players.createPlayerSession({ venueId: venue, nickname })).playerId;

  function gradeOne(venue: UUID, gameId: UUID, externalId: string, winner: 'home' | 'away') {
    return grade.gradeGamesOnce({
      logger: silent,
      provider: new StubProvider([finished(externalId, winner)]),
      listCandidates: async () => [
        { id: gameId, venueId: venue, externalId, scheduledAt: new Date(Date.now() - 3_600_000) },
      ],
      invalidateLeaderboards: async () => undefined,
      notify: async () => undefined,
      broadcastGraded: async () => undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Suspension
  // -------------------------------------------------------------------------

  describe('suspend and resume', () => {
    it('rejects new picks with 403 while suspended, and accepts them again after', async () => {
      const game = await seedGame(venueId, `${PREFIX}-s`, `NOW() + INTERVAL '1 hour'`);
      const player = await seedPlayer(venueId, 'Suspended');

      await ops.suspendVenue(venueId, 'disputed result', { logger: silent });

      // 403 rather than 423: the game is open, the venue is closed.
      await expect(
        picks.submitPick({ venueId, gameId: game, playerSessionId: player, predictedWinner: 'home' }),
      ).rejects.toMatchObject({ status: 403 });

      await ops.resumeVenue(venueId, { logger: silent });

      const written = await picks.submitPick({
        venueId,
        gameId: game,
        playerSessionId: player,
        predictedWinner: 'home',
      });
      expect(written.created).toBe(true);
    }, 30_000);

    it('keeps grading and settlement working while suspended', async () => {
      // The narrow blast radius is the point. Freezing settlement would punish
      // patrons whose picks were already in for an operator's problem.
      const game = await seedGame(venueId, `${PREFIX}-sg`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueId, 'StillGrades');
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueId, game, player],
      );

      await ops.suspendVenue(venueId, 'under investigation', { logger: silent });
      const result = await gradeOne(venueId, game, `${PREFIX}-sg`, 'home');

      expect(result.gamesGraded).toBe(1);
      const row = await db.query<{ points: number }>(
        'SELECT points FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      expect(row.rows[0]?.points).toBe(10);
    }, 30_000);

    it('is idempotent and keeps the original timestamp', async () => {
      const first = await ops.suspendVenue(venueId, 'first reason', { logger: silent });
      const second = await ops.suspendVenue(venueId, 'second reason', { logger: silent });

      // The reason updates; when it started does not, so "how long has this
      // been down?" stays answerable.
      expect(second.since).toBe(first.since);
      expect(second.reason).toBe('second reason');
    }, 30_000);

    it('resumes cleanly even if it was never suspended', async () => {
      const state = await ops.resumeVenue(venueId, { logger: silent });
      expect(state.suspended).toBe(false);
    }, 30_000);

    it('does not suspend any other venue', async () => {
      const game = await seedGame(otherVenueId, `${PREFIX}-iso`, `NOW() + INTERVAL '1 hour'`);
      const player = await seedPlayer(otherVenueId, 'Unaffected');

      await ops.suspendVenue(venueId, 'only this one', { logger: silent });

      const written = await picks.submitPick({
        venueId: otherVenueId,
        gameId: game,
        playerSessionId: player,
        predictedWinner: 'home',
      });
      expect(written.created).toBe(true);
      expect((await ops.getVenueState(otherVenueId)).suspended).toBe(false);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Voiding
  // -------------------------------------------------------------------------

  describe('voiding a pick', () => {
    async function settledPick(nickname: string, label: string): Promise<{ pickId: UUID; player: UUID; game: UUID }> {
      const game = await seedGame(venueId, `${PREFIX}-${label}`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueId, nickname);
      const row = await db.query<{ id: string }>(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home') RETURNING id`,
        [venueId, game, player],
      );
      await gradeOne(venueId, game, `${PREFIX}-${label}`, 'home');
      return { pickId: trustedUuid(row.rows[0]!.id), player, game };
    }

    it('removes the player from the standings rather than scoring them zero', async () => {
      // Zero points is a loss on the board. Void means the pick should not have
      // counted at all, which is the schema's voided state: graded_at set,
      // correct and points null.
      const { pickId, player } = await settledPick('Voided', 'v1');

      const before = await leaderboard.computeLeaderboard(venueId, 'all_time');
      expect(before.find((e) => e.playerSessionId === player)?.points).toBe(10);

      await ops.voidPick(pickId, { logger: silent });

      const row = await db.query<{ correct: boolean | null; points: number | null; graded_at: Date | null }>(
        'SELECT correct, points, graded_at FROM picks WHERE id = $1::uuid',
        [pickId],
      );
      expect(row.rows[0]?.correct).toBeNull();
      expect(row.rows[0]?.points).toBeNull();
      expect(row.rows[0]?.graded_at).not.toBeNull();

      const after = await leaderboard.computeLeaderboard(venueId, 'all_time');
      expect(after.find((e) => e.playerSessionId === player)).toBeUndefined();
    }, 30_000);

    it('is idempotent and says so on the second call', async () => {
      const { pickId } = await settledPick('TwiceVoided', 'v2');

      const first = await ops.voidPick(pickId, { logger: silent });
      const second = await ops.voidPick(pickId, { logger: silent });

      expect(first.alreadyVoid).toBe(false);
      expect(second.alreadyVoid).toBe(true);
    }, 30_000);

    it('leaves every other pick on the same game alone', async () => {
      const game = await seedGame(venueId, `${PREFIX}-v3`, `NOW() - INTERVAL '2 hours'`);
      const roster = await Promise.all([
        seedPlayer(venueId, 'KeepOne'),
        seedPlayer(venueId, 'KeepTwo'),
        seedPlayer(venueId, 'DropMe'),
      ]);
      const ids: UUID[] = [];
      for (const player of roster) {
        const row = await db.query<{ id: string }>(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'home') RETURNING id`,
          [venueId, game, player],
        );
        ids.push(trustedUuid(row.rows[0]!.id));
      }
      await gradeOne(venueId, game, `${PREFIX}-v3`, 'home');

      await ops.voidPick(ids[2]!, { logger: silent });

      const survivors = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM picks
          WHERE game_id = $1::uuid AND points = 10`,
        [game],
      );
      expect(survivors.rows[0]?.count).toBe('2');
    }, 30_000);

    it('reports a missing pick rather than silently doing nothing', async () => {
      await expect(
        ops.voidPick(trustedUuid('00000000-0000-0000-0000-0000000000aa'), { logger: silent }),
      ).rejects.toMatchObject({ status: 404 });
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  describe('reconciliation', () => {
    async function playerWithPoints(nickname: string, label: string): Promise<UUID> {
      const game = await seedGame(venueId, `${PREFIX}-${label}`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueId, nickname);
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [venueId, game, player],
      );
      await gradeOne(venueId, game, `${PREFIX}-${label}`, 'home');
      return player;
    }

    it('reports no mismatch when the board is current', async () => {
      const player = await playerWithPoints('Consistent', 'r1');
      await leaderboard.computeLeaderboard(venueId, 'all_time');

      const outcome = await ops.reconcilePlayer(venueId, player, 'all_time', { logger: silent });

      expect(outcome.mismatch).toBe(false);
      expect(outcome.repaired).toBe(false);
      expect(outcome.truth).toMatchObject({ wins: 1, losses: 0, points: 10 });
    }, 30_000);

    it('detects a stale board and repairs it', async () => {
      const player = await playerWithPoints('Stale', 'r2');
      await leaderboard.computeLeaderboard(venueId, 'all_time');

      // Corrupt the derived table directly, which is exactly the failure this
      // endpoint exists for: the picks are right and the board is not.
      await db.query(
        `UPDATE leaderboard_snapshot SET points = 999, wins = 99
          WHERE venue_id = $1::uuid AND player_session_id = $2::uuid`,
        [venueId, player],
      );

      const outcome = await ops.reconcilePlayer(venueId, player, 'all_time', { logger: silent });

      expect(outcome.mismatch).toBe(true);
      expect(outcome.repaired).toBe(true);
      expect(outcome.snapshot?.points).toBe(10);
    }, 30_000);

    it('spots a player missing from the board entirely', async () => {
      const player = await playerWithPoints('Missing', 'r3');
      await leaderboard.computeLeaderboard(venueId, 'all_time');
      await db.query(
        'DELETE FROM leaderboard_snapshot WHERE venue_id = $1::uuid AND player_session_id = $2::uuid',
        [venueId, player],
      );

      const outcome = await ops.reconcilePlayer(venueId, player, 'all_time', { logger: silent });

      expect(outcome.mismatch).toBe(true);
      expect(outcome.repaired).toBe(true);
      expect(outcome.snapshot?.points).toBe(10);
    }, 30_000);

    it('does not call a player with no graded picks a mismatch', async () => {
      // Absent from the board is correct for someone who has not been graded,
      // and reporting it as a fault would send an operator chasing nothing.
      const player = await seedPlayer(venueId, 'Newcomer');
      const outcome = await ops.reconcilePlayer(venueId, player, 'all_time', { logger: silent });

      expect(outcome.mismatch).toBe(false);
      expect(outcome.truth.picks).toBe(0);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Manual settlement
  // -------------------------------------------------------------------------

  describe('manual grading', () => {
    async function ungradedGame(label: string, nicknames: string[]): Promise<UUID> {
      const game = await seedGame(venueId, `${PREFIX}-${label}`, `NOW() - INTERVAL '3 hours'`);
      for (const nickname of nicknames) {
        const player = await seedPlayer(venueId, nickname);
        await db.query(
          `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text)`,
          [venueId, game, player, nickname.endsWith('Home') ? 'home' : 'away'],
        );
      }
      return game;
    }

    it('settles a game the provider never reported, scoring each pick once', async () => {
      const game = await ungradedGame('m1', ['ManualHome', 'ManualAway']);

      const result = await ops.gradeGameManually(
        venueId,
        game,
        { status: 'final', winner: 'home', homeScore: 24, awayScore: 21 },
        { logger: silent },
      );

      expect(result.gamesGraded).toBe(1);
      expect(result.picksGraded).toBe(2);
      expect(result.alreadyGraded).toBe(false);

      const scored = await db.query<{ nickname: string; points: number; correct: boolean }>(
        `SELECT s.nickname, p.points, p.correct
           FROM picks p JOIN player_sessions s ON s.id = p.player_session_id
          WHERE p.game_id = $1::uuid ORDER BY s.nickname`,
        [game],
      );
      expect(scored.rows).toEqual([
        { nickname: 'ManualAway', points: 0, correct: false },
        { nickname: 'ManualHome', points: 10, correct: true },
      ]);
    }, 30_000);

    it('writes the score and winner onto the game itself', async () => {
      const game = await ungradedGame('m2', ['ScoreHome']);
      await ops.gradeGameManually(
        venueId,
        game,
        { status: 'final', winner: 'away', homeScore: 14, awayScore: 28 },
        { logger: silent },
      );

      const row = await db.query<{
        status: string;
        winner: string;
        home_score: number;
        away_score: number;
        graded_at: Date | null;
      }>('SELECT status, winner, home_score, away_score, graded_at FROM games WHERE id = $1::uuid', [
        game,
      ]);
      expect(row.rows[0]).toMatchObject({
        status: 'final',
        winner: 'away',
        home_score: 14,
        away_score: 28,
      });
      expect(row.rows[0]?.graded_at).not.toBeNull();
    }, 30_000);

    it('voids every pick when the game is cancelled', async () => {
      const game = await ungradedGame('m3', ['VoidHome', 'VoidAway']);

      const result = await ops.gradeGameManually(
        venueId,
        game,
        { status: 'cancelled' },
        { logger: silent },
      );
      expect(result.gamesVoided).toBe(1);

      const rows = await db.query<{ correct: boolean | null; points: number | null }>(
        'SELECT correct, points FROM picks WHERE game_id = $1::uuid',
        [game],
      );
      // Voided is neither a win nor a loss: both null, with graded_at set.
      expect(rows.rows.every((r) => r.correct === null && r.points === null)).toBe(true);

      const board = await leaderboard.computeLeaderboard(venueId, 'all_time');
      expect(board).toEqual([]);
    }, 30_000);

    it('refuses to restate a game that is already settled', async () => {
      // Rewriting a settled result silently is how a leaderboard changes
      // underneath people with no trail. Correcting one means voiding picks.
      const game = await ungradedGame('m4', ['SettledHome']);
      await ops.gradeGameManually(
        venueId,
        game,
        { status: 'final', winner: 'home' },
        { logger: silent },
      );

      const second = await ops.gradeGameManually(
        venueId,
        game,
        { status: 'final', winner: 'away' },
        { logger: silent },
      );

      expect(second.alreadyGraded).toBe(true);
      expect(second.gamesGraded).toBe(0);

      const row = await db.query<{ winner: string; points: number }>(
        `SELECT g.winner, p.points FROM games g JOIN picks p ON p.game_id = g.id
          WHERE g.id = $1::uuid`,
        [game],
      );
      expect(row.rows[0]).toMatchObject({ winner: 'home', points: 10 });
    }, 30_000);

    it('will not settle a game belonging to another venue', async () => {
      const game = await seedGame(otherVenueId, `${PREFIX}-m5`, `NOW() - INTERVAL '3 hours'`);
      await expect(
        ops.gradeGameManually(
          venueId,
          game,
          { status: 'final', winner: 'home' },
          { logger: silent },
        ),
      ).rejects.toMatchObject({ status: 404 });
    }, 30_000);

    it('does not touch other ungraded games at the same venue', async () => {
      const target = await ungradedGame('m6a', ['TargetHome']);
      const bystander = await ungradedGame('m6b', ['BystanderHome']);

      await ops.gradeGameManually(
        venueId,
        target,
        { status: 'final', winner: 'home' },
        { logger: silent },
      );

      const untouched = await db.query<{ graded_at: Date | null }>(
        'SELECT graded_at FROM games WHERE id = $1::uuid',
        [bystander],
      );
      expect(untouched.rows[0]?.graded_at).toBeNull();
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // HTTP contract
  // -------------------------------------------------------------------------

  describe('admin routes', () => {
    let suspendRoute: typeof SuspendRoute;
    let pickRoute: typeof PickRoute;
    let reconcileRoute: typeof ReconcileRoute;
    let auditRoute: typeof AuditRoute;

    let key: string;
    let keyedVenue: UUID;

    beforeEach(async () => {
      suspendRoute = await import('../src/app/api/admin/venues/[venueId]/suspend/route');
      pickRoute = await import('../src/app/api/admin/venues/[venueId]/picks/[pickId]/route');
      reconcileRoute = await import('../src/app/api/admin/venues/[venueId]/reconcile/route');
      auditRoute = await import('../src/app/api/admin/venues/[venueId]/audit-log/route');

      key = `admin-key-${Math.random().toString(36).slice(2)}`;
      const row = await db.query<{ id: string }>(
        'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
        [`${PREFIX}-keyed-${Math.random().toString(36).slice(2)}`, hashToken(key)],
      );
      keyedVenue = trustedUuid(row.rows[0]!.id);
    });

    const authed = (url: string, init: RequestInit = {}): Request =>
      new Request(url, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });

    it('requires a reason to suspend', async () => {
      const response = await suspendRoute.POST(
        authed(`https://x.test/a/${keyedVenue}/suspend`, { method: 'POST', body: JSON.stringify({}) }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );
      expect(response.status).toBe(400);
    }, 30_000);

    it('suspends, reports state, and resumes', async () => {
      const suspended = await suspendRoute.POST(
        authed(`https://x.test/a/${keyedVenue}/suspend`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'testing' }),
        }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );
      expect(suspended.status).toBe(200);
      expect((await suspended.json()) as { suspended: boolean }).toMatchObject({ suspended: true });

      const state = await suspendRoute.GET(authed(`https://x.test/a/${keyedVenue}/suspend`), {
        params: Promise.resolve({ venueId: keyedVenue }),
      });
      expect((await state.json()) as { reason: string }).toMatchObject({ reason: 'testing' });

      const resumed = await suspendRoute.DELETE(
        authed(`https://x.test/a/${keyedVenue}/suspend`, { method: 'DELETE' }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );
      expect((await resumed.json()) as { suspended: boolean }).toMatchObject({ suspended: false });
    }, 30_000);

    it('refuses an unauthenticated suspend', async () => {
      const response = await suspendRoute.POST(
        new Request(`https://x.test/a/${keyedVenue}/suspend`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'nope' }),
        }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );
      expect(response.status).toBe(401);
    }, 30_000);

    it('refuses to suspend another venue with a valid key', async () => {
      const response = await suspendRoute.POST(
        authed(`https://x.test/a/${venueId}/suspend`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'not mine' }),
        }),
        { params: Promise.resolve({ venueId }) },
      );
      expect(response.status).toBe(403);
      expect((await ops.getVenueState(venueId)).suspended).toBe(false);
    }, 30_000);

    it('rejects a malformed pick id', async () => {
      const response = await pickRoute.GET(authed(`https://x.test/a/${keyedVenue}/picks/nope`), {
        params: Promise.resolve({ venueId: keyedVenue, pickId: 'nope' }),
      });
      expect(response.status).toBe(400);
    }, 30_000);

    it('requires a reason to void, and voids with one', async () => {
      const game = await seedGame(keyedVenue, `${PREFIX}-rt`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(keyedVenue, 'RouteVoid');
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home') RETURNING id`,
        [keyedVenue, game, player],
      );
      const pickId = trustedUuid(inserted.rows[0]!.id);
      await gradeOne(keyedVenue, game, `${PREFIX}-rt`, 'home');

      const missingReason = await pickRoute.DELETE(
        authed(`https://x.test/a/${keyedVenue}/picks/${pickId}`, { method: 'DELETE', body: '{}' }),
        { params: Promise.resolve({ venueId: keyedVenue, pickId }) },
      );
      expect(missingReason.status).toBe(400);

      const voided = await pickRoute.DELETE(
        authed(`https://x.test/a/${keyedVenue}/picks/${pickId}`, {
          method: 'DELETE',
          body: JSON.stringify({ reason: 'wrong fixture' }),
        }),
        { params: Promise.resolve({ venueId: keyedVenue, pickId }) },
      );
      expect(voided.status).toBe(200);
      expect((await voided.json()) as { state: string }).toMatchObject({ state: 'voided' });
    }, 30_000);

    it('requires playerSessionId to reconcile', async () => {
      const response = await reconcileRoute.POST(
        authed(`https://x.test/a/${keyedVenue}/reconcile`, { method: 'POST', body: JSON.stringify({}) }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );
      expect(response.status).toBe(400);
    }, 30_000);

    it('validates the supplied result before it can reach the database', async () => {
      // The CHECK that a settled game must have a winner would turn each of
      // these into a constraint violation and a 500. The operator gets a
      // sentence naming the field instead.
      const gradeRoute = await import(
        '../src/app/api/admin/venues/[venueId]/games/[gameId]/grade/route'
      );
      const game = await seedGame(keyedVenue, `${PREFIX}-rv`, `NOW() - INTERVAL '3 hours'`);

      const send = (body: unknown): Promise<Response> =>
        gradeRoute.POST(
          authed(`https://x.test/a/${keyedVenue}/games/${game}/grade`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ venueId: keyedVenue, gameId: game }) },
        );

      // Missing reason.
      expect((await send({ status: 'final', winner: 'home' })).status).toBe(400);
      // Unknown status.
      expect((await send({ status: 'abandoned', reason: 'x' })).status).toBe(400);
      // Final with no winner.
      expect((await send({ status: 'final', reason: 'x' })).status).toBe(400);
      // Winner outside the whitelist.
      expect((await send({ status: 'final', winner: 'both', reason: 'x' })).status).toBe(400);
      // Non-integer and negative scores.
      expect(
        (await send({ status: 'final', winner: 'home', homeScore: 1.5, reason: 'x' })).status,
      ).toBe(400);
      expect(
        (await send({ status: 'final', winner: 'home', homeScore: -1, reason: 'x' })).status,
      ).toBe(400);
    }, 30_000);

    it('settles a game over HTTP and reports what it scored', async () => {
      const gradeRoute = await import(
        '../src/app/api/admin/venues/[venueId]/games/[gameId]/grade/route'
      );
      const game = await seedGame(keyedVenue, `${PREFIX}-rg`, `NOW() - INTERVAL '3 hours'`);
      const player = await seedPlayer(keyedVenue, 'RouteGraded');
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home')`,
        [keyedVenue, game, player],
      );

      const response = await gradeRoute.POST(
        authed(`https://x.test/a/${keyedVenue}/games/${game}/grade`, {
          method: 'POST',
          body: JSON.stringify({
            status: 'final',
            winner: 'home',
            homeScore: 21,
            awayScore: 7,
            reason: 'provider never reported',
          }),
        }),
        { params: Promise.resolve({ venueId: keyedVenue, gameId: game }) },
      );

      expect(response.status).toBe(200);
      expect((await response.json()) as { picksGraded: number }).toMatchObject({
        gamesGraded: 1,
        picksGraded: 1,
        alreadyGraded: false,
      });
    }, 30_000);

    it('refuses to settle a game at another venue', async () => {
      const gradeRoute = await import(
        '../src/app/api/admin/venues/[venueId]/games/[gameId]/grade/route'
      );
      const game = await seedGame(venueId, `${PREFIX}-rx`, `NOW() - INTERVAL '3 hours'`);

      const response = await gradeRoute.POST(
        authed(`https://x.test/a/${venueId}/games/${game}/grade`, {
          method: 'POST',
          body: JSON.stringify({ status: 'final', winner: 'home', reason: 'not mine' }),
        }),
        { params: Promise.resolve({ venueId, gameId: game }) },
      );
      expect(response.status).toBe(403);
    }, 30_000);

    it('returns the audit trail of what an operator did', async () => {
      await suspendRoute.POST(
        authed(`https://x.test/a/${keyedVenue}/suspend`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'audited' }),
        }),
        { params: Promise.resolve({ venueId: keyedVenue }) },
      );

      const response = await auditRoute.GET(authed(`https://x.test/a/${keyedVenue}/audit-log?limit=10`), {
        params: Promise.resolve({ venueId: keyedVenue }),
      });
      expect(response.status).toBe(200);

      const entries = (await response.json()) as { action: string }[];
      expect(entries.some((e) => e.action === 'venue.suspended')).toBe(true);
    }, 30_000);
  });

  describe('pick inspection', () => {
    it('names the pick state in words', async () => {
      const game = await seedGame(venueId, `${PREFIX}-i1`, `NOW() - INTERVAL '2 hours'`);
      const player = await seedPlayer(venueId, 'Inspected');
      const row = await db.query<{ id: string }>(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home') RETURNING id`,
        [venueId, game, player],
      );
      const pickId = trustedUuid(row.rows[0]!.id);

      expect((await ops.inspectPick(pickId, venueId)).pick.state).toBe('ungraded');

      await gradeOne(venueId, game, `${PREFIX}-i1`, 'home');
      const graded = await ops.inspectPick(pickId, venueId);
      expect(graded.pick.state).toBe('graded');
      expect(graded.pick.points).toBe(10);
      expect(graded.player.nickname).toBe('Inspected');
      expect(graded.game.winner).toBe('home');

      await ops.voidPick(pickId, { logger: silent });
      expect((await ops.inspectPick(pickId, venueId)).pick.state).toBe('voided');
    }, 30_000);

    it('refuses to show a pick from another venue', async () => {
      const game = await seedGame(otherVenueId, `${PREFIX}-i2`, `NOW() + INTERVAL '1 hour'`);
      const player = await seedPlayer(otherVenueId, 'Foreign');
      const row = await db.query<{ id: string }>(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'home') RETURNING id`,
        [otherVenueId, game, player],
      );

      await expect(
        ops.inspectPick(trustedUuid(row.rows[0]!.id), venueId),
      ).rejects.toMatchObject({ status: 404 });
    }, 30_000);
  });
});
