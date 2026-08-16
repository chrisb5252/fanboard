import { ApiError } from './errors';

/**
 * Leagues a venue may enable.
 *
 * These codes are FanBoard's vocabulary and are also what TheSportsDB puts in
 * strLeague for at least some of them -- events on the American Football feed
 * come back with strLeague exactly "NFL". NCAAFB and NCAAB are unverified: the
 * free API key does not expose the college feeds, so confirm those against the
 * provider before relying on them to match, or the filter will silently return
 * nothing for a venue that enabled only college sport.
 *
 * Nothing consumes this list yet. poll-games already accepts
 * FetchGamesOptions.leagues, so wiring it up is passing the venue's stored
 * codes into that call, not a change of shape.
 */
export const LEAGUE_WHITELIST = [
  'NFL',
  'NBA',
  'MLB',
  'NHL',
  'EPL',
  'NCAAFB',
  'NCAAB',
] as const;

export type League = (typeof LEAGUE_WHITELIST)[number];

const WHITELIST = new Set<string>(LEAGUE_WHITELIST);

/**
 * The sport scope each league lives under at TheSportsDB.
 *
 * The eventsday endpoint answers for one sport at a time, so the poller has to
 * know which scopes to ask for. Verified against live responses rather than
 * assumed: American Football returns leagues named "NFL", Baseball returns
 * "MLB", and Soccer carries the football leagues.
 */
const LEAGUE_SPORTS: Readonly<Record<League, string>> = {
  NFL: 'American Football',
  NCAAFB: 'American Football',
  NBA: 'Basketball',
  NCAAB: 'Basketball',
  MLB: 'Baseball',
  NHL: 'Ice Hockey',
  EPL: 'Soccer',
};

/**
 * Sport scopes to request for a set of enabled leagues.
 *
 * An empty selection means "no filter", which is the schema's own convention
 * for enabled_leagues, so it maps to every scope rather than none — otherwise a
 * venue that has not chosen leagues would silently ingest nothing.
 */
export function sportsForLeagues(leagues: readonly string[] | undefined): string[] {
  const chosen =
    leagues === undefined || leagues.length === 0
      ? [...LEAGUE_WHITELIST]
      : LEAGUE_WHITELIST.filter((league) => leagues.includes(league));

  return [...new Set(chosen.map((league) => LEAGUE_SPORTS[league]))];
}

/**
 * The league names the provider should match on.
 *
 * TheSportsDB spells the English top flight out in full, so a venue enabling
 * 'EPL' would match nothing without this translation.
 */
const LEAGUE_MATCHES: Readonly<Record<League, readonly string[]>> = {
  NFL: ['NFL'],
  NBA: ['NBA'],
  MLB: ['MLB'],
  NHL: ['NHL'],
  EPL: ['English Premier League', 'Premier League'],
  NCAAFB: ['NCAA Football'],
  NCAAB: ['NCAA Basketball'],
};

export function leagueMatchesFor(leagues: readonly string[] | undefined): string[] {
  if (leagues === undefined || leagues.length === 0) {
    return [];
  }
  return LEAGUE_WHITELIST.filter((league) => leagues.includes(league)).flatMap(
    (league) => [...LEAGUE_MATCHES[league]],
  );
}

/** Upper bound on the request array, so a caller cannot send an unbounded list. */
const MAX_ENABLED_LEAGUES = LEAGUE_WHITELIST.length;

export function isLeague(value: unknown): value is League {
  return typeof value === 'string' && WHITELIST.has(value);
}

/**
 * Validates an enabled-leagues array.
 *
 * Case-sensitive on purpose: these are codes, not prose, and quietly accepting
 * "nfl" would store a value that never matches a provider league name. An empty
 * array is legal and means "no filter" -- the current behaviour, where a venue
 * ingests everything.
 */
export function validateEnabledLeagues(value: unknown): League[] {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest('enabledLeagues must be an array', { field: 'enabledLeagues' });
  }
  if (value.length > MAX_ENABLED_LEAGUES) {
    throw ApiError.badRequest(
      `enabledLeagues may contain at most ${MAX_ENABLED_LEAGUES} entries`,
      { field: 'enabledLeagues' },
    );
  }

  const invalid = value.filter((entry) => !isLeague(entry));
  if (invalid.length > 0) {
    throw ApiError.badRequest(
      `enabledLeagues contains unsupported values: ${invalid
        .map((entry) => JSON.stringify(entry))
        .join(', ')}`,
      { field: 'enabledLeagues', allowed: [...LEAGUE_WHITELIST] },
    );
  }

  // De-duplicate, and order by the whitelist so the stored value is canonical:
  // ["NBA","NFL"] and ["NFL","NBA"] are the same configuration and should not
  // read as two different ones in an audit diff.
  const chosen = new Set(value as League[]);
  return LEAGUE_WHITELIST.filter((league) => chosen.has(league));
}
