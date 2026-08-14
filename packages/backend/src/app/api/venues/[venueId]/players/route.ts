import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_HOURS } from '../../../../../lib/auth';
import { toErrorBody } from '../../../../../lib/errors';
import { logger as rootLogger } from '../../../../../lib/logger';
import { parseJsonBody, validateNickname, validateVenueId } from '../../../../../lib/validators';
import { createPlayerSession } from '../../../../../services/players';

/** Never prerender or cache: this mints a credential. */
export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'POST /api/venues/[venueId]/players' });

/**
 * Cookies are Secure by default.
 *
 * The escape hatch exists because the patron app is served over the venue LAN,
 * where a deployment may not have TLS — and a Secure cookie is simply never
 * sent over plain http, which breaks the app silently rather than loudly.
 * Opting out is a deliberate, logged decision, not a default.
 */
function cookieIsSecure(): boolean {
  return process.env['COOKIE_SECURE'] !== 'false';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    const body = await parseJsonBody(request);
    const nickname = validateNickname(body['nickname']);

    const session = await createPlayerSession({ venueId, nickname });

    const response = NextResponse.json(
      { playerId: session.playerId, nickname: session.nickname },
      { status: 201 },
    );

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: session.sessionToken,
      httpOnly: true,
      secure: cookieIsSecure(),
      // Lax, not Strict: the patron arrives by scanning a QR code, and Strict
      // would withhold the cookie on that first cross-site navigation. Lax
      // still withholds it on cross-site POSTs, which is the CSRF case here.
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_IDLE_TIMEOUT_HOURS * 60 * 60,
    });

    // The player id is safe to log; the token is not, and is never logged.
    log.info('player session created', { venueId, playerId: session.playerId });

    return response;
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
