import type { SqlExecutor } from './db';
import { sql as defaultSql } from './db';
import { ApiError } from './errors';
import { logger as rootLogger } from './logger';
import { hashToken } from './tokens';
import { trustedUuid, type UUID } from './validators';

/**
 * Request authentication for the three caller types.
 *
 * These are NOT Next.js middleware. Real Next middleware (`middleware.ts`) runs
 * on the Edge runtime, which cannot open the TCP sockets that pg and redis
 * need, so a credential check there would have nothing to check against. These
 * are route-level guards: call one at the top of a handler, get either a
 * verified context or an ApiError.
 *
 * Every lookup hashes the presented credential and matches on the hash, so the
 * database never holds a usable bearer token.
 */

export const SESSION_COOKIE_NAME = 'session_token';

/**
 * How long a session may sit idle before it stops authenticating. Enforced in
 * SQL against last_seen_at so it cannot be bypassed by a stale cookie.
 */
export const SESSION_IDLE_TIMEOUT_HOURS = 12;

export interface SessionContext {
  readonly playerSessionId: UUID;
  readonly venueId: UUID;
  readonly nickname: string;
}

export interface AdminContext {
  readonly venueId: UUID;
}

export interface DeviceContext {
  readonly deviceId: UUID;
  readonly venueId: UUID;
}

export interface AuthDeps {
  db: SqlExecutor;
}

export type Guard<T> = (request: Request) => Promise<T>;

function resolveDeps(deps?: Partial<AuthDeps>): AuthDeps {
  return { db: deps?.db ?? defaultSql };
}

/**
 * Minimal RFC 6265 cookie-header parser.
 *
 * Reading the raw header rather than next/headers keeps these guards callable
 * with a plain `Request`, which is what makes them testable without booting a
 * server.
 */
export function parseCookieHeader(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === null) {
    return jar;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (name !== '' && !jar.has(name)) {
      try {
        jar.set(name, decodeURIComponent(value));
      } catch {
        // A malformed percent-escape is not a reason to 500.
        jar.set(name, value);
      }
    }
  }

  return jar;
}

/** Extracts a bearer credential from an Authorization header. */
export function parseBearer(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

/**
 * Verifies the session cookie and refreshes last_seen_at in the same statement.
 *
 * Doing both at once is what makes the idle timeout race-free: there is no
 * window between "this session is still live" and "mark it used" in which a
 * concurrent request could observe a different answer.
 */
export function sessionMiddleware(deps?: Partial<AuthDeps>): Guard<SessionContext> {
  const { db } = resolveDeps(deps);

  return async (request: Request): Promise<SessionContext> => {
    const presented = parseCookieHeader(request.headers.get('cookie')).get(SESSION_COOKIE_NAME);
    if (presented === undefined || presented === '') {
      throw ApiError.unauthorized('No session cookie');
    }

    const result = await db.query<{ id: string; venue_id: string; nickname: string }>(
      `UPDATE player_sessions
          SET last_seen_at = NOW()
        WHERE session_token = $1
          AND expired = FALSE
          AND expires_at > NOW()
          AND last_seen_at > NOW() - make_interval(hours => $2::int)
        RETURNING id, venue_id, nickname`,
      [hashToken(presented), SESSION_IDLE_TIMEOUT_HOURS],
    );

    const row = result.rows[0];
    if (row === undefined) {
      // One message for "no such token", "expired" and "idle too long": telling
      // them apart would let a caller probe which tokens exist.
      throw ApiError.unauthorized('Session is invalid or has expired');
    }

    return {
      playerSessionId: trustedUuid(row.id),
      venueId: trustedUuid(row.venue_id),
      nickname: row.nickname,
    };
  };
}

/**
 * Verifies a venue API key presented as `Authorization: Bearer <key>`.
 *
 * A key that has just been rotated away from is still accepted until its grace
 * window closes. Without that, rotation would sever every live client the
 * instant it ran, and an operator who learns that once never rotates again.
 * See `services/api-keys.ts`.
 */
export function adminMiddleware(deps?: Partial<AuthDeps>): Guard<AdminContext> {
  const { db } = resolveDeps(deps);

  return async (request: Request): Promise<AdminContext> => {
    const presented = parseBearer(request.headers.get('authorization'));
    if (presented === null) {
      throw ApiError.unauthorized('Missing Authorization: Bearer <api_key>');
    }

    // The window is evaluated against the database clock in the same statement
    // that matches the key, for the same reason the pick path does it: no gap
    // in which a expiring credential could be observed two different ways. A
    // key past its window matches nothing and fails exactly like an unknown one.
    const result = await db.query<{ id: string; via_previous: boolean }>(
      `SELECT id, (api_key <> $1) AS via_previous
         FROM venues
        WHERE api_key = $1
           OR (previous_api_key = $1 AND previous_api_key_expires_at > NOW())`,
      [hashToken(presented)],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw ApiError.unauthorized('Invalid API key');
    }

    if (row.via_previous) {
      // Surfaced so an operator can see whether anything is still on the old
      // key before the window closes underneath it.
      rootLogger.warn('venue authenticated with a superseded API key', {
        component: 'auth',
        venueId: row.id,
      });
    }

    return { venueId: trustedUuid(row.id) };
  };
}

/**
 * Verifies a display pairing key presented as `x-display-key`.
 *
 * Note on strength: unlike the other two credentials, a display key is a short
 * code a human reads off a TV, so hashing buys less here — a 6-character code
 * is brute-forceable offline from a stolen hash. The real fix is to exchange
 * the pairing code for a long-lived random device token during pairing and stop
 * accepting the code afterwards. That belongs with the pairing endpoint, which
 * does not exist yet.
 */
export function deviceMiddleware(deps?: Partial<AuthDeps>): Guard<DeviceContext> {
  const { db } = resolveDeps(deps);

  return async (request: Request): Promise<DeviceContext> => {
    const presented = request.headers.get('x-display-key')?.trim();
    if (presented === undefined || presented === '') {
      throw ApiError.unauthorized('Missing x-display-key header');
    }

    const result = await db.query<{ id: string; venue_id: string }>(
      'SELECT id, venue_id FROM devices WHERE display_key = $1',
      [hashToken(presented)],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw ApiError.unauthorized('Invalid display key');
    }

    return { deviceId: trustedUuid(row.id), venueId: trustedUuid(row.venue_id) };
  };
}

/**
 * Rejects a session that authenticated against a different venue than the one
 * in the route.
 *
 * Without this, a valid player at venue A could act on venue B simply by
 * changing the URL: the cookie would still verify, and every downstream query
 * would be scoped to the venue the *caller* named.
 */
export function assertVenueScope(context: { venueId: UUID }, routeVenueId: UUID): void {
  if (context.venueId !== routeVenueId) {
    throw ApiError.forbidden('Session does not belong to this venue');
  }
}

/**
 * Rejects a display key being used against a device other than its own.
 *
 * The device id in the path is redundant with the one the key authenticated as,
 * and that redundancy is the risk: without this, a paired display could read any
 * other display's payload by editing the URL. 404 rather than 403, so the
 * response cannot be used to enumerate which device ids exist.
 */
export function assertDeviceScope(context: DeviceContext, routeDeviceId: UUID): void {
  if (context.deviceId !== routeDeviceId) {
    throw ApiError.notFound('Device not found');
  }
}
