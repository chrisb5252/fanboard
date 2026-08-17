import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql, withTransaction as defaultWithTransaction } from '../lib/db';
import { ApiError } from '../lib/errors';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { trustedUuid, type UUID } from '../lib/validators';
import { assertBowlingVenue as assertBowlingVenueType } from '../lib/venue-type';

/**
 * Bowling alleys: lanes, score predictions, and settlement.
 *
 * The sports-bar side of this product spent a long time getting three things
 * right, and this reuses all of them rather than reinventing them:
 *
 *  - The lock is a WHERE clause on the statement that writes, not a preceding
 *    SELECT. A read-then-write is a race, and the window is exactly when a
 *    lane is being locked.
 *  - Settlement is one transaction guarded on `graded_at IS NULL`, so two
 *    overlapping runs cannot score a prediction twice.
 *  - Predictions are scored in one bulk statement rather than a loop. A busy
 *    alley on league night is hundreds of rows, and a per-row round trip is an
 *    N+1 waiting to be discovered under load.
 */

export interface BowlingDeps {
  db: SqlExecutor;
  withTransaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
  logger: Logger;
}

function resolveDeps(deps?: Partial<BowlingDeps>): BowlingDeps {
  return {
    db: deps?.db ?? defaultSql,
    withTransaction: deps?.withTransaction ?? defaultWithTransaction,
    logger: deps?.logger ?? rootLogger.child({ service: 'bowling' }),
  };
}

export const LANE_STATUSES = ['available', 'in_use', 'closed'] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];

export const MIN_SCORE = 0;
/** A perfect ten-pin game. */
export const MAX_SCORE = 300;
export const MAX_FRAME = 10;

/**
 * Accuracy bands.
 *
 * Kept as data in one place so the rule can be tuned without touching the
 * grading path, and expressed as "within N pins" because that is how a bowler
 * would describe it. accuracy_delta is stored on every prediction, so changing
 * these does not invalidate history — it only changes what future gradings
 * award.
 */
export const SCORING_BANDS: readonly { within: number; points: number }[] = [
  { within: 0, points: 50 },
  { within: 5, points: 30 },
  { within: 10, points: 15 },
  { within: 20, points: 5 },
];

export function pointsForDelta(delta: number): number {
  for (const band of SCORING_BANDS) {
    if (delta <= band.within) {
      return band.points;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Venue type
// ---------------------------------------------------------------------------

/** Re-exported so callers of this service need only one import. */
export async function assertBowlingVenue(
  venueId: UUID,
  deps?: Partial<BowlingDeps>,
): Promise<void> {
  const { db } = resolveDeps(deps);
  await assertBowlingVenueType(venueId, db);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface Lane {
  laneId: UUID;
  laneNumber: number;
  status: LaneStatus;
  currentBowlerName: string | null;
  currentFrame: number;
  currentScore: number;
  finalScore: number | null;
  lockedAt: string | null;
  gradedAt: string | null;
  /** How many patrons have predicted on this lane. */
  predictionCount: number;
}

const LIST_LANES_SQL = `
SELECT l.id, l.lane_number, l.status, l.current_bowler_name, l.current_frame,
       l.current_score, l.final_score, l.locked_at, l.graded_at,
       count(p.id)::int AS prediction_count
  FROM bowling_lanes l
  LEFT JOIN bowling_predictions p ON p.lane_id = l.id AND p.venue_id = l.venue_id
 WHERE l.venue_id = $1::uuid
 GROUP BY l.id
 ORDER BY l.lane_number ASC
`;

export async function listLanes(venueId: UUID, deps?: Partial<BowlingDeps>): Promise<Lane[]> {
  const { db } = resolveDeps(deps);
  await assertBowlingVenue(venueId, deps);

  const result = await db.query<{
    id: string;
    lane_number: number;
    status: string;
    current_bowler_name: string | null;
    current_frame: number;
    current_score: number;
    final_score: number | null;
    locked_at: Date | null;
    graded_at: Date | null;
    prediction_count: number;
  }>(LIST_LANES_SQL, [venueId]);

  return result.rows.map((row) => ({
    laneId: trustedUuid(row.id),
    laneNumber: row.lane_number,
    status: row.status as LaneStatus,
    currentBowlerName: row.current_bowler_name,
    currentFrame: row.current_frame,
    currentScore: row.current_score,
    finalScore: row.final_score,
    lockedAt: row.locked_at?.toISOString() ?? null,
    gradedAt: row.graded_at?.toISOString() ?? null,
    predictionCount: row.prediction_count,
  }));
}

/**
 * Creates the venue's lanes, numbered 1..num_lanes.
 *
 * Idempotent by construction: ON CONFLICT DO NOTHING against the
 * (venue_id, lane_number) key, so running it twice — or after an operator has
 * already added a lane by hand — adds only what is missing rather than failing
 * or duplicating.
 *
 * There is no venue-creation endpoint in this system (a venue is provisioned by
 * insert, see DEPLOYMENT.md), so this is the step that follows it rather than
 * part of it.
 */
export async function provisionLanes(
  venueId: UUID,
  deps?: Partial<BowlingDeps>,
): Promise<{ created: number; total: number }> {
  const { db, logger } = resolveDeps(deps);

  const venue = await db.query<{ type: string; num_lanes: number | null }>(
    'SELECT type, num_lanes FROM venues WHERE id = $1::uuid',
    [venueId],
  );
  const row = venue.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }
  if (row.type !== 'bowling_alley' || row.num_lanes === null) {
    throw ApiError.badRequest('Venue is not a bowling alley with a lane count');
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO bowling_lanes (venue_id, lane_number)
     SELECT $1::uuid, generate_series(1, $2::int)
     ON CONFLICT (venue_id, lane_number) DO NOTHING
     RETURNING id`,
    [venueId, row.num_lanes],
  );

  const total = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM bowling_lanes WHERE venue_id = $1::uuid',
    [venueId],
  );

  logger.info('lanes provisioned', {
    venue_id: venueId,
    created: inserted.rows.length,
    total: Number(total.rows[0]?.count ?? 0),
  });

  return { created: inserted.rows.length, total: Number(total.rows[0]?.count ?? 0) };
}

export interface LaneUpdate {
  status?: LaneStatus;
  currentBowlerName?: string | null;
  currentFrame?: number;
  currentScore?: number;
}

/**
 * Operator update: who is bowling, which frame, the running score.
 *
 * COALESCE on every field so a partial body changes only what it names. The
 * alternative — read the row, merge in Node, write it back — is a lost-update
 * race between two operators on the same lane.
 *
 * Refuses to touch a graded lane. Once predictions are settled against a final
 * score, moving the lane underneath them would leave the two disagreeing.
 */
export async function updateLane(
  venueId: UUID,
  laneId: UUID,
  update: LaneUpdate,
  deps?: Partial<BowlingDeps>,
): Promise<Lane> {
  const { db, logger } = resolveDeps(deps);

  const result = await db.query<{ id: string }>(
    `UPDATE bowling_lanes
        SET status              = COALESCE($3::text, status),
            current_bowler_name = CASE WHEN $7::boolean THEN $4::text ELSE current_bowler_name END,
            current_frame       = COALESCE($5::int, current_frame),
            current_score       = COALESCE($6::int, current_score),
            updated_at          = NOW()
      WHERE id = $2::uuid
        AND venue_id = $1::uuid
        AND graded_at IS NULL
      RETURNING id`,
    [
      venueId,
      laneId,
      update.status ?? null,
      update.currentBowlerName ?? null,
      update.currentFrame ?? null,
      update.currentScore ?? null,
      // Distinguishes "clear the bowler" (explicit null) from "leave it alone"
      // (absent), which COALESCE alone cannot express.
      Object.prototype.hasOwnProperty.call(update, 'currentBowlerName'),
    ],
  );

  if (result.rows[0] === undefined) {
    throw await explainLaneWriteFailure(venueId, laneId, db);
  }

  logger.info('lane updated', { venue_id: venueId, lane_id: laneId, ...update });

  const lanes = await listLanes(venueId, deps);
  const lane = lanes.find((candidate) => candidate.laneId === laneId);
  if (lane === undefined) {
    throw ApiError.notFound('Lane not found');
  }
  return lane;
}

/** Turns a zero-row write into the right error rather than a generic 404. */
async function explainLaneWriteFailure(
  venueId: UUID,
  laneId: UUID,
  db: SqlExecutor,
): Promise<ApiError> {
  const found = await db.query<{ graded_at: Date | null }>(
    'SELECT graded_at FROM bowling_lanes WHERE id = $1::uuid AND venue_id = $2::uuid',
    [laneId, venueId],
  );
  const row = found.rows[0];
  if (row === undefined) {
    // Either no such lane, or it belongs to another venue. Both answer 404 so
    // the response cannot be used to enumerate lanes across venues.
    return ApiError.notFound('Lane not found');
  }
  return new ApiError(409, 'lane_graded', 'This lane is already graded and cannot be changed');
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

export interface SubmittedPrediction {
  predictionId: UUID;
  laneId: UUID;
  predictedScore: number;
  /** true = new row, false = an existing prediction was changed. */
  created: boolean;
}

/**
 * Writes the prediction only if the lane is open, in a single statement.
 *
 * The same shape as pick submission, and for the same reason: SELECT the lane,
 * check the lock in Node, then INSERT is a time-of-check/time-of-use race, and
 * under load that gap is exactly when everyone is predicting.
 *
 * A patron may change their mind while the lane is open — matching how picks
 * behave — and the ON CONFLICT arm carries the same predicate, so an existing
 * prediction cannot be edited after the lock either.
 */
const SUBMIT_PREDICTION_SQL = `
WITH open_lane AS (
  SELECT l.id, l.venue_id
    FROM bowling_lanes l
    JOIN venues v ON v.id = l.venue_id
   WHERE l.id = $2::uuid
     AND l.venue_id = $1::uuid
     AND l.locked_at IS NULL
     AND l.graded_at IS NULL
     AND l.status <> 'closed'
     AND v.suspended_at IS NULL
)
INSERT INTO bowling_predictions (venue_id, lane_id, player_session_id, predicted_score, submitted_at)
SELECT open_lane.venue_id, open_lane.id, $3::uuid, $4::int, NOW()
  FROM open_lane
ON CONFLICT (lane_id, player_session_id) DO UPDATE
   SET predicted_score = EXCLUDED.predicted_score,
       submitted_at    = NOW(),
       actual_score    = NULL,
       accuracy_delta  = NULL,
       points          = NULL,
       graded_at       = NULL
RETURNING id, (xmax = 0) AS inserted
`;

export async function submitPrediction(
  input: { venueId: UUID; laneId: UUID; playerSessionId: UUID; predictedScore: number },
  deps?: Partial<BowlingDeps>,
): Promise<SubmittedPrediction> {
  const { db, logger } = resolveDeps(deps);

  if (
    !Number.isInteger(input.predictedScore) ||
    input.predictedScore < MIN_SCORE ||
    input.predictedScore > MAX_SCORE
  ) {
    throw ApiError.badRequest(
      `predictedScore must be a whole number from ${MIN_SCORE} to ${MAX_SCORE}`,
      { field: 'predictedScore' },
    );
  }

  const written = await db.query<{ id: string; inserted: boolean }>(SUBMIT_PREDICTION_SQL, [
    input.venueId,
    input.laneId,
    input.playerSessionId,
    input.predictedScore,
  ]);

  const row = written.rows[0];
  if (row === undefined) {
    throw await explainPredictionRejection(input.venueId, input.laneId, db);
  }

  logger.info('bowling prediction recorded', {
    venue_id: input.venueId,
    lane_id: input.laneId,
    player_session_id: input.playerSessionId,
    predicted_score: input.predictedScore,
    created: row.inserted,
  });

  return {
    predictionId: trustedUuid(row.id),
    laneId: input.laneId,
    predictedScore: input.predictedScore,
    created: row.inserted,
  };
}

/** The write cannot say why it matched nothing, so this re-reads to find out. */
async function explainPredictionRejection(
  venueId: UUID,
  laneId: UUID,
  db: SqlExecutor,
): Promise<ApiError> {
  const found = await db.query<{
    locked_at: Date | null;
    graded_at: Date | null;
    status: string;
    suspended: boolean;
  }>(
    `SELECT l.locked_at, l.graded_at, l.status, (v.suspended_at IS NOT NULL) AS suspended
       FROM bowling_lanes l JOIN venues v ON v.id = l.venue_id
      WHERE l.id = $1::uuid AND l.venue_id = $2::uuid`,
    [laneId, venueId],
  );

  const lane = found.rows[0];
  if (lane === undefined) {
    return ApiError.notFound('Lane not found');
  }
  if (lane.suspended) {
    return ApiError.forbidden('This venue is not accepting predictions right now');
  }
  return ApiError.locked('Predictions are closed for this lane', {
    reason:
      lane.graded_at !== null
        ? 'already_graded'
        : lane.locked_at !== null
          ? 'locked'
          : `lane_status_${lane.status}`,
  });
}

export interface MyPrediction {
  predictionId: UUID;
  laneId: UUID;
  laneNumber: number;
  bowlerName: string | null;
  predictedScore: number;
  actualScore: number | null;
  accuracyDelta: number | null;
  points: number | null;
  submittedAt: string;
  gradedAt: string | null;
}

const MY_PREDICTIONS_SQL = `
SELECT p.id, p.lane_id, l.lane_number, l.current_bowler_name,
       p.predicted_score, p.actual_score, p.accuracy_delta, p.points,
       p.submitted_at, p.graded_at
  FROM bowling_predictions p
  JOIN bowling_lanes l ON l.id = p.lane_id AND l.venue_id = p.venue_id
 WHERE p.venue_id = $1::uuid
   AND p.player_session_id = $2::uuid
 ORDER BY p.submitted_at DESC
 LIMIT 200
`;

export async function listMyPredictions(
  venueId: UUID,
  playerSessionId: UUID,
  deps?: Partial<BowlingDeps>,
): Promise<MyPrediction[]> {
  const { db } = resolveDeps(deps);

  const result = await db.query<{
    id: string;
    lane_id: string;
    lane_number: number;
    current_bowler_name: string | null;
    predicted_score: number;
    actual_score: number | null;
    accuracy_delta: number | null;
    points: number | null;
    submitted_at: Date;
    graded_at: Date | null;
  }>(MY_PREDICTIONS_SQL, [venueId, playerSessionId]);

  return result.rows.map((row) => ({
    predictionId: trustedUuid(row.id),
    laneId: trustedUuid(row.lane_id),
    laneNumber: row.lane_number,
    bowlerName: row.current_bowler_name,
    predictedScore: row.predicted_score,
    actualScore: row.actual_score,
    accuracyDelta: row.accuracy_delta,
    points: row.points,
    submittedAt: row.submitted_at.toISOString(),
    gradedAt: row.graded_at?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface GradeResult {
  laneId: UUID;
  finalScore: number;
  predictionsGraded: number;
  alreadyGraded: boolean;
}

/**
 * Settles a lane and scores every prediction on it, in one transaction.
 *
 * Guarded on graded_at IS NULL, so two operators tapping "grade" at the same
 * moment settle it once and score once — the same guarantee the sports grading
 * worker has, and for the same reason.
 *
 * Scoring happens in a single UPDATE. The obvious loop — read the predictions,
 * compute in Node, write each back — is an N+1, and on league night a lane can
 * carry a hundred predictions.
 */
const SETTLE_LANE_SQL = `
UPDATE bowling_lanes
   SET final_score = $3::int,
       locked_at   = COALESCE(locked_at, NOW()),
       graded_at   = NOW(),
       status      = 'available',
       updated_at  = NOW()
 WHERE id = $2::uuid
   AND venue_id = $1::uuid
   AND graded_at IS NULL
RETURNING id
`;

/**
 * Scores every ungraded prediction on the lane.
 *
 * The band table is expressed in SQL rather than looped in Node so the whole
 * settlement is one statement. It mirrors SCORING_BANDS, and the unit test
 * asserts the two agree — a rule duplicated in two places will eventually
 * disagree, and this makes that visible immediately rather than at a venue.
 */
const GRADE_PREDICTIONS_SQL = `
UPDATE bowling_predictions
   SET actual_score   = $2::int,
       accuracy_delta = abs(predicted_score - $2::int),
       points         = CASE
                          WHEN abs(predicted_score - $2::int) <= 0  THEN 50
                          WHEN abs(predicted_score - $2::int) <= 5  THEN 30
                          WHEN abs(predicted_score - $2::int) <= 10 THEN 15
                          WHEN abs(predicted_score - $2::int) <= 20 THEN 5
                          ELSE 0
                        END,
       graded_at      = NOW()
 WHERE lane_id = $1::uuid
   AND graded_at IS NULL
`;

export async function gradeLane(
  venueId: UUID,
  laneId: UUID,
  finalScore: number,
  deps?: Partial<BowlingDeps>,
): Promise<GradeResult> {
  const { db, withTransaction, logger } = resolveDeps(deps);

  if (!Number.isInteger(finalScore) || finalScore < MIN_SCORE || finalScore > MAX_SCORE) {
    throw ApiError.badRequest(
      `finalScore must be a whole number from ${MIN_SCORE} to ${MAX_SCORE}`,
      { field: 'finalScore' },
    );
  }

  const exists = await db.query<{ graded_at: Date | null }>(
    'SELECT graded_at FROM bowling_lanes WHERE id = $1::uuid AND venue_id = $2::uuid',
    [laneId, venueId],
  );
  if (exists.rows[0] === undefined) {
    throw ApiError.notFound('Lane not found');
  }

  return withTransaction(async (tx) => {
    const settled = await tx.query<{ id: string }>(SETTLE_LANE_SQL, [venueId, laneId, finalScore]);

    if (settled.rows[0] === undefined) {
      // Another caller got there first. Reported rather than thrown: an
      // operator pressing twice should be told it is done, not shown an error.
      logger.warn('lane already graded', { venue_id: venueId, lane_id: laneId });
      return { laneId, finalScore, predictionsGraded: 0, alreadyGraded: true };
    }

    const graded = await tx.query(GRADE_PREDICTIONS_SQL, [laneId, finalScore]);

    logger.info('lane graded', {
      venue_id: venueId,
      lane_id: laneId,
      final_score: finalScore,
      predictions_graded: graded.rowCount,
    });

    return { laneId, finalScore, predictionsGraded: graded.rowCount, alreadyGraded: false };
  });
}
