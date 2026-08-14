/**
 * Provider-agnostic contract for sports schedule/score ingestion.
 *
 * Nothing in this module imports infrastructure (db, redis, env). That is what
 * keeps the dependency graph acyclic: providers depend on this, this depends on
 * nothing but the logger types it is handed.
 */

/** Mirrors the games.status CHECK constraint in schema.sql. */
export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';

/** Mirrors the games.winner / picks.predicted_winner CHECK constraint. */
export type GameWinner = 'home' | 'away' | 'draw';

export const GAME_STATUSES: readonly GameStatus[] = [
  'scheduled',
  'live',
  'final',
  'postponed',
  'cancelled',
];

export interface NormalizedGame {
  /** Provider-assigned id. Unique per venue via games(venue_id, external_id). */
  readonly externalId: string;
  readonly league: string;
  readonly sport: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly homeLogoUrl: string | null;
  readonly awayLogoUrl: string | null;
  /** Always an absolute instant; providers must resolve their own timezone. */
  readonly scheduledAt: Date;
  readonly status: GameStatus;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  /** Non-null only once the game is final. */
  readonly winner: GameWinner | null;
}

export interface FetchGamesOptions {
  /**
   * League filtering. Wired through the whole call path now so adding the
   * per-venue league selection later is a data change, not a signature change.
   * Matched case-insensitively against NormalizedGame.league.
   */
  readonly leagues?: readonly string[];
  /** Provider-specific sport scope, e.g. "Soccer" for TheSportsDB. */
  readonly sport?: string;
}

/** Minimal cache contract so providers can be tested without Redis. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export abstract class SportsProvider {
  /** Stable identifier used in logs and cache keys. */
  abstract readonly name: string;

  /**
   * Returns every game the provider knows about on `date` (an ISO `YYYY-MM-DD`
   * calendar day).
   *
   * Implementations must never reject: a provider outage is an expected
   * operating condition, not an exception. Return an empty array and log.
   */
  abstract fetchGames(date: string, options?: FetchGamesOptions): Promise<NormalizedGame[]>;

  /**
   * Fetches a contiguous run of days starting at `startDate`.
   *
   * Days are fetched sequentially rather than in parallel — this runs against a
   * rate-limited third-party API every 30 seconds, and a burst of 7 concurrent
   * requests is exactly what gets an API key throttled.
   *
   * Results are de-duplicated by externalId: a fixture near midnight UTC can be
   * reported on two adjacent calendar days, and feeding a duplicate into the
   * upsert would abort the whole statement.
   */
  async fetchGamesForRange(
    startDate: string,
    days: number,
    options?: FetchGamesOptions,
  ): Promise<NormalizedGame[]> {
    assertIsoDate(startDate);
    if (!Number.isInteger(days) || days < 1) {
      throw new RangeError(`days must be a positive integer, received ${String(days)}`);
    }

    const byExternalId = new Map<string, NormalizedGame>();

    for (let offset = 0; offset < days; offset += 1) {
      const games = await this.fetchGames(addDaysIso(startDate, offset), options);
      for (const game of games) {
        // Last write wins: later fetches carry fresher scores.
        byExternalId.set(game.externalId, game);
      }
    }

    return [...byExternalId.values()];
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  // Rejects real-looking but invalid dates such as 2025-02-30.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function assertIsoDate(value: string): void {
  if (!isIsoDate(value)) {
    throw new TypeError(`Expected an ISO YYYY-MM-DD date, received ${JSON.stringify(value)}`);
  }
}

/** Adds whole days to an ISO date, in UTC. */
export function addDaysIso(date: string, days: number): string {
  assertIsoDate(date);
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Formats a Date as the UTC calendar day the provider indexes by. */
export function toIsoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Resolves the winner from a final score. Returns null for any non-final game,
 * which is what keeps games.winner consistent with the
 * games_graded_requires_winner constraint.
 */
export function deriveWinner(
  status: GameStatus,
  homeScore: number | null,
  awayScore: number | null,
): GameWinner | null {
  if (status !== 'final' || homeScore === null || awayScore === null) {
    return null;
  }
  if (homeScore > awayScore) {
    return 'home';
  }
  if (awayScore > homeScore) {
    return 'away';
  }
  return 'draw';
}

/** Case-insensitive league filter shared by every provider. */
export function filterByLeagues(
  games: readonly NormalizedGame[],
  leagues: readonly string[] | undefined,
): NormalizedGame[] {
  if (leagues === undefined || leagues.length === 0) {
    return [...games];
  }
  const wanted = new Set(leagues.map((league) => league.trim().toLowerCase()));
  return games.filter((game) => wanted.has(game.league.trim().toLowerCase()));
}
