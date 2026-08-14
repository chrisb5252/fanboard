import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import { generateSessionToken, hashToken } from '../lib/tokens';
import { trustedUuid, type UUID } from '../lib/validators';

export interface CreatePlayerSessionInput {
  venueId: UUID;
  nickname: string;
}

export interface CreatedPlayerSession {
  playerId: UUID;
  venueId: UUID;
  nickname: string;
  /** Raw token. Goes into the cookie and is never persisted or logged. */
  sessionToken: string;
}

export interface PlayerServiceDeps {
  db: SqlExecutor;
  generateToken: () => string;
}

function resolveDeps(deps?: Partial<PlayerServiceDeps>): PlayerServiceDeps {
  return {
    db: deps?.db ?? defaultSql,
    generateToken: deps?.generateToken ?? generateSessionToken,
  };
}

/**
 * Creates an anonymous player session for a venue.
 *
 * The venue check and the insert are one statement on purpose: `INSERT ...
 * SELECT ... FROM venues WHERE id = $1` produces no source row when the venue
 * does not exist, so there is no window between "venue exists" and "insert"
 * in which the venue could be deleted. A separate SELECT-then-INSERT would
 * either race or rely on a transaction to cover the gap.
 *
 * Only the hash of the token reaches the database.
 */
export async function createPlayerSession(
  input: CreatePlayerSessionInput,
  deps?: Partial<PlayerServiceDeps>,
): Promise<CreatedPlayerSession> {
  const { db, generateToken } = resolveDeps(deps);

  const sessionToken = generateToken();

  const result = await db.query<{ id: string; venue_id: string; nickname: string }>(
    `INSERT INTO player_sessions (venue_id, nickname, session_token)
     SELECT v.id, $2, $3
       FROM venues v
      WHERE v.id = $1::uuid
     RETURNING id, venue_id, nickname`,
    [input.venueId, input.nickname, hashToken(sessionToken)],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  return {
    playerId: trustedUuid(row.id),
    venueId: trustedUuid(row.venue_id),
    nickname: row.nickname,
    sessionToken,
  };
}
