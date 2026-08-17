import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { validateVenueId } from '../../../../../../lib/validators';
import { listLanes, provisionLanes } from '../../../../../../services/bowling';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/lanes' });
const requireAdmin = adminMiddleware();

/**
 * The operator's view of the lanes, including the graded ones the public list
 * still shows but which are no longer actionable.
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

    return NextResponse.json(await listLanes(venueId), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/**
 * Creates the venue's lanes, numbered 1..num_lanes.
 *
 * This is provisioning, not venue creation — a venue is inserted by an operator
 * with database access (see DEPLOYMENT.md), because a public endpoint that
 * mints venues would also mint the API keys that authenticate them. Once the
 * venue exists and carries a lane count, this fills in its lanes.
 *
 * Safe to call twice. It adds only the lanes that are missing, so raising
 * num_lanes after an expansion is this same call again rather than a migration.
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

    const result = await provisionLanes(venueId);

    await auditLog(AUDIT_ACTIONS.lanesProvisioned, undefined, venueId, result);

    return NextResponse.json(
      { ...result, lanes: await listLanes(venueId) },
      { status: result.created > 0 ? 201 : 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
