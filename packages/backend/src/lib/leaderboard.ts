import type { SqlExecutor } from './db';
import { sql as defaultSql, withTransaction as defaultWithTransaction } from './db';
import { ApiError } from './errors';
import { trustedUuid, type UUID } from './validators';

/**
 * Leaderboard computation.
 *
 * Two vocabularies meet here, and this module is the only place they do:
 *  - the API speaks in user-facing windows: today / this_week / all_time
 *  - leaderboard_snapshot.period is constrained to daily / weekly / monthly /
 *    all_time
 * PERIOD_TO_SNAPSHOT is the single mapping between them. Storing "today" would
 * violate the CHECK constraint; renaming the column's vocabulary would break
 * the existing index and comments for no gain.
 */

export const LEADERBOARD_PERIODS = ['today', 'this_week', 'all_time'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

/** API period -> the value stored in leaderboard_snapshot.period. */
export const PERIOD_TO_SNAPSHOT: Readonly<Record<LeaderboardPeriod, string>> = {
  today: 'daily',
  this_week: 'weekly',
  all_time: 'all_time',
};

export interface LeaderboardEntry {
  readonly rank: number;
  readonly playerSessionId: string | null;
  readonly nickname: string;
  readonly wins: number;
  readonly losses: number;
  readonly points: number;
}

export interface LeaderboardDeps {
  db: SqlExecutor;
  /**
   * Used only by computeLeaderboard, which must hold a lock across two
   * statements and therefore cannot run on a bare pool executor: `db.query`
   * may hand each statement a different connection.
   */
  withTransaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
}

export function isLeaderboardPeriod(value: unknown): value is LeaderboardPeriod {
  return typeof value === 'string' && (LEADERBOARD_PERIODS as readonly string[]).includes(value);
}

export function validatePeriod(value: unknown): LeaderboardPeriod {
  if (value === undefined || value === null || value === '') {
    return 'today';
  }
  if (!isLeaderboardPeriod(value)) {
    throw ApiError.badRequest(`period must be one of: ${LEADERBOARD_PERIODS.join(', ')}`, {
      field: 'period',
    });
  }
  return value;
}

/**
 * Computes standings and replaces the stored snapshot in one statement.
 *
 * Everything happens server-side:
 *  - `standings` aggregates settled picks for the venue inside the window.
 *  - `ranked` numbers them.
 *  - `wiped` clears the previous snapshot. A data-modifying CTE always runs to
 *    completion regardless of whether the primary query reads it, and it sees
 *    the same table snapshot as the INSERT, so it cannot delete the new rows.
 *  - the INSERT writes the fresh snapshot and returns it.
 *
 * Being one statement makes replace-and-return atomic without an explicit
 * transaction: a concurrent reader sees either the old snapshot or the new one,
 * never an empty table mid-swap.
 *
 * The window boundary is computed with the database's clock via date_trunc, so
 * no client timestamp is trusted here either.
 *
 * Windows are computed in the venue's own timezone. They used to run in the
 * database's, which is UTC: a bar closing at 01:00 local saw its evening split
 * across two "today" boards, and an American venue rolled over at 8pm local —
 * mid-service. venues.timezone now carries the zone and defaults to UTC, so a
 * venue that never sets one behaves exactly as before.
 */
const COMPUTE_AND_REPLACE_SQL = `
WITH venue_tz AS (
  SELECT timezone FROM venues WHERE id = $1::uuid
),
window_start AS (
  SELECT CASE $2::text
           WHEN 'today'
             THEN date_trunc('day', NOW() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone
           WHEN 'this_week'
             THEN date_trunc('week', NOW() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone
           ELSE NULL
         END AS starts_at
    FROM venue_tz t
),
standings AS (
  SELECT p.player_session_id,
         ps.nickname,
         COALESCE(SUM(p.points), 0)::int              AS points,
         COUNT(*) FILTER (WHERE p.correct)::int       AS wins,
         COUNT(*) FILTER (WHERE NOT p.correct)::int   AS losses,
         MIN(p.submitted_at)                          AS first_pick_at
    FROM picks p
    JOIN player_sessions ps
      ON ps.id = p.player_session_id
     AND ps.venue_id = p.venue_id
   CROSS JOIN window_start w
   WHERE p.venue_id = $1::uuid
     AND p.correct IS NOT NULL
     AND (w.starts_at IS NULL OR p.created_at >= w.starts_at)
   GROUP BY p.player_session_id, ps.nickname
),
ranked AS (
  SELECT s.*,
         ROW_NUMBER() OVER (
           ORDER BY s.points DESC,
                    s.wins DESC,
                    s.first_pick_at ASC,
                    s.player_session_id ASC
         )::int AS rank
    FROM standings s
),
wiped AS (
  DELETE FROM leaderboard_snapshot
   WHERE venue_id = $1::uuid
     AND period = $3::text
)
INSERT INTO leaderboard_snapshot (
  venue_id, period, player_session_id, nickname, wins, losses, points, rank, computed_at
)
SELECT $1::uuid, $3::text, r.player_session_id, r.nickname, r.wins, r.losses, r.points, r.rank, NOW()
  FROM ranked r
RETURNING rank, player_session_id, nickname, wins, losses, points
`;

interface SnapshotRow {
  rank: number;
  player_session_id: string | null;
  nickname: string;
  wins: number;
  losses: number;
  points: number;
}

function toEntry(row: SnapshotRow): LeaderboardEntry {
  return {
    rank: row.rank,
    playerSessionId: row.player_session_id,
    nickname: row.nickname,
    wins: row.wins,
    losses: row.losses,
    points: row.points,
  };
}

/**
 * Recomputes the leaderboard for one venue and window, replaces the stored
 * snapshot, and returns the standings in rank order.
 *
 * Voided picks (cancelled games) carry correct IS NULL and are excluded, so a
 * cancelled game counts as neither a win nor a loss for anybody.
 */
export async function computeLeaderboard(
  venueId: UUID,
  period: LeaderboardPeriod,
  deps?: Partial<LeaderboardDeps>,
): Promise<LeaderboardEntry[]> {
  const runInTransaction = deps?.withTransaction ?? defaultWithTransaction;
  const snapshotPeriod = PERIOD_TO_SNAPSHOT[period];

  /*
   * The advisory lock serialises materialisation per venue and period, and it
   * is not defensive programming — without it two instances duplicate the
   * board, measured: ten players became twenty rows, every rank twice.
   *
   * The statement below wipes and rebuilds in one shot, which looks atomic and
   * is, in isolation. Under READ COMMITTED it is not enough. Both transactions
   * take their snapshot before either commits, so T2's DELETE cannot see the
   * rows T1 is about to insert: it removes the *old* rows T1 already removed,
   * then inserts a second full copy. Nothing conflicts, nothing errors, and the
   * TV shows everybody twice.
   *
   * The lock has to be acquired before the DELETE, so it cannot live inside
   * that statement — a CTE gives no ordering guarantee against the
   * data-modifying arms. Hence a transaction with the lock as its own first
   * statement, which also means `db` does not apply here: a pool executor may
   * put the two statements on different connections and the lock would be
   * released before the work ran.
   *
   * Contention is per venue and period and the rebuild takes milliseconds, so
   * the second caller waits, re-runs, and produces the same rows. Correct and
   * idempotent rather than merely serialised.
   */
  return runInTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [
      `fanboard:leaderboard:${venueId}:${snapshotPeriod}`,
    ]);

    const result = await tx.query<SnapshotRow>(COMPUTE_AND_REPLACE_SQL, [
      venueId,
      period,
      snapshotPeriod,
    ]);

    // RETURNING follows insertion order, which follows `ranked`, but ordering is
    // not contractual in SQL -- sort so callers can rely on it.
    return result.rows.map(toEntry).sort((a, b) => a.rank - b.rank);
  });
}

const READ_SNAPSHOT_SQL = `
SELECT rank, player_session_id, nickname, wins, losses, points
  FROM leaderboard_snapshot
 WHERE venue_id = $1::uuid
   AND period = $2::text
 ORDER BY rank ASC
`;

/**
 * Reads the stored snapshot without recomputing.
 *
 * Returns [] for a venue whose leaderboard has not been materialised yet, which
 * is an empty board rather than an error.
 */
export async function readLeaderboardSnapshot(
  venueId: UUID,
  period: LeaderboardPeriod,
  deps?: Partial<LeaderboardDeps>,
): Promise<LeaderboardEntry[]> {
  const db = deps?.db ?? defaultSql;
  const result = await db.query<SnapshotRow>(READ_SNAPSHOT_SQL, [
    venueId,
    PERIOD_TO_SNAPSHOT[period],
  ]);
  return result.rows.map(toEntry);
}

/** Ids of every venue, used by the materialisation worker. */
export async function listVenueIds(deps?: Partial<LeaderboardDeps>): Promise<UUID[]> {
  const db = deps?.db ?? defaultSql;
  const result = await db.query<{ id: string }>('SELECT id FROM venues ORDER BY created_at');
  return result.rows.map((row) => trustedUuid(row.id));
}
