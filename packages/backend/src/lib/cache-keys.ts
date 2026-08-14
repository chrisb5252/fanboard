/**
 * Centralised Redis key builders.
 *
 * Keys live in one place so a reader and an invalidator cannot drift apart —
 * a cache that is written under one key and cleared under another is a stale
 * leaderboard nobody can explain.
 */

/**
 * Presence of this key means "this game is locked", independent of the clock.
 * It is a fast path in front of the database, never the source of truth: the
 * authoritative check is the SQL predicate on games.locked_at / scheduled_at.
 */
export function gameLockKey(gameId: string): string {
  return `game:${gameId}:locked_at`;
}

/** Cached pick lists for a venue. Invalidated on every pick write. */
export function venuePicksKey(venueId: string): string {
  return `venue:${venueId}:picks`;
}

/** How long a discovered lock is remembered. Locks never un-lock. */
export const GAME_LOCK_TTL_SECONDS = 3600;
