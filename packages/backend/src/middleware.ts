import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware: CORS and transport security.
 *
 * This runs on the Edge runtime, which cannot open the TCP sockets pg and redis
 * need. Nothing here authenticates anything — credential checks live in
 * `lib/auth.ts` as route-level guards. What belongs here is exactly what can be
 * decided from the request head alone.
 *
 * The three clients are separate Vite bundles that may be served from their own
 * origins in production, and they authenticate with a cookie. That combination
 * is the reason this file exists: a cookie-bearing cross-origin request is only
 * possible if the server opts into it precisely.
 */

/** Dev origins: backend, admin-web, mobile-web, fire-tv. */
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:3003',
] as const;

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * Origins allowed to send credentialed requests.
 *
 * Production is allowlist-only and comes from configuration; there is no
 * built-in production origin, so a deployment that forgets to set
 * CORS_ALLOWED_ORIGINS refuses every cross-origin browser call rather than
 * silently accepting a wrong one. Failing closed here is the whole point.
 */
export function allowedOrigins(): Set<string> {
  const configured = (process.env['CORS_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return isProduction() ? new Set(configured) : new Set([...DEV_ORIGINS, ...configured]);
}

export function isOriginAllowed(origin: string | null): boolean {
  return origin !== null && allowedOrigins().has(origin);
}

/**
 * Applies the CORS response headers for an allowed origin.
 *
 * The origin is echoed rather than answered with `*`, and not as a nicety: a
 * wildcard is rejected outright by browsers on credentialed requests, so `*`
 * plus a cookie is simply a broken configuration that looks permissive. `Vary:
 * Origin` keeps a shared cache from handing one origin's allowance to another.
 */
function applyCors(headers: Headers, origin: string): void {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
}

const ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, x-display-key';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * Headers applied to every response regardless of origin.
 *
 * HSTS is production-only on purpose. Sending it from a dev server would pin
 * localhost to HTTPS in the developer's browser for the max-age — a sticky,
 * confusing breakage that outlives the process that caused it.
 */
function applySecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');

  if (isProduction()) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * True when the request arrived over plain HTTP behind a TLS-terminating proxy.
 *
 * `request.url` says https even for a proxied plain-HTTP hop, so the forwarded
 * header is the only thing that knows. This is only consulted in production,
 * where a proxy is assumed; trusting it in development would break LAN testing.
 */
function isInsecure(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  return forwardedProto !== null && forwardedProto.split(',')[0]?.trim() === 'http';
}

/**
 * Paths that must answer over plain HTTP even in production.
 *
 * Health probes come from inside the perimeter — the Docker HEALTHCHECK, an
 * ECS or Kubernetes liveness probe, an internal load balancer — and they
 * address the container directly, over http, with no proxy in front to set
 * `x-forwarded-proto: https`.
 *
 * This is not hypothetical tidiness. Next sets `x-forwarded-proto: http` itself
 * on a direct connection, so without this exemption every probe received a 308.
 * A probe that follows no redirects reads that as a failure, the orchestrator
 * concludes the container is dead, and restarts it — forever. The service is
 * healthy and the platform kills it in a loop.
 */
function isProbePath(pathname: string): boolean {
  return pathname === '/api/health';
}

export function middleware(request: NextRequest): NextResponse {
  const origin = request.headers.get('origin');

  if (isProduction() && isInsecure(request) && !isProbePath(new URL(request.url).pathname)) {
    // Redirect rather than serve: a credential sent over plain HTTP is already
    // exposed, and answering the request normally would teach clients that it
    // works. 308 preserves the method and body so a POST is not silently
    // downgraded to a GET on the retry.
    const secureUrl = new URL(request.url);
    secureUrl.protocol = 'https:';
    return NextResponse.redirect(secureUrl, 308);
  }

  const corsAllowed = isOriginAllowed(origin);

  // Preflight is answered here and never reaches a route handler.
  if (request.method === 'OPTIONS') {
    // A preflight from a disallowed origin gets 403 with no CORS headers. The
    // browser blocks the real request either way; this makes the refusal
    // legible in logs instead of looking like a network fault.
    if (!corsAllowed) {
      return new NextResponse(null, { status: 403 });
    }

    const preflight = new NextResponse(null, { status: 204 });
    applyCors(preflight.headers, origin as string);
    preflight.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    preflight.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    preflight.headers.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    applySecurityHeaders(preflight.headers);
    return preflight;
  }

  const response = NextResponse.next();
  applySecurityHeaders(response.headers);

  // A request with no Origin header is not a cross-origin browser request:
  // curl, a server-to-server call, a same-origin navigation. It passes through
  // untouched. Withholding the CORS headers from a disallowed origin is what
  // makes the browser refuse to hand the response to that page's script.
  if (corsAllowed) {
    applyCors(response.headers, origin as string);
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
