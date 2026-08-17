import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../../../lib/errors';
import { computeLeaderboard } from '../../../../../../../../lib/leaderboard';
import { broadcastLeaderboard } from '../../../../../../../../lib/leaderboard-broadcaster';
import { logger as rootLogger } from '../../../../../../../../lib/logger';
import {
  parseJsonBody,
  validateBowlingScore,
  validateLaneId,
  validateVenueId,
} from '../../../../../../../../lib/validators';
import { gradeLane } from '../../../../../../../../services/bowling';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/lanes/[laneId]/grade' });
const requireAdmin = adminMiddleware();

/**
 * Settles a lane against its final score and scores every prediction on it.
 *
 * Admin-only, and for a stronger reason than most: this is the endpoint that
 * decides who won. A patron who could call it would award themselves points.
 *
 * Calling it twice is safe and says so — `alreadyGraded: true`, no second
 * scoring pass. An operator whose first tap seemed not to register gets told
 * the lane is settled rather than an error.
 *
 * 200 graded (or already graded) · 400 bad score · 401 no key
 * 403 key belongs to another venue · 404 no such lane here
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string; laneId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId, laneId: rawLaneId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const laneId = validateLaneId(rawLaneId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const body = await parseJsonBody(request);
    const finalScore = validateBowlingScore('finalScore', body['finalScore']);

    const result = await gradeLane(venueId, laneId, finalScore);

    await auditLog(AUDIT_ACTIONS.laneGraded, undefined, venueId, {
      laneId,
      finalScore,
      predictionsGraded: result.predictionsGraded,
      alreadyGraded: result.alreadyGraded,
    });

    // Rebuild and push straight away rather than waiting out the worker. The
    // room just watched the last frame; the board behind the lanes should not
    // be minutes behind it.
    if (!result.alreadyGraded) {
      const standings = await computeLeaderboard(venueId, 'all_time');
      await broadcastLeaderboard(venueId, 'all_time', standings);
    }

    return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
