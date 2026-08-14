import { NextResponse } from 'next/server';
import { LEADERBOARD_TTL_SECONDS, leaderboardKey } from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import {
  readLeaderboardSnapshot,
  validatePeriod,
  type LeaderboardEntry,
} from '../../../../../lib/leaderboard';
import { logger as rootLogger } from '../../../../../lib/logger';
import { get as redisGet, set as redisSet } from '../../../../../lib/redis';
import { validateVenueId } from '../../../../../lib/validators';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/venues/[venueId]/leaderboard' });

interface PublicEntry {
  rank: number;
  nickname: string;
  wins: number;
  losses: number;
  points: number;
}

/**
 * player_session_id never leaves the server. It is a tenant-internal id, and
 * this endpoint is public and unauthenticated -- exposing it would let anyone
 * reading a TV correlate players across boards.
 */
function toPublic(entry: LeaderboardEntry): PublicEntry {
  return {
    rank: entry.rank,
    nickname: entry.nickname,
    wins: entry.wins,
    losses: entry.losses,
    points: entry.points,
  };
}

/**
 * Public leaderboard read. No authentication by design: this is what the TV and
 * the patron phones poll.
 *
 * Redis first, then the materialised snapshot. It never recomputes on demand --
 * an aggregate over every pick in a venue is not something an unauthenticated
 * caller should be able to trigger at will.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const period = validatePeriod(new URL(request.url).searchParams.get('period'));

    const key = leaderboardKey(venueId, period);

    const cached = await readCache(key);
    if (cached !== null) {
      return json(cached, { cache: 'HIT' });
    }

    const snapshot = await readLeaderboardSnapshot(venueId, period);
    const entries = snapshot.map(toPublic);

    // Best effort: a cache write failure must not fail the read.
    try {
      await redisSet(key, JSON.stringify(snapshot), LEADERBOARD_TTL_SECONDS);
    } catch (error) {
      log.warn('failed to populate leaderboard cache', { venueId, period, error });
    }

    return json(entries, { cache: 'MISS' });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

async function readCache(key: string): Promise<PublicEntry[] | null> {
  try {
    const raw = await redisGet(key);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return (parsed as LeaderboardEntry[]).map(toPublic);
  } catch (error) {
    // A cache outage or a poisoned entry degrades to the database.
    log.warn('leaderboard cache read failed; falling through', { key, error });
    return null;
  }
}

function json(entries: PublicEntry[], meta: { cache: 'HIT' | 'MISS' }): NextResponse {
  return NextResponse.json(entries, {
    status: 200,
    headers: {
      'x-cache': meta.cache,
      // Shared caches may hold this as long as Redis would.
      'cache-control': `public, max-age=${LEADERBOARD_TTL_SECONDS}`,
    },
  });
}
