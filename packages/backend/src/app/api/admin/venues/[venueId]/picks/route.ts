import { NextResponse } from 'next/server';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { ApiError, toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import {
  validateOptionalUuid,
  validateVenueId,
} from '../../../../../../lib/validators';
import {
  PICK_INSPECTOR_LIMIT,
  PICK_STATUSES,
  listPicks,
  type PickStatusFilter,
} from '../../../../../../services/admin';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/admin/venues/[venueId]/picks' });

const requireAdmin = adminMiddleware();

function validateStatus(value: string | null): PickStatusFilter | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  if (!(PICK_STATUSES as readonly string[]).includes(value)) {
    throw ApiError.badRequest(`status must be one of: ${PICK_STATUSES.join(', ')}`, {
      field: 'status',
    });
  }
  return value as PickStatusFilter;
}

/**
 * Pick inspector, for debugging grading.
 *
 * `status=pending` means graded_at IS NULL, not points IS NULL. A voided pick
 * from a cancelled game has NULL points but is finished; classifying it as
 * pending would send an operator hunting a grading bug that is not there.
 * `status=voided` isolates exactly those.
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
    const gameId = validateOptionalUuid('gameId', query.get('gameId'));
    const playerId = validateOptionalUuid('playerId', query.get('playerId'));
    const status = validateStatus(query.get('status'));

    const picks = await listPicks(venueId, {
      ...(gameId === undefined ? {} : { gameId }),
      ...(playerId === undefined ? {} : { playerId }),
      ...(status === undefined ? {} : { status }),
    });

    return NextResponse.json(picks, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        // Says whether the 1000-row ceiling truncated the answer.
        'x-result-limit': String(PICK_INSPECTOR_LIMIT),
        'x-truncated': String(picks.length >= PICK_INSPECTOR_LIMIT),
      },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
