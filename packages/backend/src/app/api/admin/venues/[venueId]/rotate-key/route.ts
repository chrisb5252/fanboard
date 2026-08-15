import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { validateVenueId } from '../../../../../../lib/validators';
import {
  API_KEY_GRACE_PERIOD_HOURS,
  revokePreviousApiKey,
  rotateApiKey,
} from '../../../../../../services/api-keys';

/** Never prerender or cache: this mints a credential. */
export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/rotate-key' });

const requireAdmin = adminMiddleware();

/**
 * Issues a new API key for the venue.
 *
 * Authenticated with the key being replaced, which is the point: possession of
 * the current credential is the authority to roll it. The old key keeps working
 * for a grace window so clients can be updated without an outage — see
 * `services/api-keys.ts` for why that matters more than it looks.
 *
 * The new key is in the response body and nowhere else. It is not logged, not
 * written to the audit trail, and cannot be read back afterwards; only its hash
 * is stored. If the operator loses it during the grace window they can rotate
 * again with the old key, and after the window an operator with database access
 * has to provision one.
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

    const rotation = await rotateApiKey(venueId);

    // Records that a rotation happened and when the old key dies. The key
    // itself is deliberately absent — an audit trail that contains working
    // credentials is a liability, not a control.
    await auditLog(AUDIT_ACTIONS.apiKeyRotated, undefined, venueId, {
      previousKeyExpiresAt: rotation.previousKeyExpiresAt,
      graceHours: API_KEY_GRACE_PERIOD_HOURS,
    });

    log.info('venue api key rotated', { venueId });

    return NextResponse.json(
      {
        apiKey: rotation.apiKey,
        previousKeyExpiresAt: rotation.previousKeyExpiresAt,
        graceHours: API_KEY_GRACE_PERIOD_HOURS,
        warning: 'Store this key now. It cannot be retrieved again.',
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/**
 * Ends the grace window immediately, disabling the superseded key.
 *
 * The compromise path: rotate, then revoke as soon as your own clients are
 * updated, rather than leaving a key you no longer trust alive for a day.
 *
 * DELETE rather than another POST because it removes a credential's validity,
 * and it is idempotent — running it twice is not an error, which is what you
 * want from someone acting under pressure.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const outcome = await revokePreviousApiKey(venueId);

    await auditLog(AUDIT_ACTIONS.apiKeyPreviousRevoked, undefined, venueId, {
      hadPreviousKey: outcome.revoked,
    });

    log.info('previous venue api key revoked', { venueId, hadPrevious: outcome.revoked });

    return NextResponse.json(
      { revoked: outcome.revoked },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
