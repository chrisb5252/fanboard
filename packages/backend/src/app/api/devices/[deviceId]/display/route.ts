import { NextResponse } from 'next/server';
import { assertDeviceScope, deviceMiddleware } from '../../../../../lib/auth';
import { DISPLAY_TTL_SECONDS } from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { validateDeviceId } from '../../../../../lib/validators';
import { getDisplayPayload } from '../../../../../services/display';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/devices/[deviceId]/display' });

const requireDevice = deviceMiddleware();

/**
 * Everything the Fire TV renders, in one request.
 *
 * Read-only, and scoped three ways: the display key authenticates the device,
 * the device id in the path must be that same device, and every query is
 * filtered by the venue the key resolved to. A key cannot reach another
 * display, another venue, or anything an operator would consider private.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
): Promise<NextResponse> {
  try {
    const { deviceId: rawDeviceId } = await params;
    const deviceId = validateDeviceId(rawDeviceId);

    const device = await requireDevice(request);
    assertDeviceScope(device, deviceId);

    // venueId comes from the statement that verified the key, not from a
    // cached mapping, so it cannot be stale relative to the credential.
    const { payload, cached } = await getDisplayPayload(deviceId, device.venueId);

    return NextResponse.json(payload, {
      status: 200,
      headers: {
        'x-cache': cached ? 'HIT' : 'MISS',
        // Private: the payload is venue-specific and authenticated.
        'cache-control': `private, max-age=${DISPLAY_TTL_SECONDS}`,
      },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
