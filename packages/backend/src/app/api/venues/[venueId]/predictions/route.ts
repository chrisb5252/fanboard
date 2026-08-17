import { NextResponse } from 'next/server';
import { assertVenueScope, sessionMiddleware } from '../../../../../lib/auth';
import {
  PICKS_PER_SESSION_PER_MINUTE,
  SHORT_RATE_LIMIT_WINDOW_MS,
  bowlingPredictionRateKey,
} from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { tooManyRequests } from '../../../../../lib/rate-limit-response';
import { consumeRateLimit } from '../../../../../lib/rate-limiter';
import {
  parseJsonBody,
  validateBowlingScore,
  validateLaneId,
  validateVenueId,
} from '../../../../../lib/validators';
import {
  assertBowlingVenue,
  listMyPredictions,
  submitPrediction,
} from '../../../../../services/bowling';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/venues/[venueId]/predictions' });

const requireSession = sessionMiddleware();

/**
 * The player's own bowling predictions, newest first.
 *
 * Scoped to the caller's own session, exactly as picks are: a patron sees what
 * they predicted, never what the next table did.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const session = await requireSession(request);
    assertVenueScope(session, venueId);
    await assertBowlingVenue(venueId);

    const predictions = await listMyPredictions(venueId, session.playerSessionId);

    return NextResponse.json(predictions, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/**
 * Predict a bowler's final score.
 *
 * 201 new prediction · 200 prediction changed · 400 bad input · 401 no session
 * 403 session belongs to another venue · 404 lane not in this venue
 * 423 the lane is locked or already graded
 *
 * The lane id travels in the body rather than the path, matching picks, so a
 * single session guard covers the whole venue and the lane can never be scoped
 * to a different one than the caller.
 *
 * Nothing here trusts a client clock. Whether the lane is still open is decided
 * by PostgreSQL inside the same statement that writes the prediction.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    // Authenticate before anything else, so an unauthenticated caller learns
    // nothing about which lane ids exist.
    const session = await requireSession(request);
    assertVenueScope(session, venueId);
    await assertBowlingVenue(venueId);

    // Per session, not per IP: everyone in the building shares one NAT address,
    // and an IP bucket would throttle the whole alley on league night.
    const limit = await consumeRateLimit(
      bowlingPredictionRateKey(session.playerSessionId),
      PICKS_PER_SESSION_PER_MINUTE,
      SHORT_RATE_LIMIT_WINDOW_MS,
    );
    if (!limit.allowed) {
      log.warn('bowling prediction rejected by per-session rate limit', {
        venueId,
        playerSessionId: session.playerSessionId,
        count: limit.count,
        limit: limit.limit,
      });
      return tooManyRequests(limit, 'session', 'Too many predictions too quickly. Slow down.');
    }

    const body = await parseJsonBody(request);
    const laneId = validateLaneId(body['laneId']);
    const predictedScore = validateBowlingScore('predictedScore', body['predictedScore']);

    const result = await submitPrediction({
      venueId,
      laneId,
      playerSessionId: session.playerSessionId,
      predictedScore,
    });

    return NextResponse.json(
      {
        predictionId: result.predictionId,
        laneId: result.laneId,
        predictedScore: result.predictedScore,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
