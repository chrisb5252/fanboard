import { NextResponse } from 'next/server';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import {
  validateLimit,
  validateOffset,
  validateVenueId,
} from '../../../../../../lib/validators';
import {
  PLAYER_LIMIT_DEFAULT,
  PLAYER_LIMIT_MAX,
  listPlayers,
} from '../../../../../../services/admin';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/admin/venues/[venueId]/players' });

const requireAdmin = adminMiddleware();

/**
 * Paginated player list for the venue, most recently seen first.
 *
 * Returns nicknames and pick totals. Session tokens are neither selected nor
 * serialisable from here -- an admin can see who is playing, not impersonate
 * them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const query = new URL(request.url).searchParams;
    const limit = validateLimit(query.get('limit'), PLAYER_LIMIT_DEFAULT, PLAYER_LIMIT_MAX);
    const offset = validateOffset(query.get('offset'));

    const players = await listPlayers(venueId, limit, offset);

    return NextResponse.json(players, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        // The caller cannot otherwise tell a clamped limit from the one it sent.
        'x-limit': String(limit),
        'x-offset': String(offset),
      },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
