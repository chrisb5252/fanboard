import { NextResponse } from 'next/server';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { validateVenueId } from '../../../../../../lib/validators';
import { listDeviceStatus } from '../../../../../../services/devices';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/admin/venues/[venueId]/device-status' });

const requireAdmin = adminMiddleware();

/**
 * Which displays at this venue are alive.
 *
 * Online is decided in SQL against the database clock, so an operator's laptop
 * being wrong about the time cannot make a dead display look healthy.
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

    const devices = await listDeviceStatus(venueId);

    return NextResponse.json(devices, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
