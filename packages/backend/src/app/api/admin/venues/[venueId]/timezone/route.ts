import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { parseJsonBody, validateVenueId } from '../../../../../../lib/validators';
import { getVenueConfig, setVenueTimezone } from '../../../../../../services/admin';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/timezone' });
const requireAdmin = adminMiddleware();

const MAX_TIMEZONE_LENGTH = 64;

/**
 * Sets the venue's day boundary.
 *
 * This decides when "today's games" and the daily leaderboard roll over. Left
 * at the UTC default, an American venue's day turns at 8pm local — so an 8:10pm
 * kick-off counts as tomorrow and drops off the pickable list mid-service. Set
 * it once, when the venue is onboarded.
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
    const timezone = typeof body['timezone'] === 'string' ? body['timezone'].trim() : '';

    if (timezone === '' || timezone.length > MAX_TIMEZONE_LENGTH) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: 'timezone is required, e.g. America/New_York',
            details: { field: 'timezone' },
          },
        },
        { status: 400 },
      );
    }

    const before = await getVenueConfig(venueId);
    const updated = await setVenueTimezone(venueId, timezone);

    // Before and after, because "who moved the venue's day?" is exactly the
    // question this trail exists to answer, and the new value alone cannot.
    await auditLog(AUDIT_ACTIONS.venueTimezoneUpdated, undefined, venueId, {
      before: before.timezone,
      after: updated.timezone,
    });

    log.info('venue timezone updated', {
      venueId,
      before: before.timezone,
      after: updated.timezone,
    });

    return NextResponse.json(updated, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/** Current setting, so a dashboard does not have to guess it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    return NextResponse.json(await getVenueConfig(venueId), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
