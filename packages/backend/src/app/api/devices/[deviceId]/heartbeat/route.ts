import { NextResponse } from 'next/server';
import { assertDeviceScope, deviceMiddleware } from '../../../../../lib/auth';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { validateDeviceId } from '../../../../../lib/validators';
import { recordHeartbeat } from '../../../../../services/devices';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'POST /api/devices/[deviceId]/heartbeat' });

const requireDevice = deviceMiddleware();

/**
 * "I'm alive." Called by the Fire TV app every 30 seconds.
 *
 * This is the one write a display key can perform, and the security rule it
 * lives under is narrower than "devices never write": a display may stamp its
 * own liveness column and nothing else. It touches no game, pick, player or
 * venue row, and it is scoped by the device id the key authenticated as, so a
 * key cannot mark a different display alive.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
): Promise<NextResponse> {
  try {
    const { deviceId: rawDeviceId } = await params;
    const deviceId = validateDeviceId(rawDeviceId);

    const device = await requireDevice(request);
    assertDeviceScope(device, deviceId);

    await recordHeartbeat(deviceId);

    return NextResponse.json(
      { ok: true },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
