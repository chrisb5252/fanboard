import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../../lib/auth';
import { ApiError, toErrorBody } from '../../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../../lib/logger';
import {
  parseJsonBody,
  validateBowlingScore,
  validateDisplayName,
  validateFrame,
  validateLaneId,
  validateVenueId,
} from '../../../../../../../lib/validators';
import {
  LANE_STATUSES,
  updateLane,
  type LaneStatus,
  type LaneUpdate,
} from '../../../../../../../services/bowling';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/lanes/[laneId]' });
const requireAdmin = adminMiddleware();

/**
 * Builds the update from only the fields the body actually names.
 *
 * The distinction matters for the bowler: an absent currentBowlerName leaves
 * whoever is on the lane alone, an explicit null clears it. Collapsing the two
 * would wipe the name on every frame update.
 */
function parseUpdate(body: Record<string, unknown>): LaneUpdate {
  const update: LaneUpdate = {};

  if (body['status'] !== undefined) {
    const status = body['status'];
    if (typeof status !== 'string' || !(LANE_STATUSES as readonly string[]).includes(status)) {
      throw ApiError.badRequest(`status must be one of: ${LANE_STATUSES.join(', ')}`, {
        field: 'status',
      });
    }
    update.status = status as LaneStatus;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'currentBowlerName')) {
    const name = body['currentBowlerName'];
    update.currentBowlerName = name === null ? null : validateDisplayName(name);
  }

  if (body['currentFrame'] !== undefined) {
    update.currentFrame = validateFrame(body['currentFrame']);
  }

  if (body['currentScore'] !== undefined) {
    update.currentScore = validateBowlingScore('currentScore', body['currentScore']);
  }

  if (Object.keys(update).length === 0) {
    throw ApiError.badRequest('Nothing to update', { field: 'body' });
  }

  return update;
}

/**
 * Updates a lane: who is bowling, the frame, the running score, the status.
 *
 * Admin-only. This is what drives the TV, and an unauthenticated caller could
 * otherwise change the score every patron is predicting against.
 *
 * 200 updated · 400 bad input · 401 no key · 403 key belongs to another venue
 * 404 no such lane here · 409 the lane is already graded
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ venueId: string; laneId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId, laneId: rawLaneId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const laneId = validateLaneId(rawLaneId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const update = parseUpdate(await parseJsonBody(request));
    const lane = await updateLane(venueId, laneId, update);

    await auditLog(AUDIT_ACTIONS.laneUpdated, undefined, venueId, { laneId, ...update });

    return NextResponse.json(lane, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
