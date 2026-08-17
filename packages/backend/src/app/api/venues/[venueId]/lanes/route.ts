import { NextResponse } from 'next/server';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { validateVenueId } from '../../../../../lib/validators';
import { listLanes } from '../../../../../services/bowling';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/venues/[venueId]/lanes' });

/**
 * The venue's lanes.
 *
 * Public and unauthenticated, matching the games list it replaces: this is the
 * same board already on a screen in the room, and it carries no player data —
 * only a count of how many people have predicted on each lane.
 *
 * A sports bar answers 404 here. It has no lanes, so that is both true and the
 * response that reveals least.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const lanes = await listLanes(venueId);

    return NextResponse.json(lanes, {
      status: 200,
      // Lanes change as an operator moves through frames, so this is short-
      // lived rather than cached like the fixture list.
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
