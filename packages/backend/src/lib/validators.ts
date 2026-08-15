import { z } from 'zod';
import { ApiError } from './errors';

declare const uuidBrand: unique symbol;

/**
 * A string that has been through UUID validation.
 *
 * Branded so an unvalidated string cannot be passed where an id is expected —
 * the compiler enforces that every id reaching a query has been checked.
 */
export type UUID = string & { readonly [uuidBrand]: true };

/**
 * Deliberately permissive about version and variant nibbles: this must accept
 * exactly what PostgreSQL's own `uuid` type accepts, and Postgres does not care
 * which RFC version the value claims to be. A stricter v4-only pattern would
 * reject legitimate ids (and every hand-written fixture).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUID');

export const PREDICTED_WINNERS = ['home', 'away'] as const;
export type PredictedWinner = (typeof PREDICTED_WINNERS)[number];

const predictedWinnerSchema = z.enum(PREDICTED_WINNERS);

export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 30;

/**
 * Names that would let a patron pass themselves off as staff on the TV.
 *
 * Matched as standalone words, not substrings. A substring match rejects
 * "Badminton" (which contains "admin") and other ordinary words, and a
 * validator that refuses legitimate names trains people to fight it.
 *
 * This is deterrence, not prevention: "admin1" still passes. Actually stopping
 * impersonation needs a visual marker on the leaderboard for real staff, which
 * a nickname rule cannot substitute for.
 */
const RESERVED_WORDS =
  /\b(?:admin|administrator|moderator|system|root|staff|fanboard)\b/iu;

/** Long digit runs are the signature of generated spam handles. */
const DIGIT_RUN = /\d{5,}/u;

/** Six or more of the same character in a row. */
const REPEATED_RUN = /(.)\1{5,}/u;

const ONLY_DIGITS = /^\d+$/u;

/**
 * Nickname whitelist: letters and digits in any script, plus spaces and a small
 * set of joiners. A whitelist (rather than a blacklist of "special characters")
 * is what keeps control characters, zero-width joiners, bidi overrides and
 * markup out — none of those fall in \p{L} or \p{N}.
 */
const NICKNAME_ALLOWED = /^[\p{L}\p{N} '._-]+$/u;
/** Must carry at least one letter or digit, so "---" is not a nickname. */
const NICKNAME_HAS_SUBSTANCE = /[\p{L}\p{N}]/u;

function fail(field: string, message: string): never {
  throw ApiError.badRequest(`${field} ${message}`, { field });
}

function parseUuid(field: string, value: unknown): UUID {
  const result = uuidSchema.safeParse(value);
  if (!result.success) {
    fail(field, 'must be a UUID');
  }
  return result.data.toLowerCase() as UUID;
}

export function validateVenueId(id: unknown): UUID {
  return parseUuid('venueId', id);
}

export function validateGameId(id: unknown): UUID {
  return parseUuid('gameId', id);
}

export function validatePlayerSessionId(id: unknown): UUID {
  return parseUuid('playerSessionId', id);
}

export function validateDeviceId(id: unknown): UUID {
  return parseUuid('deviceId', id);
}

export const DISPLAY_NAME_MAX_LENGTH = 64;
export const FIRE_TV_DEVICE_ID_MAX_LENGTH = 128;

/** Same whitelist rationale as nicknames: this is rendered on an operator screen. */
const DISPLAY_NAME_ALLOWED = /^[\p{L}\p{N} '._#()/-]+$/u;

export function validateDisplayName(name: unknown): string {
  if (typeof name !== 'string') {
    fail('displayName', 'must be a string');
  }
  const normalized = name.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (normalized.length === 0) {
    fail('displayName', 'must not be empty');
  }
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    fail('displayName', `must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  if (!DISPLAY_NAME_ALLOWED.test(normalized)) {
    fail('displayName', 'contains unsupported characters');
  }
  return normalized;
}

/**
 * Hardware identifier reported by the Fire TV app. Opaque to us, so the rule is
 * only that it is printable ASCII of a sane length -- enough to keep control
 * characters out of the uniqueness key without guessing Amazon's format.
 */
const FIRE_TV_DEVICE_ID_ALLOWED = /^[A-Za-z0-9._:-]+$/;

export function validateFireTvDeviceId(id: unknown): string {
  if (typeof id !== 'string') {
    fail('fireTvDeviceId', 'must be a string');
  }
  const trimmed = id.trim();

  if (trimmed.length === 0) {
    fail('fireTvDeviceId', 'must not be empty');
  }
  if (trimmed.length > FIRE_TV_DEVICE_ID_MAX_LENGTH) {
    fail('fireTvDeviceId', `must be at most ${FIRE_TV_DEVICE_ID_MAX_LENGTH} characters`);
  }
  if (!FIRE_TV_DEVICE_ID_ALLOWED.test(trimmed)) {
    fail('fireTvDeviceId', 'may only contain letters, numbers and . _ : -');
  }
  return trimmed;
}

export function validatePredictedWinner(winner: unknown): PredictedWinner {
  const result = predictedWinnerSchema.safeParse(winner);
  if (!result.success) {
    fail('predictedWinner', `must be one of: ${PREDICTED_WINNERS.join(', ')}`);
  }
  return result.data;
}

/**
 * Normalises then validates a nickname.
 *
 * Normalisation runs first and is part of the security boundary:
 *  - NFC folds combining-character sequences that would otherwise render
 *    identically to an existing nickname while comparing as distinct;
 *  - internal whitespace is collapsed so "a      b" cannot be used to shove a
 *    name across a TV leaderboard.
 *
 * The 50-character ceiling matches the player_sessions_nickname_check
 * constraint. If the two ever drift, an over-long nickname stops being a clean
 * 400 and becomes a constraint violation surfaced as a 500.
 */
export function validateNickname(nick: unknown): string {
  if (typeof nick !== 'string') {
    fail('nickname', 'must be a string');
  }

  const normalized = nick.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (normalized.length === 0) {
    fail('nickname', 'must not be empty');
  }
  if (normalized.length < NICKNAME_MIN_LENGTH) {
    fail('nickname', `must be at least ${NICKNAME_MIN_LENGTH} characters`);
  }
  if (normalized.length > NICKNAME_MAX_LENGTH) {
    fail('nickname', `must be at most ${NICKNAME_MAX_LENGTH} characters`);
  }
  if (!NICKNAME_ALLOWED.test(normalized)) {
    fail('nickname', 'may only contain letters, numbers, spaces and . _ - \'');
  }
  if (!NICKNAME_HAS_SUBSTANCE.test(normalized)) {
    fail('nickname', 'must contain at least one letter or number');
  }
  if (ONLY_DIGITS.test(normalized)) {
    fail('nickname', 'cannot be only numbers');
  }
  if (DIGIT_RUN.test(normalized)) {
    fail('nickname', 'cannot contain long runs of digits');
  }
  if (REPEATED_RUN.test(normalized)) {
    fail('nickname', 'has too many repeated characters');
  }
  if (RESERVED_WORDS.test(normalized)) {
    fail('nickname', 'uses a reserved word');
  }

  return normalized;
}

/**
 * Optional UUID query parameter. Absent means "no filter"; present but
 * malformed is a 400 rather than a silently ignored filter, which would return
 * a superset of what the caller asked for.
 */
export function validateOptionalUuid(field: string, value: unknown): UUID | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return parseUuid(field, value);
}

/**
 * Parses a non-negative integer query parameter.
 *
 * Rejects "50abc" and "1e3" rather than accepting what parseInt would salvage:
 * a limit the caller did not write is a limit they cannot reason about.
 */
function parseNonNegativeInt(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail(field, 'must be a number');
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    fail(field, 'must be a non-negative integer');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    fail(field, 'is out of range');
  }
  return parsed;
}

/** Clamps rather than rejects an over-large limit: the cap is the contract. */
export function validateLimit(value: unknown, fallback: number, max: number): number {
  const parsed = parseNonNegativeInt('limit', value);
  if (parsed === undefined) {
    return fallback;
  }
  if (parsed === 0) {
    fail('limit', 'must be at least 1');
  }
  return Math.min(parsed, max);
}

export function validateOffset(value: unknown): number {
  return parseNonNegativeInt('offset', value) ?? 0;
}

/**
 * Asserts a value that is already known to be a UUID — ids read back out of the
 * database, which the `uuid` column type has already guaranteed.
 *
 * Never call this on anything that came from a request.
 */
export function trustedUuid(value: string): UUID {
  return value as UUID;
}

/** Parses a JSON request body, turning malformed JSON into a clean 400. */
export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON');
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('Request body must be a JSON object');
  }

  return raw as Record<string, unknown>;
}
