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
/** A nickname is reserved by a live session for this long after creation. */
export const NICKNAME_HOLD_MINUTES = 60;

/**
 * The NOT EXISTS clause is inside the INSERT for the same reason the venue
 * check is: a SELECT-then-INSERT lets two simultaneous "Mike" requests both
 * observe an empty table and both write. Evaluated as one statement, the second
 * writer sees the first.
 *
 * Case-insensitive, because "Mike" and "mike" are the same name on a TV.
 * Scoped to sessions that are still live, so a nickname frees up once its
 * holder's session lapses.
 */
const CREATE_SESSION_SQL = `
INSERT INTO player_sessions (venue_id, nickname, session_token)
SELECT v.id, $2, $3
  FROM venues v
 WHERE v.id = $1::uuid
   AND NOT EXISTS (
     SELECT 1
       FROM player_sessions held
      WHERE held.venue_id = v.id
        AND lower(held.nickname) = lower($2)
        AND held.expired = FALSE
        AND held.expires_at > NOW()
        AND held.created_at > NOW() - make_interval(mins => $4::int)
   )
RETURNING id, venue_id, nickname
`;

export async function createPlayerSession(
  input: CreatePlayerSessionInput,
  deps?: Partial<PlayerServiceDeps>,
): Promise<CreatedPlayerSession> {
  const { db, generateToken } = resolveDeps(deps);

  const sessionToken = generateToken();

  const result = await db.query<{ id: string; venue_id: string; nickname: string }>(
    CREATE_SESSION_SQL,
    [input.venueId, input.nickname, hashToken(sessionToken), NICKNAME_HOLD_MINUTES],
  );

  const row = result.rows[0];
  if (row === undefined) {
    // Zero rows is ambiguous by construction: no such venue, or the nickname is
    // held. Re-read to say which, rather than guessing.
    throw await explainCreateFailure(input, db);
  }

  return {
    playerId: trustedUuid(row.id),
    venueId: trustedUuid(row.venue_id),
    nickname: row.nickname,
    sessionToken,
  };
}

async function explainCreateFailure(
  input: CreatePlayerSessionInput,
  db: SqlExecutor,
): Promise<ApiError> {
  const venue = await db.query<{ id: string }>('SELECT id FROM venues WHERE id = $1::uuid', [
    input.venueId,
  ]);

  if (venue.rows.length === 0) {
    return ApiError.notFound('Venue not found');
  }

  return new ApiError(
    409,
    'nickname_taken',
    'That nickname is in use at this venue. Choose another.',
    { field: 'nickname' },
  );
}
