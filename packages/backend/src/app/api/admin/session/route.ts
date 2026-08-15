import { NextResponse } from 'next/server';
import { adminMiddleware } from '../../../../lib/auth';
import { toErrorBody } from '../../../../lib/errors';
import { logger as rootLogger } from '../../../../lib/logger';
import { getVenueSummary } from '../../../../services/admin';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/admin/session' });

const requireAdmin = adminMiddleware();

/**
 * Resolves an API key to the venue it belongs to.
 *
 * Note there is no `:venueId` in this path, deliberately: the key *is* the
 * venue identity, and every other admin route needs a venue id the holder of a
 * fresh key has no way to know. This is also the only place an admin can read
 * the venue's own name.
 *
 * Doubles as the credential check at sign-in — a 200 means the key is good.
 * Returns nothing an authenticated caller could not already read.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin(request);
    const venue = await getVenueSummary(admin.venueId);

    return NextResponse.json(
      { venueId: venue.venueId, name: venue.name, enabledLeagues: venue.enabledLeagues },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
