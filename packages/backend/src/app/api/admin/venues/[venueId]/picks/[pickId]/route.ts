import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../../lib/errors';
import { computeLeaderboard } from '../../../../../../../lib/leaderboard';
import { logger as rootLogger } from '../../../../../../../lib/logger';
import { parseJsonBody, validateVenueId, validateOptionalUuid } from '../../../../../../../lib/validators';
import { inspectPick, voidPick } from '../../../../../../../services/ops';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/picks/[pickId]' });
const requireAdmin = adminMiddleware();

/** Validates the pick id from the path with the same rules as any other uuid. */
function pickIdFrom(raw: string): ReturnType<typeof validateOptionalUuid> {
  const parsed = validateOptionalUuid('pickId', raw);
  return parsed;
}

/**
 * Everything about one pick, its game and its player, in a single response.
 *
 * This is the "why does this look wrong?" endpoint. It reports the pick's state
 * as a word — ungraded, graded, voided — rather than leaving an operator to
 * work it out from a null `correct` and a non-null `graded_at`, which is the
 * distinction people get backwards under pressure.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string; pickId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId, pickId: rawPickId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const pickId = pickIdFrom(rawPickId);
    if (pickId === undefined) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'pickId must be a UUID' } },
        { status: 400 },
      );
    }

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    return NextResponse.json(await inspectPick(pickId, venueId), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/**
 * Voids a pick: finished with, counting as neither a win nor a loss.
 *
 * The board is rematerialised straight afterwards rather than waiting for the
 * five minute worker, because the reason anyone voids a pick is that the TV is
 * currently showing something wrong in front of people.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ venueId: string; pickId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId, pickId: rawPickId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const pickId = pickIdFrom(rawPickId);
    if (pickId === undefined) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'pickId must be a UUID' } },
        { status: 400 },
      );
    }

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const body = await parseJsonBody(request).catch(() => ({}) as Record<string, unknown>);
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (reason === '' || reason.length > 500) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A reason of 1-500 characters is required',
            details: { field: 'reason' },
          },
        },
        { status: 400 },
      );
    }

    // Confirms the pick belongs to this venue before mutating it; voidPick
    // itself is keyed only by pick id.
    await inspectPick(pickId, venueId);

    const outcome = await voidPick(pickId);
    await auditLog(AUDIT_ACTIONS.pickVoided, undefined, venueId, {
      pickId,
      reason,
      alreadyVoid: outcome.alreadyVoid,
    });

    const board = await computeLeaderboard(venueId, 'all_time');

    return NextResponse.json(
      {
        pickId: outcome.pickId,
        playerSessionId: outcome.playerSessionId,
        state: 'voided',
        alreadyVoid: outcome.alreadyVoid,
        leaderboardEntries: board.length,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
