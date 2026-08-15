import { randomBytes } from 'node:crypto';
import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import { logger as rootLogger, type Logger } from '../lib/logger';
import { hashToken } from '../lib/tokens';
import type { UUID } from '../lib/validators';

/**
 * Venue API key rotation.
 *
 * Rotation is only useful if operators will actually do it, and they will not
 * if it causes an outage. A single-column key swap breaks every running client
 * the instant it is written — the admin dashboard, any integration, the
 * operator's own curl script — so in practice the key never gets rotated and
 * the credential lives forever.
 *
 * So rotation issues a new key and keeps the old one working for a bounded
 * grace window. The operator updates their clients at their own pace, and the
 * old key stops working on its own. For the case where the old key is believed
 * to be in someone else's hands, `revokePreviousApiKey` ends the window
 * immediately — that is the "disable the old key" path, and it is a separate,
 * deliberate action rather than the default.
 *
 * The raw key is returned exactly once, from the call that mints it. Only the
 * SHA-256 hash is stored, so it cannot be recovered or re-displayed later.
 */

/** 256 bits, url-safe — the same strength as a session token. */
const API_KEY_BYTES = 32;

/**
 * How long a superseded key keeps working.
 *
 * Long enough to redeploy clients unhurriedly, short enough that a leaked old
 * key is not a standing liability.
 */
export const API_KEY_GRACE_PERIOD_HOURS = 24;

export function generateApiKey(): string {
  return randomBytes(API_KEY_BYTES).toString('base64url');
}

export interface ApiKeyServiceDeps {
  db: SqlExecutor;
  logger: Logger;
}

function resolveDeps(deps?: Partial<ApiKeyServiceDeps>): ApiKeyServiceDeps {
  return {
    db: deps?.db ?? defaultSql,
    logger: deps?.logger ?? rootLogger.child({ service: 'api-keys' }),
  };
}

export interface RotationResult {
  /** Shown once and never retrievable again. */
  readonly apiKey: string;
  /** When the superseded key stops being accepted. */
  readonly previousKeyExpiresAt: string;
}

/**
 * Issues a new key and demotes the current one to the grace window.
 *
 * Single statement: reading the current key and then writing the new one in two
 * steps would let two concurrent rotations each demote a key the other had
 * already replaced, leaving a `previous_api_key` that no longer corresponds to
 * anything the first caller was told.
 */
const ROTATE_SQL = `
UPDATE venues
   SET previous_api_key            = api_key,
       previous_api_key_expires_at = NOW() + make_interval(hours => $2::int),
       api_key                     = $3::text,
       updated_at                  = NOW()
 WHERE id = $1::uuid
RETURNING previous_api_key_expires_at
`;

export async function rotateApiKey(
  venueId: UUID,
  deps?: Partial<ApiKeyServiceDeps>,
): Promise<RotationResult> {
  const { db, logger } = resolveDeps(deps);

  const apiKey = generateApiKey();
  const result = await db.query<{ previous_api_key_expires_at: Date }>(ROTATE_SQL, [
    venueId,
    API_KEY_GRACE_PERIOD_HOURS,
    hashToken(apiKey),
  ]);

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  // The venue id and the window are safe to log. The key is not, and is never
  // logged, returned in an error, or written to the audit trail.
  logger.info('venue api key rotated', {
    venueId,
    graceHours: API_KEY_GRACE_PERIOD_HOURS,
  });

  return {
    apiKey,
    previousKeyExpiresAt: row.previous_api_key_expires_at.toISOString(),
  };
}

/**
 * Ends the grace window now.
 *
 * Idempotent by design: an operator reacting to a suspected leak should be able
 * to run this twice without having to reason about whether the first one took.
 */
/**
 * The CTE is load-bearing. RETURNING on an UPDATE yields the *new* row, so
 * `previous_api_key IS NOT NULL` there is always false and the caller could
 * never tell "revoked a live key" from "there was nothing to revoke". A CTE
 * sees the pre-update snapshot, which is the value worth reporting.
 */
const REVOKE_SQL = `
WITH before AS (
  SELECT id, (previous_api_key IS NOT NULL) AS had_previous
    FROM venues
   WHERE id = $1::uuid
)
UPDATE venues v
   SET previous_api_key            = NULL,
       previous_api_key_expires_at = NULL,
       updated_at                  = NOW()
  FROM before
 WHERE v.id = before.id
RETURNING before.had_previous
`;

export async function revokePreviousApiKey(
  venueId: UUID,
  deps?: Partial<ApiKeyServiceDeps>,
): Promise<{ revoked: boolean }> {
  const { db, logger } = resolveDeps(deps);

  const result = await db.query<{ had_previous: boolean }>(REVOKE_SQL, [venueId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  logger.info('previous venue api key revoked', { venueId, hadPrevious: row.had_previous });
  return { revoked: row.had_previous };
}
