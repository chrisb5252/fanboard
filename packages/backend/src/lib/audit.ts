import type { SqlExecutor } from './db';
import { sql as defaultSql } from './db';
import { logger as rootLogger, redactSensitive, type Logger } from './logger';
import type { UUID } from './validators';

/**
 * Append-only record of privileged actions.
 *
 * Two properties this module guarantees:
 *
 *  1. It never throws. An audit write failing must not turn a successful config
 *     change into a 500 -- the action already happened, and reporting it as
 *     failed would be a lie that invites the operator to repeat it. Failures
 *     are logged loudly instead.
 *  2. Details are redacted with the same rule the logger uses, so a caller that
 *     passes a whole request body cannot persist an api_key into a table that
 *     is, by design, never deleted.
 *
 * The tradeoff in (1) is explicit: this is an operational trail for debugging
 * and answering "who changed what", not a compliance ledger. If it ever needs
 * to be the latter, the write belongs inside the same transaction as the action
 * so the two cannot diverge.
 */

export const AUDIT_ACTIONS = {
  venueConfigUpdated: 'venue.config.updated',
  devicePaired: 'device.paired',
  apiKeyRotated: 'venue.api_key.rotated',
  apiKeyPreviousRevoked: 'venue.api_key.previous_revoked',
  venueSuspended: 'venue.suspended',
  venueResumed: 'venue.resumed',
  pickVoided: 'pick.voided',
  playerReconciled: 'player.reconciled',
  gameGradedManually: 'game.graded_manually',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditDeps {
  db: SqlExecutor;
  logger: Logger;
}

function resolveDeps(deps?: Partial<AuditDeps>): AuditDeps {
  return {
    db: deps?.db ?? defaultSql,
    logger: deps?.logger ?? rootLogger.child({ component: 'audit' }),
  };
}

const INSERT_AUDIT_SQL = `
INSERT INTO audit_logs (action, user_id, venue_id, details)
VALUES ($1::text, $2::text, $3::uuid, $4::jsonb)
RETURNING id
`;

/**
 * Records one privileged action.
 *
 * `userId` is optional and is NULL for everything today: admin routes
 * authenticate with a venue API key, which identifies a venue rather than a
 * person. It exists so the column is already there when admin accounts land.
 */
export async function auditLog(
  action: string,
  userId: string | undefined,
  venueId: UUID,
  details?: Record<string, unknown>,
  deps?: Partial<AuditDeps>,
): Promise<void> {
  const { db, logger } = resolveDeps(deps);

  try {
    const safeDetails = redactSensitive(details ?? {});
    await db.query(INSERT_AUDIT_SQL, [
      action,
      userId ?? null,
      venueId,
      JSON.stringify(safeDetails),
    ]);
  } catch (error) {
    // Deliberately swallowed; see the note at the top of this file.
    logger.error('failed to write audit log', { action, venueId, error });
  }
}

export interface AuditEntry {
  id: string;
  action: string;
  userId: string | null;
  venueId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** Reads a venue's recent audit trail, newest first. */
export async function readAuditLog(
  venueId: UUID,
  limit: number,
  deps?: Partial<AuditDeps>,
): Promise<AuditEntry[]> {
  const { db } = resolveDeps(deps);
  const result = await db.query<{
    id: string;
    action: string;
    user_id: string | null;
    venue_id: string;
    details: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, action, user_id, venue_id, details, created_at
       FROM audit_logs
      WHERE venue_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2::int`,
    [venueId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    userId: row.user_id,
    venueId: row.venue_id,
    details: row.details,
    createdAt: row.created_at.toISOString(),
  }));
}
