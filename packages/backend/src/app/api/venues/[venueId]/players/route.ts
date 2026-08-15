import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_HOURS } from '../../../../../lib/auth';
import {
  PLAYER_SESSIONS_PER_IP,
  PLAYER_SESSIONS_PER_VENUE,
  RATE_LIMIT_WINDOW_MS,
  playerSessionRateKey,
  venueSessionRateKey,
} from '../../../../../lib/cache-keys';
import { toErrorBody } from '../../../../../lib/errors';
import { getClientIpDetailed } from '../../../../../lib/ip-extractor';
import { logger as rootLogger } from '../../../../../lib/logger';
import { recordRateLimitRejection } from '../../../../../lib/rate-limit-monitor';
import { consumeRateLimit, type RateLimitDecision } from '../../../../../lib/rate-limiter';
import { parseJsonBody, validateNickname, validateVenueId } from '../../../../../lib/validators';
import { createPlayerSession } from '../../../../../services/players';
import type { UUID } from '../../../../../lib/validators';

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

function tooManyRequests(decision: RateLimitDecision, scope: string): NextResponse {
  // Retry-After reflects the time actually left in the window rather than a
  // fixed 3600. Telling someone to wait an hour when 90 seconds remain trains
  // them to ignore the header.
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.resetInMs / 1000));

  return NextResponse.json(
    {
      error: {
        code: 'rate_limited',
        message: 'Too many session requests from this location. Try again later.',
        details: { scope, retryAfterSeconds },
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'cache-control': 'no-store',
      },
    },
  );
}

/**
 * Two independent limits, both required.
 *
 * Per IP stops one host bulk-creating sessions. It is not sufficient on its
 * own: an attacker with a botnet, or simply an IPv6 allocation, has as many
 * "distinct clients" as they need. The per-venue ceiling is what bounds the
 * damage in that case, and it is also the only limit that applies at all when
 * no client address can be trusted.
 *
 * Ordering matters. The IP check runs first so a single abusive host is
 * rejected without spending the venue's shared budget — otherwise one attacker
 * could exhaust the venue ceiling and lock out every real patron, turning the
 * rate limiter into the outage it exists to prevent.
 */
async function enforceRateLimits(
  request: Request,
  venueId: UUID,
): Promise<NextResponse | null> {
  const { ip, source } = getClientIpDetailed(request);

  if (ip !== null) {
    const perIp = await consumeRateLimit(
      playerSessionRateKey(venueId, ip),
      PLAYER_SESSIONS_PER_IP,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!perIp.allowed) {
      log.warn('player session rejected by per-IP rate limit', {
        venueId,
        clientIp: ip,
        source,
        count: perIp.count,
        limit: perIp.limit,
      });
      await recordRateLimitRejection({
        venueId,
        clientIp: ip,
        scope: 'ip',
        count: perIp.count,
        limit: perIp.limit,
      });
      return tooManyRequests(perIp, 'ip');
    }
  } else {
    // Not fatal, but it means the per-IP limit is doing nothing at all, and the
    // venue ceiling is carrying the whole load. Almost always a deployment that
    // is not behind the proxy TRUSTED_PROXY_HOPS claims.
    log.error('no trustworthy client IP; per-IP rate limiting is inactive', {
      venueId,
      hint: 'check TRUSTED_PROXY_HOPS and that the proxy sets X-Forwarded-For',
    });
  }

  const perVenue = await consumeRateLimit(
    venueSessionRateKey(venueId),
    PLAYER_SESSIONS_PER_VENUE,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!perVenue.allowed) {
    log.error('player session rejected by per-venue rate limit', {
      venueId,
      count: perVenue.count,
      limit: perVenue.limit,
    });
    await recordRateLimitRejection({
      venueId,
      clientIp: ip,
      scope: 'venue',
      count: perVenue.count,
      limit: perVenue.limit,
    });
    return tooManyRequests(perVenue, 'venue');
  }

  if (perVenue.degraded) {
    log.error('rate limiting degraded: Redis unavailable, requests are unthrottled', { venueId });
  }

  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId } = await params;
    const venueId = validateVenueId(rawVenueId);

    // Before the body is read and before any database work: an abusive caller
    // should cost us one Redis round trip, not a parse and an insert.
    const limited = await enforceRateLimits(request, venueId);
    if (limited !== null) {
      return limited;
    }

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
