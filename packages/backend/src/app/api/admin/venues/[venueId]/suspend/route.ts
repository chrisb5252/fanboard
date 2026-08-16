import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { parseJsonBody, validateVenueId } from '../../../../../../lib/validators';
import { getVenueState, resumeVenue, suspendVenue } from '../../../../../../services/ops';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/suspend' });
const requireAdmin = adminMiddleware();

/**
 * Stops the venue taking new picks.
 *
 * Deliberately narrow: games keep grading and leaderboards keep settling.
 * Freezing settlement too would punish patrons for an operator's problem —
 * their picks are already made and should still resolve.
 *
 * A reason is required. The field exists so the next person to look knows why
 * a venue is dark, and an optional one would be empty exactly when it matters.
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

    const state = await suspendVenue(venueId, reason);
    await auditLog(AUDIT_ACTIONS.venueSuspended, undefined, venueId, { reason });

    return NextResponse.json(state, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/** Lifts the suspension. Idempotent. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const state = await resumeVenue(venueId);
    await auditLog(AUDIT_ACTIONS.venueResumed, undefined, venueId, {});

    return NextResponse.json(state, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/** Current state, so the dashboard does not have to infer it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    return NextResponse.json(await getVenueState(venueId), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
