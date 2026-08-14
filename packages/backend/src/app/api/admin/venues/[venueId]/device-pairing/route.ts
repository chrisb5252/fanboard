import { NextResponse } from 'next/server';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import {
  parseJsonBody,
  validateDisplayName,
  validateFireTvDeviceId,
  validateVenueId,
} from '../../../../../../lib/validators';
import { pairDevice } from '../../../../../../services/devices';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'POST /api/admin/venues/[venueId]/device-pairing' });

const requireAdmin = adminMiddleware();

/**
 * Pairs a Fire TV to a venue and issues its display key.
 *
 * The display key is returned in this response and nowhere else, ever: only its
 * SHA-256 hash is stored, so it cannot be re-read, re-sent, or recovered from a
 * database dump. Losing it means re-pairing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    // The api_key authenticates a venue; it must be *this* venue.
    assertVenueScope(admin, venueId);

    const body = await parseJsonBody(request);
    const displayName = validateDisplayName(body['displayName']);
    const fireTvDeviceId = validateFireTvDeviceId(body['fireTvDeviceId']);

    const device = await pairDevice({ venueId, displayName, fireTvDeviceId });

    // The device id and name are safe to log. The key is not, and is not logged.
    log.info('device paired', { venueId, deviceId: device.deviceId, displayName });

    return NextResponse.json(
      {
        deviceId: device.deviceId,
        displayKey: device.displayKey,
        displayName: device.displayName,
      },
      {
        status: 201,
        // Belt and braces: this body contains a credential, so forbid any
        // intermediary from retaining it.
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
