import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import type { League } from '../lib/leagues';
import { trustedUuid, type UUID } from '../lib/validators';

export interface AdminServiceDeps {
  db: SqlExecutor;
}

function resolveDeps(deps?: Partial<AdminServiceDeps>): AdminServiceDeps {
  return { db: deps?.db ?? defaultSql };
}

// ---------------------------------------------------------------------------
// Venue configuration
// ---------------------------------------------------------------------------

export interface VenueConfig {
  venueId: UUID;
  enabledLeagues: League[];
  /** IANA zone defining this venue's day. Defaults to UTC. */
  timezone: string;
}

/**
 * Sets the venue's timezone.
 *
 * Kept separate from the league config because it is set once when a venue is
 * onboarded and then never touched, whereas leagues change with the seasons.
 * Bundling them would mean every league edit had to resend a timezone, and a
 * client that forgot would silently move the venue to UTC.
 *
 * The zone is validated by PostgreSQL's own database via the CHECK constraint,
 * so an unknown name is a clean 400 rather than a query that throws on every
 * subsequent read.
 */
export async function setVenueTimezone(
  venueId: UUID,
  timezone: string,
  deps?: Partial<AdminServiceDeps>,
): Promise<VenueConfig> {
  const { db } = resolveDeps(deps);

  try {
    const result = await db.query<{ id: string }>(
      `UPDATE venues SET timezone = $2::text, updated_at = NOW()
        WHERE id = $1::uuid RETURNING id`,
      [venueId, timezone],
    );
    if (result.rows[0] === undefined) {
      throw ApiError.notFound('Venue not found');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // The CHECK rejects anything the server's zone database does not know.
    throw ApiError.badRequest(
      `Unknown timezone. Use an IANA name such as America/New_York.`,
      { field: 'timezone' },
    );
  }

  return getVenueConfig(venueId, deps);
}

/**
 * Replaces the venue's enabled leagues.
 *
 * Scoped by id in the UPDATE itself rather than checked first, so a venue
 * deleted between the auth check and the write produces a clean 404 instead of
 * a silent no-op that reports success.
 */
export async function setVenueConfig(
  venueId: UUID,
  enabledLeagues: League[],
  deps?: Partial<AdminServiceDeps>,
): Promise<VenueConfig> {
  const { db } = resolveDeps(deps);

  const result = await db.query<{ id: string; enabled_leagues: unknown; timezone: string }>(
    `UPDATE venues
        SET enabled_leagues = $2::jsonb
      WHERE id = $1::uuid
      RETURNING id, enabled_leagues, timezone`,
    [venueId, JSON.stringify(enabledLeagues)],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  return {
    venueId: trustedUuid(row.id),
    enabledLeagues: (row.enabled_leagues as League[] | null) ?? [],
    timezone: row.timezone,
  };
}

export interface VenueSummary {
  venueId: UUID;
  name: string;
  enabledLeagues: League[];
}

/**
 * Who does this API key belong to?
 *
 * The key authenticates a venue, so an admin holding one has no other way to
 * learn which venue it is. Without this, a console would have to ask for the
 * venue UUID *and* the key at sign-in and hope they match — and the venue name
 * (which the dashboard header shows) was not reachable at all.
 */
export async function getVenueSummary(
  venueId: UUID,
  deps?: Partial<AdminServiceDeps>,
): Promise<VenueSummary> {
  const { db } = resolveDeps(deps);
  const result = await db.query<{ id: string; name: string; enabled_leagues: unknown }>(
    'SELECT id, name, enabled_leagues FROM venues WHERE id = $1::uuid',
    [venueId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  return {
    venueId: trustedUuid(row.id),
    name: row.name,
    enabledLeagues: (row.enabled_leagues as League[] | null) ?? [],
  };
}

export async function getVenueConfig(
  venueId: UUID,
  deps?: Partial<AdminServiceDeps>,
): Promise<VenueConfig> {
  const { db } = resolveDeps(deps);
  const result = await db.query<{ id: string; enabled_leagues: unknown; timezone: string }>(
    'SELECT id, enabled_leagues, timezone FROM venues WHERE id = $1::uuid',
    [venueId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  return {
    venueId: trustedUuid(row.id),
    enabledLeagues: (row.enabled_leagues as League[] | null) ?? [],
    timezone: row.timezone,
  };
}

// ---------------------------------------------------------------------------
// Player list
// ---------------------------------------------------------------------------

export const PLAYER_LIMIT_DEFAULT = 50;
export const PLAYER_LIMIT_MAX = 200;

export interface AdminPlayer {
  playerId: UUID;
  nickname: string;
  createdAt: string;
  lastSeenAt: string;
  totalPicks: number;
  totalPoints: number;
}

/**
 * One page of players with their pick totals.
 *
 * The totals come from `picks`, not from leaderboard_snapshot. A snapshot is
 * scoped to a period and only exists once the materialisation worker has run,
 * so joining it would report 0 for every player at a venue whose leaderboard
 * has not been built yet, and would silently mean "today" rather than "ever".
 *
 * LEFT JOIN LATERAL rather than a GROUP BY over the whole table: the aggregate
 * runs once per row on the page, so the cost tracks the page size instead of
 * the venue's entire pick history.
 *
 * Expired sessions are included on purpose -- an operator asking "where did
 * that player go" needs to see them.
 */
const LIST_PLAYERS_SQL = `
SELECT ps.id,
       ps.nickname,
       ps.created_at,
       ps.last_seen_at,
       COALESCE(agg.total_picks, 0)  AS total_picks,
       COALESCE(agg.total_points, 0) AS total_points
  FROM player_sessions ps
  LEFT JOIN LATERAL (
    SELECT count(*)::int              AS total_picks,
           COALESCE(SUM(p.points), 0)::int AS total_points
      FROM picks p
     WHERE p.player_session_id = ps.id
       AND p.venue_id = ps.venue_id
  ) agg ON TRUE
 WHERE ps.venue_id = $1::uuid
 ORDER BY ps.last_seen_at DESC, ps.id ASC
 LIMIT $2::int OFFSET $3::int
`;

export async function listPlayers(
  venueId: UUID,
  limit: number,
  offset: number,
  deps?: Partial<AdminServiceDeps>,
): Promise<AdminPlayer[]> {
  const { db } = resolveDeps(deps);

  const result = await db.query<{
    id: string;
    nickname: string;
    created_at: Date;
    last_seen_at: Date;
    total_picks: number;
    total_points: number;
  }>(LIST_PLAYERS_SQL, [venueId, limit, offset]);

  return result.rows.map((row) => ({
    playerId: trustedUuid(row.id),
    nickname: row.nickname,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    totalPicks: row.total_picks,
    totalPoints: row.total_points,
  }));
}

// ---------------------------------------------------------------------------
// Picks inspector
// ---------------------------------------------------------------------------

export const PICK_INSPECTOR_LIMIT = 1000;

export const PICK_STATUSES = ['pending', 'graded', 'voided', 'all'] as const;
export type PickStatusFilter = (typeof PICK_STATUSES)[number];

export interface AdminPick {
  pickId: UUID;
  gameId: UUID;
  playerId: UUID;
  nickname: string;
  predictedWinner: string;
  correct: boolean | null;
  points: number | null;
  submittedAt: string;
  gradedAt: string | null;
}

export interface PickFilters {
  gameId?: UUID;
  playerId?: UUID;
  status?: PickStatusFilter;
}

/**
 * Picks with their player, for debugging grading.
 *
 * The status filter keys off graded_at, not `points IS NULL` as originally
 * specified. Since cancelled games settle a pick by setting graded_at while
 * leaving correct and points NULL, a points-based filter reports every voided
 * pick as "pending" -- so an operator investigating "why is this game stuck"
 * would be shown a pile of picks that are, in fact, finished. That is precisely
 * the misreading this endpoint exists to prevent, hence the extra 'voided'
 * status.
 *
 *   pending  graded_at IS NULL
 *   graded   graded_at IS NOT NULL AND correct IS NOT NULL
 *   voided   graded_at IS NOT NULL AND correct IS NULL
 */
function statusPredicate(status: PickStatusFilter | undefined): string {
  switch (status) {
    case 'pending':
      return 'AND p.graded_at IS NULL';
    case 'graded':
      return 'AND p.graded_at IS NOT NULL AND p.correct IS NOT NULL';
    case 'voided':
      return 'AND p.graded_at IS NOT NULL AND p.correct IS NULL';
    default:
      return '';
  }
}

export async function listPicks(
  venueId: UUID,
  filters: PickFilters,
  deps?: Partial<AdminServiceDeps>,
): Promise<AdminPick[]> {
  const { db } = resolveDeps(deps);

  // The optional filters are bound parameters with a NULL sentinel rather than
  // concatenated SQL. Only the status predicate varies the statement text, and
  // it is chosen from a closed set above -- no caller-supplied string ever
  // reaches the query.
  const text = `
    SELECT p.id,
           p.game_id,
           p.player_session_id,
           ps.nickname,
           p.predicted_winner,
           p.correct,
           p.points,
           p.submitted_at,
           p.graded_at
      FROM picks p
      JOIN player_sessions ps
        ON ps.id = p.player_session_id
       AND ps.venue_id = p.venue_id
     WHERE p.venue_id = $1::uuid
       AND ($2::uuid IS NULL OR p.game_id = $2::uuid)
       AND ($3::uuid IS NULL OR p.player_session_id = $3::uuid)
       ${statusPredicate(filters.status)}
     ORDER BY p.submitted_at DESC, p.id ASC
     LIMIT $4::int
  `;

  const result = await db.query<{
    id: string;
    game_id: string;
    player_session_id: string;
    nickname: string;
    predicted_winner: string;
    correct: boolean | null;
    points: number | null;
    submitted_at: Date;
    graded_at: Date | null;
  }>(text, [
    venueId,
    filters.gameId ?? null,
    filters.playerId ?? null,
    PICK_INSPECTOR_LIMIT,
  ]);

  return result.rows.map((row) => ({
    pickId: trustedUuid(row.id),
    gameId: trustedUuid(row.game_id),
    playerId: trustedUuid(row.player_session_id),
    nickname: row.nickname,
    predictedWinner: row.predicted_winner,
    correct: row.correct,
    points: row.points,
    submittedAt: row.submitted_at.toISOString(),
    gradedAt: row.graded_at?.toISOString() ?? null,
  }));
}
