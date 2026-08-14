import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer credential handling.
 *
 * Every credential column in the schema (player_sessions.session_token,
 * venues.api_key, devices.display_key) stores a SHA-256 *hash*, never the raw
 * value. A leaked database dump, an over-broad SELECT in a log, or a future SQL
 * injection then yields hashes rather than working credentials.
 *
 * SHA-256 without a salt or work factor is the right primitive here, unlike for
 * passwords: these are high-entropy random values, so there is no dictionary to
 * run and no reason to make verification slow. The one exception is
 * devices.display_key — see the note on that in the auth module.
 */

/** 256 bits, url-safe. */
const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** Stable, lower-case hex SHA-256. This is what goes in the database. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for two hex digests.
 *
 * Lookups here are by indexed equality on an already-hashed value, so this is
 * belt and braces rather than the primary defence.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
