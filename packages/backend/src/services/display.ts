import { DISPLAY_TTL_SECONDS, displayKey } from '../lib/cache-keys';
import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { getEnv } from '../lib/env';
import { readLeaderboardSnapshot } from '../lib/leaderboard';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { get as redisGet, set as redisSet } from '../lib/redis';
import type { UUID } from '../lib/validators';

/**
 * Everything the Fire TV renders, in one payload.
 *
 * Deliberately narrow. This is the least-trusted authenticated surface in the
 * system -- the credential lives on a stick plugged into a TV in a public room
 * -- so the response carries only what is already visible to anyone looking at
 * the screen. No api_key, no display_key, no session tokens, no
 * player_session_id, nothing from another venue.
 */
export interface DisplayGame {
  readonly id: string;
  readonly league: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly status: string;
  readonly scheduledAt: string;
  /**
   * In-game progress. Always null today: the games table has no column for it,
   * and TheSportsDB's eventsday.php -- the only endpoint poll-games uses --
   * does not return it. Carried in the shape so the Fire TV client can be
   * written against the final contract. See the README.
   */
  readonly quarter: string | null;
  readonly period: string | null;
  readonly inning: string | null;
  readonly homeLogoUrl: string | null;
  readonly awayLogoUrl: string | null;
}

export interface DisplayLeaderboardEntry {
  readonly rank: number;
  readonly nickname: string;
  readonly wins: number;
  readonly losses: number;
  readonly points: number;
}

export interface DisplayPayload {
  readonly qrCode: string;
  readonly games: DisplayGame[];
  readonly leaderboard: DisplayLeaderboardEntry[];
  readonly refreshedAt: string;
}

export interface DisplayServiceDeps {
  db: SqlExecutor;
  cacheGet: (key: string) => Promise<string | null>;
  cacheSet: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  publicBaseUrl: () => string;
  logger: Logger;
}

function resolveDeps(deps?: Partial<DisplayServiceDeps>): DisplayServiceDeps {
  return {
    db: deps?.db ?? defaultSql,
    cacheGet: deps?.cacheGet ?? redisGet,
    cacheSet: deps?.cacheSet ?? redisSet,
    publicBaseUrl: deps?.publicBaseUrl ?? (() => getEnv().NEXT_PUBLIC_API_URL),
    logger: deps?.logger ?? rootLogger.child({ service: 'display' }),
  };
}

/**
 * Today's fixtures for the venue.
 *
 * Windowed on the database clock rather than the caller's, and bounded: a
 * display can show perhaps a dozen games, and an unbounded list would be a slow
 * query serving pixels nobody sees.
 *
 * Ordering puts live games first, then upcoming, then finished -- the client
 * groups into LIVE / COMING_UP / FINAL and this makes that a single pass.
 */
/**
 * Tonight's card, in the venue's own day.
 *
 * The window is computed in the venue's timezone, not the server's. Those are
 * the same thing only for a venue that happens to sit in UTC; for an American
 * bar the UTC day rolls over at 8pm local, so a 8:10pm kick-off counts as
 * tomorrow and disappears from the list exactly when the room is watching it.
 *
 * The double `AT TIME ZONE` is the usual Postgres dance and reads oddly: the
 * first converts the instant to a local wall clock so the day can be truncated,
 * the second converts that local midnight back to an absolute instant so it can
 * be compared against scheduled_at, which is timestamptz.
 */
const TODAY_GAMES_SQL = `
WITH venue_day AS (
  SELECT date_trunc('day', NOW() AT TIME ZONE v.timezone) AT TIME ZONE v.timezone AS starts_at,
         v.timezone
    FROM venues v
   WHERE v.id = $1::uuid
)
SELECT g.id, g.league, g.home_team, g.away_team, g.home_score, g.away_score,
       g.status, g.scheduled_at, g.home_logo_url, g.away_logo_url
  FROM games g
 CROSS JOIN venue_day d
 WHERE g.venue_id = $1::uuid
   AND g.scheduled_at >= d.starts_at
   AND g.scheduled_at <  d.starts_at + INTERVAL '1 day'
 ORDER BY CASE status
            WHEN 'live'      THEN 0
            WHEN 'scheduled' THEN 1
            ELSE 2
          END,
          scheduled_at ASC
 LIMIT $2::int
`;

export const MAX_DISPLAY_GAMES = 50;

interface GameRow {
  id: string;
  league: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  scheduled_at: Date;
  home_logo_url: string | null;
  away_logo_url: string | null;
}

function toDisplayGame(row: GameRow): DisplayGame {
  return {
    id: row.id,
    league: row.league,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    homeScore: row.home_score,
    awayScore: row.away_score,
    status: row.status,
    scheduledAt: row.scheduled_at.toISOString(),
    quarter: null,
    period: null,
    inning: null,
    homeLogoUrl: row.home_logo_url,
    awayLogoUrl: row.away_logo_url,
  };
}

/** The patron-facing join URL the TV renders as a QR code. */
export function buildQrCode(baseUrl: string, venueId: UUID): string {
  return `${baseUrl.replace(/\/+$/, '')}/v/${venueId}`;
}

/**
 * Builds the display payload, Redis-first.
 *
 * The cache is keyed per device and lives for 10 seconds, matching the client's
 * poll interval: a venue with eight displays costs the database roughly one
 * read per 10 seconds rather than eight.
 */
export async function getDisplayPayload(
  deviceId: UUID,
  venueId: UUID,
  deps?: Partial<DisplayServiceDeps>,
): Promise<{ payload: DisplayPayload; cached: boolean }> {
  const resolved = resolveDeps(deps);
  const key = displayKey(deviceId);

  const cached = await readCache(key, resolved);
  if (cached !== null) {
    return { payload: cached, cached: true };
  }

  const payload = await buildDisplayPayload(venueId, resolved);

  try {
    await resolved.cacheSet(key, JSON.stringify(payload), DISPLAY_TTL_SECONDS);
  } catch (error) {
    // A cache outage costs latency, not correctness.
    resolved.logger.warn('display cache write failed', { deviceId, error });
  }

  return { payload, cached: false };
}

async function readCache(
  key: string,
  deps: DisplayServiceDeps,
): Promise<DisplayPayload | null> {
  try {
    const raw = await deps.cacheGet(key);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || !('games' in parsed)) {
      return null;
    }
    return parsed as DisplayPayload;
  } catch (error) {
    deps.logger.warn('display cache read failed; falling through', { key, error });
    return null;
  }
}

export async function buildDisplayPayload(
  venueId: UUID,
  deps?: Partial<DisplayServiceDeps>,
): Promise<DisplayPayload> {
  const { db, publicBaseUrl } = resolveDeps(deps);

  // Two independent reads, issued together rather than in sequence. Both are
  // venue-scoped; the leaderboard comes from the materialised snapshot rather
  // than an aggregate, so neither touches the picks table.
  const [games, leaderboard] = await Promise.all([
    db.query<GameRow>(TODAY_GAMES_SQL, [venueId, MAX_DISPLAY_GAMES]),
    readLeaderboardSnapshot(venueId, 'today', { db }),
  ]);

  return {
    qrCode: buildQrCode(publicBaseUrl(), venueId),
    games: games.rows.map(toDisplayGame),
    // playerSessionId is dropped here: it is a tenant-internal identifier and
    // this payload is rendered on a screen in a public room.
    leaderboard: leaderboard.map((entry) => ({
      rank: entry.rank,
      nickname: entry.nickname,
      wins: entry.wins,
      losses: entry.losses,
      points: entry.points,
    })),
    refreshedAt: new Date().toISOString(),
  };
}
