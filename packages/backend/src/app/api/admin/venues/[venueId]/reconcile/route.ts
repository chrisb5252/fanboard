import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { validatePeriod } from '../../../../../../lib/leaderboard';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { parseJsonBody, validateOptionalUuid, validateVenueId } from '../../../../../../lib/validators';
import { reconcilePlayer } from '../../../../../../services/ops';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/reconcile' });
const requireAdmin = adminMiddleware();

/**
 * Checks one player's board entry against their actual picks, and repairs it.
 *
 * The answer is derived two independent ways — counted from the picks, and read
 * from the materialised snapshot — because comparing a derived value against
 * itself proves nothing.
 *
 * The response says whether the repair *worked*, not merely that one was
 * attempted. If rematerialising does not reconcile them the problem is not a
 * stale board, and an operator needs to know that rather than be told it was
 * handled.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const body = await parseJsonBody(request);
    const playerSessionId = validateOptionalUuid('playerSessionId', body['playerSessionId']);
    if (playerSessionId === undefined) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: 'playerSessionId is required',
            details: { field: 'playerSessionId' },
          },
        },
        { status: 400 },
      );
    }

    const period = validatePeriod(body['period'] ?? 'all_time');
    const outcome = await reconcilePlayer(venueId, playerSessionId, period);

    await auditLog(AUDIT_ACTIONS.playerReconciled, undefined, venueId, {
      playerSessionId,
      period,
      mismatch: outcome.mismatch,
      repaired: outcome.repaired,
    });

    // 200 even on an unrepaired mismatch: the check itself succeeded, and the
    // body says what it found. A 500 here would suggest the endpoint is broken
    // rather than the data.
    return NextResponse.json(outcome, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
