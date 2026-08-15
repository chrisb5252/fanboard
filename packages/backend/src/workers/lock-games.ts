import { randomUUID } from 'node:crypto';
import { broadcastGameLocked } from '../lib/leaderboard-broadcaster';
import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { GAME_LOCK_TTL_SECONDS, gameLockKey } from '../lib/cache-keys';
import { set as redisSet } from '../lib/redis';

export const LOCK_GAMES_WORKER_NAME = 'lock-games';
export const LOCK_GAMES_INTERVAL_MS = 30_000;

export interface LockGamesResult {
  runId: string;
  locked: number;
  venues: number;
  durationMs: number;
}

export interface LockGamesDeps {
  db: SqlExecutor;
  announce: (venueId: string, gameId: string, scheduledAt: string) => Promise<void>;
  warmCache: (gameId: string, lockedAt: string) => Promise<void>;
  logger: Logger;
}

/**
 * Stamps locked_at on games whose kick-off has passed, and returns exactly the
 * ones this run closed.
 *
 * There was no lock *event* to hook before this. A game became unpickable
 * because `COALESCE(locked_at, scheduled_at) <= NOW()` started being true — the
 * clock moved, and no row changed. Nothing to observe, nothing to broadcast.
 *
 * Writing locked_at makes the transition explicit and, more usefully, makes it
 * happen exactly once: `WHERE locked_at IS NULL` means a second run returns no
 * rows, so nobody gets told twice. It does not change pick semantics — both
 * sides of the COALESCE are now in the past, so the predicate answers the same
 * as it did.
 */
const LOCK_GAMES_SQL = `
UPDATE games
   SET locked_at = NOW(),
       updated_at = NOW()
 WHERE locked_at IS NULL
   AND graded_at IS NULL
   AND cancelled = FALSE
   AND status = 'scheduled'
   AND scheduled_at <= NOW()
 RETURNING id, venue_id, scheduled_at
`;

function resolveDeps(overrides: Partial<LockGamesDeps>): LockGamesDeps {
  return {
    db: overrides.db ?? defaultSql,
    announce:
      overrides.announce ??
      ((venueId, gameId, scheduledAt) => broadcastGameLocked(venueId, gameId, scheduledAt)),
    warmCache:
      overrides.warmCache ??
      (async (gameId, lockedAt) => {
        await redisSet(gameLockKey(gameId), lockedAt, GAME_LOCK_TTL_SECONDS);
      }),
    logger: overrides.logger ?? rootLogger.child({ worker: LOCK_GAMES_WORKER_NAME }),
  };
}

/** One pass. Never throws. */
export async function lockGamesOnce(
  overrides: Partial<LockGamesDeps> = {},
): Promise<LockGamesResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const deps = resolveDeps(overrides);
  const log = deps.logger.child({ runId });

  let locked = 0;
  const venues = new Set<string>();

  try {
    const result = await deps.db.query<{
      id: string;
      venue_id: string;
      scheduled_at: Date;
    }>(LOCK_GAMES_SQL);

    locked = result.rows.length;
    if (locked === 0) {
      return { runId, locked, venues: 0, durationMs: Date.now() - startedAt };
    }

    for (const row of result.rows) {
      venues.add(row.venue_id);

      // Warm the fast path the pick service checks, so the very next
      // submission short-circuits before touching Postgres.
      try {
        await deps.warmCache(row.id, row.scheduled_at.toISOString());
      } catch (error) {
        log.warn('could not warm lock cache', { gameId: row.id, error });
      }

      try {
        await deps.announce(row.venue_id, row.id, row.scheduled_at.toISOString());
      } catch (error) {
        log.warn('could not announce lock', { gameId: row.id, error });
      }
    }

    log.info('games locked', { locked, venues: venues.size });
  } catch (error) {
    log.error('lock pass failed', { error });
  }

  return { runId, locked, venues: venues.size, durationMs: Date.now() - startedAt };
}
