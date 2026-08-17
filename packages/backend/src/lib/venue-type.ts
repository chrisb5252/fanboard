import type { SqlExecutor } from './db';
import { sql as defaultSql } from './db';
import { ApiError } from './errors';
import type { UUID } from './validators';

/**
 * Which game a venue is running.
 *
 * A sports bar predicts match winners; a bowling alley predicts scores. The two
 * do not share endpoints, and these guards are what keeps them apart at the
 * edge rather than relying on each venue happening to have no rows in the other
 * kind's tables.
 *
 * Both refuse with 404 rather than 400. A sports bar genuinely has no lanes and
 * an alley has no fixtures, so "not here" is the true answer, and it is also
 * the one that tells an unauthenticated prober the least — a 400 would confirm
 * the venue exists and merely has the wrong type.
 */

export const VENUE_TYPES = ['sports_bar', 'bowling_alley'] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

export async function getVenueType(
  venueId: UUID,
  db: SqlExecutor = defaultSql,
): Promise<VenueType | null> {
  const result = await db.query<{ type: string }>('SELECT type FROM venues WHERE id = $1::uuid', [
    venueId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : (row.type as VenueType);
}

export async function assertBowlingVenue(
  venueId: UUID,
  db: SqlExecutor = defaultSql,
): Promise<void> {
  if ((await getVenueType(venueId, db)) !== 'bowling_alley') {
    throw ApiError.notFound('No lanes at this venue');
  }
}

export async function assertSportsBarVenue(
  venueId: UUID,
  db: SqlExecutor = defaultSql,
): Promise<void> {
  if ((await getVenueType(venueId, db)) !== 'sports_bar') {
    throw ApiError.notFound('No games at this venue');
  }
}
