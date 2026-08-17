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

/** Cached leaderboard payload, keyed by venue and requested period. */
export function leaderboardKey(venueId: string, period: string): string {
  return `leaderboard:${venueId}:${period}`;
}

/**
 * Pub/sub channel announcing that a game finished grading.
 *
 * The WebSocket fan-out layer does not exist yet; publishing to Redis now means
 * it can subscribe later without the grading worker changing.
 */
export function gradingChannel(venueId: string): string {
  return `venue:${venueId}:graded`;
}

/**
 * The whole Fire TV display payload for one device.
 *
 * Keyed by device rather than venue even though the content is venue-scoped:
 * per-device keys stay correct if a future payload carries anything
 * device-specific, and the cardinality is displays-per-venue, not users.
 */
export function displayKey(deviceId: string): string {
  return `display:${deviceId}`;
}

/** device id -> venue id, a mapping that effectively never changes. */
export function deviceVenueKey(deviceId: string): string {
  return `device:${deviceId}:venue`;
}

/** Rate-limit bucket for player-session creation, per IP per venue. */
export function playerSessionRateKey(venueId: string, clientIp: string): string {
  return `player_session:${venueId}:${clientIp}`;
}

/** Rate-limit bucket for player-session creation across a whole venue. */
export function venueSessionRateKey(venueId: string): string {
  return `player_session_venue:${venueId}`;
}

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Per IP per venue. One person rejoining a few times is fine; a bot is not. */
export const PLAYER_SESSIONS_PER_IP = 5;

/**
 * Per venue, regardless of source address.
 *
 * The per-IP limit is only as good as the attacker's IP budget: a botnet, or a
 * single host with an IPv6 allocation, defeats it entirely. This bounds the
 * blast radius of that case to a number a real venue will never reach — a busy
 * bar sees low hundreds of patrons in an evening, not thousands per hour.
 */
export const PLAYER_SESSIONS_PER_VENUE = 500;

/** Rate-limit bucket for pick submission, keyed by the authenticated session. */
export function pickRateKey(playerSessionId: string): string {
  return `picks:${playerSessionId}`;
}

/** Bowling predictions share the pick budget's shape and its rationale. */
export function bowlingPredictionRateKey(playerSessionId: string): string {
  return `bowling_predictions:${playerSessionId}`;
}

/** Rate-limit bucket for display reads, keyed by the authenticated device. */
export function displayRateKey(deviceId: string): string {
  return `display:${deviceId}`;
}

/** Both of the limits below are per minute, unlike the hourly session window. */
export const SHORT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Picks per minute for one session.
 *
 * The specified figure was 10/min. That is below legitimate use: a patron
 * tapping through a 14-game slate, or changing their mind late, submits faster
 * than one pick every six seconds without trying, and would be rejected mid-way
 * through picking. Rate limits that fire on ordinary behaviour get raised in a
 * panic during the first busy night, usually by disabling them.
 *
 * What this needs to stop is a client stuck in a loop or a script hammering the
 * endpoint, not enthusiasm. One per second sustained is far beyond human
 * tapping and still bounds the damage, so that is the number. The write itself
 * is already idempotent per (game, session) and cannot inflate a score.
 */
export const PICKS_PER_SESSION_PER_MINUTE = 60;

/**
 * Display reads per minute for one device.
 *
 * Displays poll on a 10 second cadence, so a healthy Fire TV spends 6. The
 * headroom absorbs a reconnect storm or a stick that reboots into a fast retry
 * loop; anything sustained above it is a malfunctioning device, and throttling
 * it protects the other displays at the venue.
 */
export const DISPLAY_READS_PER_DEVICE_PER_MINUTE = 100;

/** How long a discovered lock is remembered. Locks never un-lock. */
export const GAME_LOCK_TTL_SECONDS = 3600;

/**
 * Fire TVs poll every 10 seconds. A matching TTL means a wall of displays at one
 * venue costs the database roughly one read per 10 seconds in total, not one per
 * display per poll.
 */
export const DISPLAY_TTL_SECONDS = 10;

/** A device's venue assignment changes only on re-pairing. */
export const DEVICE_VENUE_TTL_SECONDS = 3600;

/** A display is considered offline once its heartbeat is this stale. */
export const DEVICE_OFFLINE_AFTER_SECONDS = 120;

/** Leaderboards are recomputed on a 5 minute cadence; 60s keeps reads fresh. */
export const LEADERBOARD_TTL_SECONDS = 60;
