import { NextResponse } from 'next/server';
import { readAuditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { validateLimit, validateVenueId } from '../../../../../../lib/validators';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/admin/venues/[venueId]/audit-log' });
const requireAdmin = adminMiddleware();

const AUDIT_LIMIT_DEFAULT = 100;
const AUDIT_LIMIT_MAX = 500;

/**
 * Privileged actions taken against this venue, newest first.
 *
 * Venue-scoped like every other admin read, so one operator cannot read
 * another venue's history. Details were redacted on write, so nothing here can
 * contain a credential even if a caller passed a whole request body.
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

    const limit = validateLimit(
      new URL(request.url).searchParams.get('limit'),
      AUDIT_LIMIT_DEFAULT,
      AUDIT_LIMIT_MAX,
    );

    const entries = await readAuditLog(venueId, limit);

    return NextResponse.json(entries, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
