import { randomUUID } from 'node:crypto';
import { LEADERBOARD_TTL_SECONDS, leaderboardKey } from '../lib/cache-keys';
import {
  LEADERBOARD_PERIODS,
  computeLeaderboard as defaultCompute,
  listVenueIds as defaultListVenueIds,
  type LeaderboardEntry,
  type LeaderboardPeriod,
} from '../lib/leaderboard';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { set as redisSet } from '../lib/redis';
import type { UUID } from '../lib/validators';

export const UPDATE_LEADERBOARD_WORKER_NAME = 'update-leaderboard';
export const UPDATE_LEADERBOARD_INTERVAL_MS = 300_000;

export interface UpdateLeaderboardResult {
  readonly runId: string;
  readonly venues: number;
  /** venues x periods successfully materialised. */
  readonly leaderboards: number;
  readonly entries: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface UpdateLeaderboardDeps {
  listVenueIds: () => Promise<UUID[]>;
  computeLeaderboard: (venueId: UUID, period: LeaderboardPeriod) => Promise<LeaderboardEntry[]>;
  cacheSet: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  logger: Logger;
}

function resolveDeps(overrides: Partial<UpdateLeaderboardDeps>): UpdateLeaderboardDeps {
  return {
    listVenueIds: overrides.listVenueIds ?? (() => defaultListVenueIds()),
    computeLeaderboard:
      overrides.computeLeaderboard ?? ((venueId, period) => defaultCompute(venueId, period)),
    cacheSet: overrides.cacheSet ?? redisSet,
    logger: overrides.logger ?? rootLogger.child({ worker: UPDATE_LEADERBOARD_WORKER_NAME }),
  };
}

/**
 * Materialises every venue's leaderboard for every period.
 *
 * Runs on a 5 minute cadence and is also called directly after a grading run,
 * so a settled game shows up on the TV without waiting for the next tick.
 *
 * Warms the Redis cache as it goes: the read path is a public, unauthenticated
 * endpoint that a wall of TVs polls, and it should almost never reach Postgres.
 *
 * Never throws.
 */
export async function updateLeaderboardsOnce(
  overrides: Partial<UpdateLeaderboardDeps> = {},
): Promise<UpdateLeaderboardResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const deps = resolveDeps(overrides);
  const log = deps.logger.child({ runId });

  let venues = 0;
  let leaderboards = 0;
  let entries = 0;
  let errors = 0;

  try {
    const venueIds = await deps.listVenueIds();
    venues = venueIds.length;

    if (venueIds.length === 0) {
      log.debug('no venues to materialise');
      return { runId, venues, leaderboards, entries, errors, durationMs: Date.now() - startedAt };
    }

    for (const venueId of venueIds) {
      for (const period of LEADERBOARD_PERIODS) {
        try {
          const standings = await deps.computeLeaderboard(venueId, period);
          leaderboards += 1;
          entries += standings.length;

          try {
            await deps.cacheSet(
              leaderboardKey(venueId, period),
              JSON.stringify(standings),
              LEADERBOARD_TTL_SECONDS,
            );
          } catch (error) {
            // The snapshot is already stored; a cold cache only costs a query.
            log.warn('failed to warm leaderboard cache', { venueId, period, error });
          }
        } catch (error) {
          // One venue/period failing must not stop the rest.
          errors += 1;
          log.error('failed to compute leaderboard', { venueId, period, error });
        }
      }
    }

    log.info('leaderboards materialised', {
      venues,
      leaderboards,
      entries,
      errors,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    errors += 1;
    log.error('leaderboard run failed', { error, durationMs: Date.now() - startedAt });
  }

  return { runId, venues, leaderboards, entries, errors, durationMs: Date.now() - startedAt };
}
