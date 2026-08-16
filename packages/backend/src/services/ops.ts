import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import { computeLeaderboard, LEADERBOARD_PERIODS, type LeaderboardPeriod } from '../lib/leaderboard';
import { logger as rootLogger, type Logger } from '../lib/logger';
import type { UUID } from '../lib/validators';

/**
 * Operator tools for when something has gone wrong in a live venue.
 *
 * The design constraint throughout: every one of these runs at 11pm on a
 * Saturday, by someone who did not write the system, while a room full of
 * people watches a TV. So each is a single statement where it can be,
 * idempotent where repeating is plausible, and reports what it actually did
 * rather than assuming it worked.
 *
 * None of them delete anything. Suspension is reversible, voiding is a state
 * change the schema already models, and reconciliation only rebuilds a derived
 * table. There is deliberately no "reset venue" here — that is what a restore
 * from backup is for, and it should be slow and deliberate.
 */

export interface OpsDeps {
  db: SqlExecutor;
  logger: Logger;
}

function resolveDeps(deps?: Partial<OpsDeps>): OpsDeps {
  return {
    db: deps?.db ?? defaultSql,
    logger: deps?.logger ?? rootLogger.child({ service: 'ops' }),
  };
}

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

export interface VenueState {
  readonly venueId: UUID;
  readonly suspended: boolean;
  readonly reason: string | null;
  readonly since: string | null;
}

/**
 * Stops a venue taking new picks. Existing picks still grade.
 *
 * Idempotent: suspending an already-suspended venue updates the reason rather
 * than failing, because the person doing it under pressure should not have to
 * remember whether the first attempt landed.
 */
export async function suspendVenue(
  venueId: UUID,
  reason: string,
  deps?: Partial<OpsDeps>,
): Promise<VenueState> {
  const { db, logger } = resolveDeps(deps);

  const result = await db.query<{ suspended_at: Date; suspended_reason: string }>(
    `UPDATE venues
        SET suspended_at     = COALESCE(suspended_at, NOW()),
            suspended_reason = $2::text,
            updated_at       = NOW()
      WHERE id = $1::uuid
    RETURNING suspended_at, suspended_reason`,
    [venueId, reason],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  logger.warn('venue_suspended', {
    venue_id: venueId,
    reason,
    suspended_at: row.suspended_at.toISOString(),
  });

  return {
    venueId,
    suspended: true,
    reason: row.suspended_reason,
    since: row.suspended_at.toISOString(),
  };
}

export async function resumeVenue(venueId: UUID, deps?: Partial<OpsDeps>): Promise<VenueState> {
  const { db, logger } = resolveDeps(deps);

  const result = await db.query<{ was_suspended: boolean }>(
    `WITH before AS (
       SELECT id, (suspended_at IS NOT NULL) AS was_suspended
         FROM venues WHERE id = $1::uuid
     )
     UPDATE venues v
        SET suspended_at = NULL, suspended_reason = NULL, updated_at = NOW()
       FROM before
      WHERE v.id = before.id
     RETURNING before.was_suspended`,
    [venueId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  logger.warn('venue_resumed', { venue_id: venueId, was_suspended: row.was_suspended });
  return { venueId, suspended: false, reason: null, since: null };
}

export async function getVenueState(
  venueId: UUID,
  deps?: Partial<OpsDeps>,
): Promise<VenueState> {
  const { db } = resolveDeps(deps);
  const result = await db.query<{ suspended_at: Date | null; suspended_reason: string | null }>(
    'SELECT suspended_at, suspended_reason FROM venues WHERE id = $1::uuid',
    [venueId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }
  return {
    venueId,
    suspended: row.suspended_at !== null,
    reason: row.suspended_reason,
    since: row.suspended_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Voiding a pick
// ---------------------------------------------------------------------------

export interface VoidResult {
  readonly pickId: UUID;
  readonly venueId: UUID;
  readonly playerSessionId: UUID;
  readonly alreadyVoid: boolean;
}

/**
 * Voids one pick: finished with, but neither a win nor a loss.
 *
 * This uses the schema's existing `voided` state — graded_at set, correct and
 * points NULL — rather than writing points = 0. The brief asked for zero
 * points, but that is a different outcome: zero is a *loss* on the board, and
 * the CHECK constraint rejects it besides, since correct and points must be
 * null together. Voiding removes the pick from the standings entirely, which is
 * what "this pick should not have counted" means.
 *
 * Idempotent: voiding a voided pick reports alreadyVoid and changes nothing.
 */
export async function voidPick(
  pickId: UUID,
  deps?: Partial<OpsDeps>,
): Promise<VoidResult> {
  const { db, logger } = resolveDeps(deps);

  const result = await db.query<{
    venue_id: string;
    player_session_id: string;
    already_void: boolean;
  }>(
    `WITH before AS (
       SELECT id, venue_id, player_session_id,
              (graded_at IS NOT NULL AND correct IS NULL) AS already_void
         FROM picks WHERE id = $1::uuid
     )
     UPDATE picks p
        SET correct   = NULL,
            points    = NULL,
            graded_at = NOW()
       FROM before
      WHERE p.id = before.id
     RETURNING before.venue_id, before.player_session_id, before.already_void`,
    [pickId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Pick not found');
  }

  logger.warn('pick_voided', {
    pick_id: pickId,
    venue_id: row.venue_id,
    player_session_id: row.player_session_id,
    already_void: row.already_void,
  });

  return {
    pickId,
    venueId: row.venue_id as UUID,
    playerSessionId: row.player_session_id as UUID,
    alreadyVoid: row.already_void,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface Reconciliation {
  readonly venueId: UUID;
  readonly playerSessionId: UUID;
  readonly period: LeaderboardPeriod;
  /** Counted from the picks themselves. */
  readonly truth: { picks: number; wins: number; losses: number; points: number };
  /** What the materialised board says, or null if the player is absent from it. */
  readonly snapshot: { rank: number; wins: number; losses: number; points: number } | null;
  readonly mismatch: boolean;
  readonly repaired: boolean;
}

const TRUTH_SQL = `
SELECT count(*)                                        AS picks,
       count(*) FILTER (WHERE correct IS TRUE)         AS wins,
       count(*) FILTER (WHERE correct IS FALSE)        AS losses,
       COALESCE(sum(points), 0)                        AS points
  FROM picks
 WHERE venue_id = $1::uuid
   AND player_session_id = $2::uuid
   AND graded_at IS NOT NULL
`;

const SNAPSHOT_SQL = `
SELECT rank, wins, losses, points
  FROM leaderboard_snapshot
 WHERE venue_id = $1::uuid
   AND player_session_id = $2::uuid
   AND period = $3::text
`;

/**
 * Answers "does this player's board entry match their picks?" and repairs it if
 * not.
 *
 * The truth side counts the picks directly rather than reusing the leaderboard
 * query, which is the whole point: comparing a derived value against itself
 * proves nothing. If they disagree the board is rematerialised and re-read, so
 * the response says whether the repair worked rather than that it was attempted.
 *
 * Only `all_time` is reconciled by default. The windowed periods legitimately
 * differ from a lifetime pick count, so a mismatch there is not evidence of a
 * fault.
 */
export async function reconcilePlayer(
  venueId: UUID,
  playerSessionId: UUID,
  period: LeaderboardPeriod = 'all_time',
  deps?: Partial<OpsDeps>,
): Promise<Reconciliation> {
  const { db, logger } = resolveDeps(deps);

  if (!LEADERBOARD_PERIODS.includes(period)) {
    throw ApiError.badRequest('Unknown leaderboard period');
  }

  const snapshotPeriod = period === 'today' ? 'daily' : period === 'this_week' ? 'weekly' : 'all_time';

  const read = async (): Promise<Reconciliation['snapshot']> => {
    const result = await db.query<{ rank: number; wins: number; losses: number; points: number }>(
      SNAPSHOT_SQL,
      [venueId, playerSessionId, snapshotPeriod],
    );
    return result.rows[0] ?? null;
  };

  const truthRow = await db.query<{ picks: string; wins: string; losses: string; points: string }>(
    TRUTH_SQL,
    [venueId, playerSessionId],
  );
  const t = truthRow.rows[0];
  const truth = {
    picks: Number(t?.picks ?? 0),
    wins: Number(t?.wins ?? 0),
    losses: Number(t?.losses ?? 0),
    points: Number(t?.points ?? 0),
  };

  const before = await read();
  const disagrees = (snapshot: Reconciliation['snapshot']): boolean => {
    if (snapshot === null) {
      // Absent from the board is only wrong if they have graded picks.
      return truth.wins + truth.losses > 0;
    }
    return (
      snapshot.points !== truth.points ||
      snapshot.wins !== truth.wins ||
      snapshot.losses !== truth.losses
    );
  };

  if (!disagrees(before)) {
    return { venueId, playerSessionId, period, truth, snapshot: before, mismatch: false, repaired: false };
  }

  logger.error('leaderboard_mismatch', {
    venue_id: venueId,
    player_session_id: playerSessionId,
    period,
    truth,
    snapshot: before,
  });

  await computeLeaderboard(venueId, period);
  const after = await read();
  const stillWrong = disagrees(after);

  if (stillWrong) {
    // Rematerialising is the fix for a stale board. If it did not help, the
    // disagreement is not staleness and an operator needs to know that rather
    // than be told it was handled.
    logger.error('leaderboard_mismatch_persists_after_recompute', {
      venue_id: venueId,
      player_session_id: playerSessionId,
      period,
      truth,
      snapshot: after,
    });
  }

  return {
    venueId,
    playerSessionId,
    period,
    truth,
    snapshot: after,
    mismatch: true,
    repaired: !stillWrong,
  };
}

// ---------------------------------------------------------------------------
// Manual settlement
// ---------------------------------------------------------------------------

export interface ManualOutcome {
  readonly status: 'final' | 'cancelled';
  /** Required when final; absent when cancelled. */
  readonly winner?: 'home' | 'away' | 'draw';
  readonly homeScore?: number;
  readonly awayScore?: number;
}

export interface ManualGradeResult {
  readonly gameId: UUID;
  readonly gamesGraded: number;
  readonly picksGraded: number;
  readonly gamesVoided: number;
  readonly alreadyGraded: boolean;
}

/**
 * Settles one game from an operator-supplied result.
 *
 * The case this exists for: the provider never reports a game final, so its
 * picks sit ungraded and no amount of waiting helps. Before this, the only
 * remedy was hand-written SQL against production at 11pm.
 *
 * It deliberately does NOT implement scoring. It builds a one-game provider
 * from the supplied outcome and runs the real grading worker against it, so it
 * inherits every invariant that path already has: the single transaction, the
 * `graded_at IS NULL` guard, the bulk pick update, and the CHECK that a graded
 * game must have a winner. A second implementation of scoring is exactly how
 * the manual path and the automatic path come to disagree.
 *
 * Refuses to touch an already-settled game rather than restating history. An
 * operator correcting a *wrong* result voids the picks instead, which is
 * visible in the audit trail; silently rewriting a settled game is not.
 */
export async function gradeGameManually(
  venueId: UUID,
  gameId: UUID,
  outcome: ManualOutcome,
  deps?: Partial<OpsDeps>,
): Promise<ManualGradeResult> {
  const { db, logger } = resolveDeps(deps);

  const found = await db.query<{ external_id: string; scheduled_at: Date; graded_at: Date | null }>(
    'SELECT external_id, scheduled_at, graded_at FROM games WHERE id = $1::uuid AND venue_id = $2::uuid',
    [gameId, venueId],
  );

  const game = found.rows[0];
  if (game === undefined) {
    throw ApiError.notFound('Game not found');
  }

  if (game.graded_at !== null) {
    logger.warn('manual_grade_refused_already_settled', {
      game_id: gameId,
      venue_id: venueId,
      graded_at: game.graded_at.toISOString(),
    });
    return { gameId, gamesGraded: 0, picksGraded: 0, gamesVoided: 0, alreadyGraded: true };
  }

  // Imported here rather than at module scope: the worker pulls in the sports
  // provider and its HTTP client, and nothing else in this file needs them.
  const [{ gradeGamesOnce }, { SportsProvider }] = await Promise.all([
    import('../workers/grade-games'),
    import('../lib/sports-provider'),
  ]);

  const normalized = {
    externalId: game.external_id,
    league: 'MANUAL',
    sport: 'MANUAL',
    homeTeam: '',
    awayTeam: '',
    homeLogoUrl: null,
    awayLogoUrl: null,
    scheduledAt: game.scheduled_at,
    status: outcome.status,
    homeScore: outcome.homeScore ?? null,
    awayScore: outcome.awayScore ?? null,
    winner: outcome.winner ?? null,
  };

  class OperatorProvider extends SportsProvider {
    readonly name = 'operator';
    fetchGames(): Promise<(typeof normalized)[]> {
      return Promise.resolve([normalized]);
    }
  }

  const result = await gradeGamesOnce({
    logger,
    provider: new OperatorProvider() as never,
    // Scoped to this one game: the worker's own candidate query is global, and
    // an operator asking to settle one fixture must not sweep up others.
    listCandidates: async () => [
      { id: gameId, venueId, externalId: game.external_id, scheduledAt: game.scheduled_at },
    ],
  });

  logger.warn('game_graded_manually', {
    game_id: gameId,
    venue_id: venueId,
    outcome,
    games_graded: result.gamesGraded,
    picks_graded: result.picksGraded,
    games_voided: result.gamesVoided,
    errors: result.errors,
  });

  return {
    gameId,
    gamesGraded: result.gamesGraded,
    picksGraded: result.picksGraded,
    gamesVoided: result.gamesVoided,
    alreadyGraded: false,
  };
}

// ---------------------------------------------------------------------------
// Pick inspection
// ---------------------------------------------------------------------------

export interface PickInspection {
  readonly pick: {
    id: UUID;
    gameId: UUID;
    playerSessionId: UUID;
    predictedWinner: string;
    correct: boolean | null;
    points: number | null;
    submittedAt: string;
    gradedAt: string | null;
    state: 'ungraded' | 'graded' | 'voided';
  };
  readonly game: {
    id: UUID;
    league: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string;
    lockedAt: string | null;
    status: string;
    winner: string | null;
    gradedAt: string | null;
    cancelled: boolean;
  };
  readonly player: { sessionId: UUID; nickname: string; totalPoints: number };
}

const INSPECT_SQL = `
SELECT p.id, p.game_id, p.player_session_id, p.predicted_winner, p.correct, p.points,
       p.submitted_at, p.graded_at,
       g.league, g.home_team, g.away_team, g.scheduled_at, g.locked_at,
       g.status, g.winner, g.graded_at AS game_graded_at, g.cancelled,
       s.nickname,
       (SELECT COALESCE(sum(points), 0) FROM picks x
         WHERE x.player_session_id = p.player_session_id) AS total_points
  FROM picks p
  JOIN games g           ON g.id = p.game_id AND g.venue_id = p.venue_id
  JOIN player_sessions s ON s.id = p.player_session_id
 WHERE p.id = $1::uuid
   AND p.venue_id = $2::uuid
`;

/** Everything needed to answer "why does this pick look wrong?" in one query. */
export async function inspectPick(
  pickId: UUID,
  venueId: UUID,
  deps?: Partial<OpsDeps>,
): Promise<PickInspection> {
  const { db } = resolveDeps(deps);

  const result = await db.query<Record<string, never>>(INSPECT_SQL, [pickId, venueId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    // Scoped to the venue, so a wrong-venue pick id is indistinguishable from a
    // nonexistent one. That is the same reasoning the pick path uses.
    throw ApiError.notFound('Pick not found');
  }

  const gradedAt = row['graded_at'] as Date | null;
  const correct = row['correct'] as boolean | null;

  return {
    pick: {
      id: row['id'] as UUID,
      gameId: row['game_id'] as UUID,
      playerSessionId: row['player_session_id'] as UUID,
      predictedWinner: row['predicted_winner'] as string,
      correct,
      points: row['points'] as number | null,
      submittedAt: (row['submitted_at'] as Date).toISOString(),
      gradedAt: gradedAt?.toISOString() ?? null,
      state: gradedAt === null ? 'ungraded' : correct === null ? 'voided' : 'graded',
    },
    game: {
      id: row['game_id'] as UUID,
      league: row['league'] as string,
      homeTeam: row['home_team'] as string,
      awayTeam: row['away_team'] as string,
      scheduledAt: (row['scheduled_at'] as Date).toISOString(),
      lockedAt: (row['locked_at'] as Date | null)?.toISOString() ?? null,
      status: row['status'] as string,
      winner: row['winner'] as string | null,
      gradedAt: (row['game_graded_at'] as Date | null)?.toISOString() ?? null,
      cancelled: row['cancelled'] as boolean,
    },
    player: {
      sessionId: row['player_session_id'] as UUID,
      nickname: row['nickname'] as string,
      totalPoints: Number(row['total_points']),
    },
  };
}
