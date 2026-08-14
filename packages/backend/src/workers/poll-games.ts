import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../lib/db';
import { withTransaction as defaultWithTransaction, query } from '../lib/db';
import { getEnv } from '../lib/env';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { get as redisGet, set as redisSet } from '../lib/redis';
import {
  toIsoDate,
  type CacheStore,
  type NormalizedGame,
  type SportsProvider,
} from '../lib/sports-provider';
import { TheSportsDBProvider } from '../lib/thesportsdb';

export const POLL_GAMES_WORKER_NAME = 'poll-games';
export const POLL_GAMES_INTERVAL_MS = 30_000;
export const DEFAULT_DAYS_AHEAD = 7;
export const SPORTS_CACHE_TTL_SECONDS = 300;

export interface PollGamesResult {
  readonly runId: string;
  /** Distinct games returned by the provider across the whole window. */
  readonly fetched: number;
  readonly venues: number;
  readonly inserted: number;
  readonly updated: number;
  /** Rows the upsert deliberately left alone (already graded). */
  readonly skipped: number;
  readonly failedVenues: number;
  readonly durationMs: number;
}

export interface PollGamesDeps {
  provider: SportsProvider;
  listVenueIds: () => Promise<string[]>;
  withTransaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
  logger: Logger;
  now: () => Date;
  daysAhead: number;
  leagues?: readonly string[];
}

interface UpsertCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * Set-based upsert: one statement per venue regardless of how many games came
 * back. The per-row alternative issues thousands of round trips per tick once a
 * handful of venues are live.
 *
 * `WHERE games.graded_at IS NULL` protects settled games — once the grading job
 * has scored picks against a result, a late provider correction must not
 * silently rewrite the outcome underneath them. Those rows fall out of
 * RETURNING and are counted as skipped.
 *
 * `xmax = 0` distinguishes a fresh insert from an update. It is a metrics
 * heuristic, not a correctness guarantee.
 */
const UPSERT_GAMES_SQL = `
INSERT INTO games (
  venue_id, external_id, league, sport, home_team, away_team,
  home_logo_url, away_logo_url, scheduled_at, status,
  home_score, away_score, winner, cancelled
)
SELECT
  $1::uuid, g.external_id, g.league, g.sport, g.home_team, g.away_team,
  g.home_logo_url, g.away_logo_url, g.scheduled_at, g.status,
  g.home_score, g.away_score, g.winner, g.cancelled
FROM UNNEST(
  $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
  $7::text[], $8::text[], $9::timestamptz[], $10::text[],
  $11::int[], $12::int[], $13::text[], $14::boolean[]
) AS g(
  external_id, league, sport, home_team, away_team,
  home_logo_url, away_logo_url, scheduled_at, status,
  home_score, away_score, winner, cancelled
)
ON CONFLICT (venue_id, external_id) DO UPDATE SET
  league        = EXCLUDED.league,
  sport         = EXCLUDED.sport,
  home_team     = EXCLUDED.home_team,
  away_team     = EXCLUDED.away_team,
  home_logo_url = COALESCE(EXCLUDED.home_logo_url, games.home_logo_url),
  away_logo_url = COALESCE(EXCLUDED.away_logo_url, games.away_logo_url),
  scheduled_at  = EXCLUDED.scheduled_at,
  status        = EXCLUDED.status,
  home_score    = EXCLUDED.home_score,
  away_score    = EXCLUDED.away_score,
  winner        = EXCLUDED.winner,
  cancelled     = EXCLUDED.cancelled
WHERE games.graded_at IS NULL
RETURNING (xmax = 0) AS inserted
`;

/** Redis-backed cache for raw provider responses. */
export function createRedisCacheStore(): CacheStore {
  return {
    get: (key) => redisGet(key),
    set: async (key, value, ttlSeconds) => {
      await redisSet(key, value, ttlSeconds);
    },
  };
}

function createDefaultProvider(): SportsProvider {
  return new TheSportsDBProvider({
    apiKey: getEnv().THESPORTSDB_API_KEY,
    cache: createRedisCacheStore(),
    cacheTtlSeconds: SPORTS_CACHE_TTL_SECONDS,
  });
}

async function listAllVenueIds(): Promise<string[]> {
  const result = await query<{ id: string }>('SELECT id FROM venues ORDER BY created_at');
  return result.rows.map((row) => row.id);
}

/**
 * Every `??` here short-circuits, so a test that supplies a provider never
 * touches getEnv(), Redis or pg.
 */
function resolveDeps(overrides: Partial<PollGamesDeps>): PollGamesDeps {
  return {
    provider: overrides.provider ?? createDefaultProvider(),
    listVenueIds: overrides.listVenueIds ?? listAllVenueIds,
    withTransaction: overrides.withTransaction ?? defaultWithTransaction,
    logger: overrides.logger ?? rootLogger.child({ worker: POLL_GAMES_WORKER_NAME }),
    now: overrides.now ?? (() => new Date()),
    daysAhead: overrides.daysAhead ?? DEFAULT_DAYS_AHEAD,
    leagues: overrides.leagues,
  };
}

/** Guards the upsert: a duplicate external_id aborts the whole statement. */
function dedupeByExternalId(games: readonly NormalizedGame[]): NormalizedGame[] {
  const byId = new Map<string, NormalizedGame>();
  for (const game of games) {
    byId.set(game.externalId, game);
  }
  return [...byId.values()];
}

export async function upsertVenueGames(
  tx: SqlExecutor,
  venueId: string,
  games: readonly NormalizedGame[],
): Promise<UpsertCounts> {
  if (games.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  const result = await tx.query<{ inserted: boolean }>(UPSERT_GAMES_SQL, [
    venueId,
    games.map((game) => game.externalId),
    games.map((game) => game.league),
    games.map((game) => game.sport),
    games.map((game) => game.homeTeam),
    games.map((game) => game.awayTeam),
    games.map((game) => game.homeLogoUrl),
    games.map((game) => game.awayLogoUrl),
    games.map((game) => game.scheduledAt),
    games.map((game) => game.status),
    games.map((game) => game.homeScore),
    games.map((game) => game.awayScore),
    games.map((game) => game.winner),
    games.map((game) => game.status === 'cancelled'),
  ]);

  const inserted = result.rows.filter((row) => row.inserted).length;
  const affected = result.rows.length;

  return {
    inserted,
    updated: affected - inserted,
    skipped: games.length - affected,
  };
}

/**
 * One poll cycle. Never throws: a scheduled worker that can reject takes the
 * whole scheduler down with it.
 *
 * Games are fanned out to every venue. The MVP has no per-venue league
 * selection yet — when it lands, it is `deps.leagues` resolved per venue rather
 * than a change of shape here.
 */
export async function pollGamesOnce(
  overrides: Partial<PollGamesDeps> = {},
): Promise<PollGamesResult> {
  const startedAt = Date.now();
  const runId = randomUUID();

  let deps: PollGamesDeps;
  try {
    deps = resolveDeps(overrides);
  } catch (error) {
    // Misconfigured environment: report it, do not take the scheduler down.
    rootLogger.child({ worker: POLL_GAMES_WORKER_NAME }).error('could not resolve dependencies', {
      runId,
      error,
    });
    return emptyResult(runId, startedAt);
  }

  const log = deps.logger.child({ runId });

  let fetched = 0;
  let venues = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failedVenues = 0;

  try {
    const startDate = toIsoDate(deps.now());
    log.info('poll started', { startDate, daysAhead: deps.daysAhead });

    const games = dedupeByExternalId(
      await deps.provider.fetchGamesForRange(startDate, deps.daysAhead, {
        leagues: deps.leagues,
      }),
    );
    fetched = games.length;

    if (games.length === 0) {
      log.warn('provider returned no games', { startDate, daysAhead: deps.daysAhead });
      return { runId, fetched, venues, inserted, updated, skipped, failedVenues, durationMs: Date.now() - startedAt };
    }

    const venueIds = await deps.listVenueIds();
    venues = venueIds.length;

    if (venueIds.length === 0) {
      log.warn('no venues configured; nothing to persist', { fetched });
      return { runId, fetched, venues, inserted, updated, skipped, failedVenues, durationMs: Date.now() - startedAt };
    }

    for (const venueId of venueIds) {
      try {
        const counts = await deps.withTransaction((tx) => upsertVenueGames(tx, venueId, games));
        inserted += counts.inserted;
        updated += counts.updated;
        skipped += counts.skipped;
        log.debug('venue upsert committed', { venueId, ...counts });
      } catch (error) {
        // One venue's failure is rolled back by withTransaction; the rest of
        // the run continues so a single bad venue cannot stall ingestion.
        failedVenues += 1;
        log.error('venue upsert failed and was rolled back', { venueId, error });
      }
    }

    log.info('poll complete', {
      startDate,
      fetched,
      venues,
      inserted,
      updated,
      skipped,
      failedVenues,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    log.error('poll failed', { error, durationMs: Date.now() - startedAt });
  }

  return {
    runId,
    fetched,
    venues,
    inserted,
    updated,
    skipped,
    failedVenues,
    durationMs: Date.now() - startedAt,
  };
}

function emptyResult(runId: string, startedAt: number): PollGamesResult {
  return {
    runId,
    fetched: 0,
    venues: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failedVenues: 0,
    durationMs: Date.now() - startedAt,
  };
}
