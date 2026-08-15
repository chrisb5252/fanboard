import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../lib/auth';
import { toErrorBody } from '../../../../../../lib/errors';
import { validateEnabledLeagues } from '../../../../../../lib/leagues';
import { logger as rootLogger } from '../../../../../../lib/logger';
import { parseJsonBody, validateVenueId } from '../../../../../../lib/validators';
import { getVenueConfig, setVenueConfig } from '../../../../../../services/admin';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/config' });

const requireAdmin = adminMiddleware();

/**
 * Replaces the venue's enabled leagues.
 *
 * The previous value is read first so the audit entry records a before/after
 * rather than just the new state -- "who turned NBA off" is the question this
 * trail exists to answer, and the new value alone cannot answer it.
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
    const enabledLeagues = validateEnabledLeagues(body['enabledLeagues']);

    const previous = await getVenueConfig(venueId);
    const updated = await setVenueConfig(venueId, enabledLeagues);

    await auditLog(AUDIT_ACTIONS.venueConfigUpdated, undefined, venueId, {
      before: previous.enabledLeagues,
      after: updated.enabledLeagues,
    });

    log.info('venue config updated', {
      venueId,
      before: previous.enabledLeagues,
      after: updated.enabledLeagues,
    });

    return NextResponse.json(
      { venueId: updated.venueId, enabledLeagues: updated.enabledLeagues },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}

/** Reading the current configuration, so admin-web does not have to guess it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const config = await getVenueConfig(venueId);

    return NextResponse.json(
      { venueId: config.venueId, enabledLeagues: config.enabledLeagues },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
