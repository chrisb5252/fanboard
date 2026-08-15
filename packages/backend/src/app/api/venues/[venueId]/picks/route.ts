import { NextResponse } from 'next/server';
import { assertVenueScope, sessionMiddleware } from '../../../../../lib/auth';
import {
  PICKS_PER_SESSION_PER_MINUTE,
  SHORT_RATE_LIMIT_WINDOW_MS,
  pickRateKey,
} from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { tooManyRequests } from '../../../../../lib/rate-limit-response';
import { consumeRateLimit } from '../../../../../lib/rate-limiter';
import {
  parseJsonBody,
  validateGameId,
  validatePredictedWinner,
  validateVenueId,
} from '../../../../../lib/validators';
import { listMyPicks, submitPick } from '../../../../../services/picks';

/** Never prerender or cache: authenticated, and it writes. */
export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'POST /api/venues/[venueId]/picks' });

const requireSession = sessionMiddleware();

/**
 * Submit or change a pick.
 *
 * 201 new pick · 200 pick changed · 400 bad input · 401 no session
 * 403 session belongs to another venue · 404 game not in this venue
 * 423 picks are closed
 *
 * No timestamp from the request is read anywhere in this path. Whether a game
 * is open is decided by PostgreSQL's clock inside the same statement that
 * writes the pick, so a client cannot win by lying about the time or by racing
 * the lock.
 */
/**
 * The player's own picks, newest first.
 *
 * Session-authenticated and scoped to the caller's own player id — a patron can
 * see what they predicted, never what anyone else did. The admin inspector is
 * the venue-wide view and needs an API key.
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

    const picks = await listMyPicks(venueId, session.playerSessionId);

    return NextResponse.json(picks, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    // Authenticate first: an unauthenticated caller learns nothing about
    // whether a game id exists or is locked.
    const session = await requireSession(request);
    assertVenueScope(session, venueId);

    // Keyed by session rather than by IP: every patron at a venue shares one
    // NAT address, so an IP bucket here would throttle the whole room the
    // moment the bar got busy. Applied after authentication, so an
    // unauthenticated caller cannot consume anyone's budget, and before the
    // body is parsed, so a looping client costs one Redis round trip.
    const limit = await consumeRateLimit(
      pickRateKey(session.playerSessionId),
      PICKS_PER_SESSION_PER_MINUTE,
      SHORT_RATE_LIMIT_WINDOW_MS,
    );
    if (!limit.allowed) {
      log.warn('pick rejected by per-session rate limit', {
        venueId,
        playerSessionId: session.playerSessionId,
        count: limit.count,
        limit: limit.limit,
      });
      return tooManyRequests(limit, 'session', 'Too many picks too quickly. Slow down.');
    }

    const body = await parseJsonBody(request);
    const gameId = validateGameId(body['gameId']);
    const predictedWinner = validatePredictedWinner(body['predictedWinner']);

    const result = await submitPick({
      venueId,
      gameId,
      playerSessionId: session.playerSessionId,
      predictedWinner,
    });

    return NextResponse.json(
      {
        pickId: result.pickId,
        gameId: result.gameId,
        predictedWinner: result.predictedWinner,
        locked: result.locked,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
