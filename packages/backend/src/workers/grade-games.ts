import { randomUUID } from 'node:crypto';
import { gradingChannel, leaderboardKey } from '../lib/cache-keys';
import type { SqlExecutor } from '../lib/db';
import { withTransaction as defaultWithTransaction, query } from '../lib/db';
import { getEnv } from '../lib/env';
import { LEADERBOARD_PERIODS, PERIOD_TO_SNAPSHOT } from '../lib/leaderboard';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { del as redisDel, publish as redisPublish } from '../lib/redis';
import { toIsoDate, type NormalizedGame, type SportsProvider } from '../lib/sports-provider';
import { TheSportsDBProvider } from '../lib/thesportsdb';
import { trustedUuid, type UUID } from '../lib/validators';
import { createRedisCacheStore, SPORTS_CACHE_TTL_SECONDS } from './poll-games';

export const GRADE_GAMES_WORKER_NAME = 'grade-games';
export const GRADE_GAMES_INTERVAL_MS = 120_000;

/** How long after kick-off a game becomes a grading candidate. */
export const GRADING_DELAY_MINUTES = 30;

/** Awarded for a correct pick. A wrong pick scores 0; a voided pick scores NULL. */
export const POINTS_FOR_CORRECT_PICK = 10;

/** Cap per run so one cycle cannot monopolise the pool or the provider. */
export const MAX_GAMES_PER_RUN = 200;

export interface GradeGamesResult {
  readonly runId: string;
  readonly candidates: number;
  readonly gamesGraded: number;
  readonly gamesVoided: number;
  readonly picksGraded: number;
  readonly picksVoided: number;
  readonly skipped: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface GradeGamesDeps {
  provider: SportsProvider;
  listCandidates: () => Promise<CandidateGame[]>;
  withTransaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
  invalidateLeaderboards: (venueId: UUID) => Promise<void>;
  notify: (venueId: UUID, payload: string) => Promise<void>;
  logger: Logger;
}

export interface CandidateGame {
  readonly id: UUID;
  readonly venueId: UUID;
  readonly externalId: string;
  readonly scheduledAt: Date;
}

/**
 * Games that should have finished but have not been settled.
 *
 * The filter is `graded_at IS NULL`, deliberately not `status <> 'final'`.
 * poll-games sets status to 'final' as soon as the provider reports it, so a
 * status-based filter would skip exactly the games that are ready to grade and
 * they would never settle. Whether a game has been *graded* is what this worker
 * cares about, and graded_at is the column that records it.
 */
const CANDIDATES_SQL = `
SELECT id, venue_id, external_id, scheduled_at
  FROM games
 WHERE graded_at IS NULL
   AND cancelled = FALSE
   AND scheduled_at < NOW() - make_interval(mins => $1::int)
 ORDER BY scheduled_at ASC
 LIMIT $2::int
`;

/**
 * Settles the game. Guarded on graded_at IS NULL so two overlapping runs cannot
 * both grade it: the loser updates zero rows and backs out.
 */
const SETTLE_GAME_SQL = `
UPDATE games
   SET status     = $2::text,
       winner     = $3::text,
       home_score = $4::int,
       away_score = $5::int,
       cancelled  = $6::boolean,
       graded_at  = NOW(),
       updated_at = NOW()
 WHERE id = $1::uuid
   AND graded_at IS NULL
 RETURNING id
`;

/**
 * Grades every pick on the game in one statement.
 *
 * The spec's "load all picks, loop, update each" shape is an N+1 in disguise --
 * 10,000 picks would be 10,000 round trips. The scoring rule is expressible in
 * SQL, so the rows never leave the database.
 *
 * $2 void: cancelled game. correct and points both go NULL (neither a win nor a
 * loss) while graded_at is still stamped, which is what marks it settled rather
 * than pending.
 */
const GRADE_PICKS_SQL = `
UPDATE picks
   SET correct = CASE WHEN $2::boolean THEN NULL
                      ELSE (predicted_winner = $3::text) END,
       points  = CASE WHEN $2::boolean THEN NULL
                      WHEN predicted_winner = $3::text THEN $4::int
                      ELSE 0 END,
       graded_at = NOW()
 WHERE game_id = $1::uuid
   AND graded_at IS NULL
`;

async function listCandidatesFromDb(): Promise<CandidateGame[]> {
  const result = await query<{
    id: string;
    venue_id: string;
    external_id: string;
    scheduled_at: Date;
  }>(CANDIDATES_SQL, [GRADING_DELAY_MINUTES, MAX_GAMES_PER_RUN]);

  return result.rows.map((row) => ({
    id: trustedUuid(row.id),
    venueId: trustedUuid(row.venue_id),
    externalId: row.external_id,
    scheduledAt: row.scheduled_at,
  }));
}

function createDefaultProvider(): SportsProvider {
  return new TheSportsDBProvider({
    apiKey: getEnv().THESPORTSDB_API_KEY,
    cache: createRedisCacheStore(),
    cacheTtlSeconds: SPORTS_CACHE_TTL_SECONDS,
  });
}

async function invalidateLeaderboardCache(venueId: UUID): Promise<void> {
  await Promise.all(
    LEADERBOARD_PERIODS.flatMap((period) => [
      redisDel(leaderboardKey(venueId, period)),
      redisDel(leaderboardKey(venueId, PERIOD_TO_SNAPSHOT[period])),
    ]),
  );
}

function resolveDeps(overrides: Partial<GradeGamesDeps>): GradeGamesDeps {
  return {
    provider: overrides.provider ?? createDefaultProvider(),
    listCandidates: overrides.listCandidates ?? listCandidatesFromDb,
    withTransaction: overrides.withTransaction ?? defaultWithTransaction,
    invalidateLeaderboards: overrides.invalidateLeaderboards ?? invalidateLeaderboardCache,
    notify:
      overrides.notify ??
      (async (venueId, payload) => {
        await redisPublish(gradingChannel(venueId), payload);
      }),
    logger: overrides.logger ?? rootLogger.child({ worker: GRADE_GAMES_WORKER_NAME }),
  };
}

interface Settlement {
  readonly status: 'final' | 'cancelled';
  readonly void: boolean;
  readonly winner: string | null;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
}

/**
 * Decides whether a provider result is settleable, and how.
 *
 * Returns null when the game is not finished, or is finished but unusable --
 * a 'final' with no winner (scores missing upstream) would violate
 * games_graded_requires_winner, so it waits for a later poll instead.
 */
export function planSettlement(game: NormalizedGame): Settlement | null {
  if (game.status === 'cancelled') {
    return {
      status: 'cancelled',
      void: true,
      winner: null,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    };
  }

  if (game.status !== 'final') {
    return null;
  }

  if (game.winner === null) {
    return null;
  }

  return {
    status: 'final',
    void: false,
    winner: game.winner,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  };
}

/**
 * One grading cycle. Never throws: a scheduled worker that can reject takes the
 * scheduler down with it.
 */
export async function gradeGamesOnce(
  overrides: Partial<GradeGamesDeps> = {},
): Promise<GradeGamesResult> {
  const startedAt = Date.now();
  const runId = randomUUID();

  let deps: GradeGamesDeps;
  try {
    deps = resolveDeps(overrides);
  } catch (error) {
    rootLogger.child({ worker: GRADE_GAMES_WORKER_NAME }).error('could not resolve dependencies', {
      runId,
      error,
    });
    return emptyResult(runId, startedAt);
  }

  const log = deps.logger.child({ runId });

  let candidates = 0;
  let gamesGraded = 0;
  let gamesVoided = 0;
  let picksGraded = 0;
  let picksVoided = 0;
  let skipped = 0;
  let errors = 0;
  const touchedVenues = new Set<UUID>();

  try {
    const pending = await deps.listCandidates();
    candidates = pending.length;

    if (pending.length === 0) {
      log.debug('no games awaiting grading');
      return { runId, candidates, gamesGraded, gamesVoided, picksGraded, picksVoided, skipped, errors, durationMs: Date.now() - startedAt };
    }

    log.info('grading run started', { candidates });

    // One provider call per distinct match day rather than per game: 40 games
    // on the same evening is one request, and the Redis cache in the provider
    // makes a repeat run within 5 minutes free.
    const results = await loadProviderResults(pending, deps, log);

    for (const candidate of pending) {
      const fresh = results.get(candidate.externalId);
      if (fresh === undefined) {
        skipped += 1;
        continue;
      }

      const plan = planSettlement(fresh);
      if (plan === null) {
        skipped += 1;
        continue;
      }

      try {
        const graded = await settleGame(candidate, plan, deps);
        if (graded === null) {
          // Another run got there first.
          skipped += 1;
          continue;
        }

        if (plan.void) {
          gamesVoided += 1;
          picksVoided += graded;
        } else {
          gamesGraded += 1;
          picksGraded += graded;
        }
        touchedVenues.add(candidate.venueId);

        log.info('game settled', {
          gameId: candidate.id,
          venueId: candidate.venueId,
          outcome: plan.void ? 'voided' : 'graded',
          winner: plan.winner,
          picks: graded,
        });
      } catch (error) {
        errors += 1;
        log.error('failed to settle game; transaction rolled back', {
          gameId: candidate.id,
          venueId: candidate.venueId,
          error,
        });
      }
    }

    // After commit, never before: a rolled-back grade must not invalidate a
    // cache or tell subscribers something happened.
    for (const venueId of touchedVenues) {
      await announce(venueId, deps, log);
    }

    log.info('grading run complete', {
      candidates,
      gamesGraded,
      gamesVoided,
      picksGraded,
      picksVoided,
      skipped,
      errors,
      venues: touchedVenues.size,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    errors += 1;
    log.error('grading run failed', { error, durationMs: Date.now() - startedAt });
  }

  return {
    runId,
    candidates,
    gamesGraded,
    gamesVoided,
    picksGraded,
    picksVoided,
    skipped,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/** Fetches fresh results for every distinct match day among the candidates. */
async function loadProviderResults(
  pending: readonly CandidateGame[],
  deps: GradeGamesDeps,
  log: Logger,
): Promise<Map<string, NormalizedGame>> {
  const dates = new Set(pending.map((candidate) => toIsoDate(candidate.scheduledAt)));
  const byExternalId = new Map<string, NormalizedGame>();

  for (const date of dates) {
    try {
      const games = await deps.provider.fetchGames(date);
      for (const game of games) {
        byExternalId.set(game.externalId, game);
      }
    } catch (error) {
      // fetchGames is contracted not to throw, but a custom provider might.
      log.error('provider lookup failed for a match day', { date, error });
    }
  }

  log.debug('provider results loaded', { dates: dates.size, results: byExternalId.size });
  return byExternalId;
}

/**
 * Settles one game and all its picks in a single transaction: either the game
 * is marked graded and every pick is scored, or nothing changes.
 *
 * Returns the number of picks graded, or null if another run won the race.
 */
async function settleGame(
  candidate: CandidateGame,
  plan: Settlement,
  deps: GradeGamesDeps,
): Promise<number | null> {
  return deps.withTransaction(async (tx) => {
    const settled = await tx.query<{ id: string }>(SETTLE_GAME_SQL, [
      candidate.id,
      plan.status,
      plan.winner,
      plan.homeScore,
      plan.awayScore,
      plan.void,
    ]);

    if (settled.rows.length === 0) {
      return null;
    }

    const graded = await tx.query(GRADE_PICKS_SQL, [
      candidate.id,
      plan.void,
      plan.winner,
      POINTS_FOR_CORRECT_PICK,
    ]);

    return graded.rowCount;
  });
}

async function announce(venueId: UUID, deps: GradeGamesDeps, log: Logger): Promise<void> {
  try {
    await deps.invalidateLeaderboards(venueId);
  } catch (error) {
    // A stale leaderboard is recoverable; the grade is already committed.
    log.warn('failed to invalidate leaderboard cache', { venueId, error });
  }

  try {
    await deps.notify(venueId, JSON.stringify({ type: 'games_graded', venueId }));
  } catch (error) {
    log.warn('failed to publish grading notification', { venueId, error });
  }
}

function emptyResult(runId: string, startedAt: number): GradeGamesResult {
  return {
    runId,
    candidates: 0,
    gamesGraded: 0,
    gamesVoided: 0,
    picksGraded: 0,
    picksVoided: 0,
    skipped: 0,
    errors: 0,
    durationMs: Date.now() - startedAt,
  };
}
