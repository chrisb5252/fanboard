import { NextResponse } from 'next/server';
import { DISPLAY_TTL_SECONDS } from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { get as redisGet, set as redisSet } from '../../../../../lib/redis';
import { validateVenueId } from '../../../../../lib/validators';
import { buildDisplayPayload, type DisplayGame } from '../../../../../services/display';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/venues/[venueId]/games' });

function gamesCacheKey(venueId: string): string {
  return `venue:${venueId}:games`;
}

/**
 * Today's games for a venue.
 *
 * Public and unauthenticated, matching the leaderboard: this is the same fixture
 * list already rendered on a TV in the room, so there is nothing here a passer-by
 * could not read off the wall. It carries no player data.
 *
 * Reuses the display service's query rather than duplicating it, so the phone
 * and the TV can never disagree about what is on tonight. Cached on the same
 * 10-second TTL, keyed by venue rather than by device.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const key = gamesCacheKey(venueId);

    const cached = await readCache(key);
    if (cached !== null) {
      return json(cached, 'HIT');
    }

    const payload = await buildDisplayPayload(venueId);
    const games = payload.games;

    try {
      await redisSet(key, JSON.stringify(games), DISPLAY_TTL_SECONDS);
    } catch (error) {
      log.warn('failed to populate games cache', { venueId, error });
    }

    return json(games, 'MISS');
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

async function readCache(key: string): Promise<DisplayGame[] | null> {
  try {
    const raw = await redisGet(key);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DisplayGame[]) : null;
  } catch (error) {
    log.warn('games cache read failed; falling through', { key, error });
    return null;
  }
}

function json(games: DisplayGame[], cache: 'HIT' | 'MISS'): NextResponse {
  return NextResponse.json(games, {
    status: 200,
    headers: {
      'x-cache': cache,
      'cache-control': `public, max-age=${DISPLAY_TTL_SECONDS}`,
    },
  });
}
