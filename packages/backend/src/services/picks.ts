import { GAME_LOCK_TTL_SECONDS, gameLockKey, venuePicksKey } from '../lib/cache-keys';
import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { del as redisDel, get as redisGet, set as redisSet } from '../lib/redis';
import { trustedUuid, type PredictedWinner, type UUID } from '../lib/validators';

export interface SubmitPickInput {
  venueId: UUID;
  gameId: UUID;
  playerSessionId: UUID;
  predictedWinner: PredictedWinner;
}

export interface SubmitPickResult {
  pickId: UUID;
  gameId: UUID;
  predictedWinner: PredictedWinner;
  locked: false;
  /** true = row created (201), false = existing pick changed (200). */
  created: boolean;
}

export interface PickServiceDeps {
  db: SqlExecutor;
  cacheGet: (key: string) => Promise<string | null>;
  cacheSet: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  cacheDel: (key: string) => Promise<number>;
  logger: Logger;
}

function resolveDeps(deps?: Partial<PickServiceDeps>): PickServiceDeps {
  return {
    db: deps?.db ?? defaultSql,
    cacheGet: deps?.cacheGet ?? redisGet,
    cacheSet: deps?.cacheSet ?? redisSet,
    cacheDel: deps?.cacheDel ?? redisDel,
    logger: deps?.logger ?? rootLogger.child({ service: 'picks' }),
  };
}

/**
 * Writes the pick only if the game is open, in a single statement.
 *
 * This is the release-blocking part. The obvious implementation — SELECT the
 * game, check the clock in Node, then INSERT — is a time-of-check/time-of-use
 * race: the game can lock in the gap, and under load that gap is exactly when
 * everyone is submitting. Here the lock predicate is a WHERE clause on the same
 * statement that writes, so PostgreSQL evaluates "is it open?" and "write the
 * pick" as one atomic unit.
 *
 * Consequences worth stating:
 *  - NOW() is the *database's* clock. No timestamp from the client is read,
 *    parsed, or trusted anywhere in this path.
 *  - COALESCE(locked_at, scheduled_at) means an operator can close picks early
 *    by setting locked_at without touching the schedule.
 *  - status <> 'scheduled' also closes picks: a game that has gone live, final,
 *    postponed or cancelled takes no more predictions.
 *  - A conflicting row only updates when the same predicate held, so an
 *    existing pick cannot be edited after lock either.
 *
 * Zero rows means "not written" and deliberately does not say why; the caller
 * re-reads the game to tell 404 from 423.
 */
const SUBMIT_PICK_SQL = `
WITH open_game AS (
  SELECT g.id, g.venue_id
    FROM games g
   WHERE g.id = $2::uuid
     AND g.venue_id = $1::uuid
     AND g.cancelled = FALSE
     AND g.status = 'scheduled'
     AND COALESCE(g.locked_at, g.scheduled_at) > NOW()
)
INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, submitted_at)
SELECT open_game.venue_id, open_game.id, $3::uuid, $4::text, NOW()
  FROM open_game
ON CONFLICT (game_id, player_session_id) DO UPDATE
   SET predicted_winner = EXCLUDED.predicted_winner,
       submitted_at     = NOW(),
       points           = NULL,
       correct          = NULL,
       graded_at        = NULL
RETURNING id, (xmax = 0) AS inserted
`;

/** Read-only follow-up used purely to explain a zero-row write. */
const EXPLAIN_GAME_SQL = `
SELECT g.id,
       g.status,
       g.cancelled,
       COALESCE(g.locked_at, g.scheduled_at)          AS lock_at,
       COALESCE(g.locked_at, g.scheduled_at) <= NOW() AS time_locked
  FROM games g
 WHERE g.id = $2::uuid
   AND g.venue_id = $1::uuid
`;

interface ExplainRow {
  id: string;
  status: string;
  cancelled: boolean;
  lock_at: Date | null;
  time_locked: boolean;
}

export async function submitPick(
  input: SubmitPickInput,
  deps?: Partial<PickServiceDeps>,
): Promise<SubmitPickResult> {
  const { db, cacheGet, cacheSet, cacheDel, logger } = resolveDeps(deps);
  const log = logger.child({ venueId: input.venueId, gameId: input.gameId });

  // Fast path. A cached lock is authoritative for rejection only: locks never
  // lift, so a present key can be trusted, while an absent key proves nothing
  // and falls through to the database.
  if (await isLockedInCache(input.gameId, cacheGet, log)) {
    log.info('pick rejected by cached lock');
    throw ApiError.locked('Picks are closed for this game');
  }

  const written = await db.query<{ id: string; inserted: boolean }>(SUBMIT_PICK_SQL, [
    input.venueId,
    input.gameId,
    input.playerSessionId,
    input.predictedWinner,
  ]);

  const row = written.rows[0];
  if (row === undefined) {
    throw await buildRejection(input, db, cacheSet, log);
  }

  // Picks changed, so any cached view of this venue's picks is now wrong.
  await invalidatePicksCache(input.venueId, cacheDel, log);

  log.info('pick recorded', {
    pickId: row.id,
    created: row.inserted,
    predictedWinner: input.predictedWinner,
  });

  return {
    pickId: trustedUuid(row.id),
    gameId: input.gameId,
    predictedWinner: input.predictedWinner,
    locked: false,
    created: row.inserted,
  };
}

async function isLockedInCache(
  gameId: UUID,
  cacheGet: PickServiceDeps['cacheGet'],
  log: Logger,
): Promise<boolean> {
  try {
    return (await cacheGet(gameLockKey(gameId))) !== null;
  } catch (error) {
    // Redis is a fast path, not the source of truth. If it is unavailable the
    // database still enforces the lock, so degrade rather than fail the write.
    log.warn('lock cache read failed; falling through to database', { error });
    return false;
  }
}

/**
 * Turns a zero-row write into the right error. The write statement deliberately
 * cannot say *why* it matched nothing, so this re-reads the game read-only.
 */
async function buildRejection(
  input: SubmitPickInput,
  db: SqlExecutor,
  cacheSet: PickServiceDeps['cacheSet'],
  log: Logger,
): Promise<ApiError> {
  const explained = await db.query<ExplainRow>(EXPLAIN_GAME_SQL, [input.venueId, input.gameId]);
  const game = explained.rows[0];

  if (game === undefined) {
    // Either no such game, or it belongs to another venue. Both answer 404 so
    // the response cannot be used to enumerate games across venues.
    log.info('pick rejected: game not found in this venue');
    return ApiError.notFound('Game not found');
  }

  // Warm the fast path so the next attempt short-circuits before touching pg.
  try {
    await cacheSet(
      gameLockKey(input.gameId),
      game.lock_at?.toISOString() ?? new Date().toISOString(),
      GAME_LOCK_TTL_SECONDS,
    );
  } catch (error) {
    log.warn('failed to warm lock cache', { error });
  }

  log.info('pick rejected: game is locked', {
    status: game.status,
    cancelled: game.cancelled,
    timeLocked: game.time_locked,
  });

  return ApiError.locked('Picks are closed for this game', {
    reason: game.time_locked ? 'past_lock_time' : `game_status_${game.status}`,
  });
}

export interface MyPick {
  pickId: UUID;
  gameId: UUID;
  homeTeam: string;
  awayTeam: string;
  league: string;
  scheduledAt: string;
  gameStatus: string;
  predictedWinner: PredictedWinner;
  /** null while pending and for voided picks; pair with gradedAt to tell apart. */
  correct: boolean | null;
  points: number | null;
  submittedAt: string;
  gradedAt: string | null;
}

const MY_PICKS_SQL = `
SELECT p.id,
       p.game_id,
       g.home_team,
       g.away_team,
       g.league,
       g.scheduled_at,
       g.status AS game_status,
       p.predicted_winner,
       p.correct,
       p.points,
       p.submitted_at,
       p.graded_at
  FROM picks p
  JOIN games g
    ON g.id = p.game_id
   AND g.venue_id = p.venue_id
 WHERE p.venue_id = $1::uuid
   AND p.player_session_id = $2::uuid
 ORDER BY g.scheduled_at DESC, p.submitted_at DESC
 LIMIT 200
`;

/** One player's own picks, joined to enough game detail to render a row. */
export async function listMyPicks(
  venueId: UUID,
  playerSessionId: UUID,
  deps?: Partial<PickServiceDeps>,
): Promise<MyPick[]> {
  const { db } = resolveDeps(deps);

  const result = await db.query<{
    id: string;
    game_id: string;
    home_team: string;
    away_team: string;
    league: string;
    scheduled_at: Date;
    game_status: string;
    predicted_winner: string;
    correct: boolean | null;
    points: number | null;
    submitted_at: Date;
    graded_at: Date | null;
  }>(MY_PICKS_SQL, [venueId, playerSessionId]);

  return result.rows.map((row) => ({
    pickId: trustedUuid(row.id),
    gameId: trustedUuid(row.game_id),
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    league: row.league,
    scheduledAt: row.scheduled_at.toISOString(),
    gameStatus: row.game_status,
    predictedWinner: row.predicted_winner as PredictedWinner,
    correct: row.correct,
    points: row.points,
    submittedAt: row.submitted_at.toISOString(),
    gradedAt: row.graded_at?.toISOString() ?? null,
  }));
}

async function invalidatePicksCache(
  venueId: UUID,
  cacheDel: PickServiceDeps['cacheDel'],
  log: Logger,
): Promise<void> {
  try {
    await cacheDel(venuePicksKey(venueId));
  } catch (error) {
    // A stale cache is bad, but the pick is already durably committed. Losing
    // the write here would be worse than serving a stale list briefly.
    log.warn('failed to invalidate picks cache', { error });
  }
}
