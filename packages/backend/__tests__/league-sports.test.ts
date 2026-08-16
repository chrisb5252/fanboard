import { describe, expect, it } from 'vitest';
import { LEAGUE_WHITELIST, leagueMatchesFor, sportsForLeagues } from '../src/lib/leagues';

/**
 * The league-to-sport mapping decides whether the poller fetches anything at
 * all, and it fails silently: a wrong scope returns a valid, empty response and
 * the log reads "provider returned no games", which looks like a quiet night
 * rather than a bug. That is exactly what was happening — the poller only ever
 * asked for Soccer, so the NFL and MLB slates were invisible.
 */

describe('sportsForLeagues', () => {
  it('asks for every scope when no leagues are selected', () => {
    // Empty means "no filter" in the schema, so it has to mean every sport
    // here too. Mapping it to none would leave an unconfigured venue ingesting
    // nothing while looking correctly configured.
    const sports = sportsForLeagues([]);
    expect(sports).toContain('American Football');
    expect(sports).toContain('Basketball');
    expect(sports).toContain('Baseball');
    expect(sports).toContain('Ice Hockey');
    expect(sports).toContain('Soccer');
  });

  it('treats undefined the same as empty', () => {
    expect(sportsForLeagues(undefined)).toEqual(sportsForLeagues([]));
  });

  it('asks only for the scopes the selection needs', () => {
    expect(sportsForLeagues(['NFL'])).toEqual(['American Football']);
    expect(sportsForLeagues(['MLB', 'NHL'])).toEqual(['Baseball', 'Ice Hockey']);
  });

  it('collapses leagues that share a scope into one request', () => {
    // NFL and NCAAFB are both American Football. Asking twice would double the
    // request count for no extra fixtures.
    expect(sportsForLeagues(['NFL', 'NCAAFB'])).toEqual(['American Football']);
  });

  it('ignores codes outside the whitelist rather than inventing a scope', () => {
    expect(sportsForLeagues(['MLS'])).toEqual([]);
  });

  it('covers every whitelisted league', () => {
    // A league with no scope would be selectable in the admin UI and then
    // quietly fetch nothing.
    for (const league of LEAGUE_WHITELIST) {
      expect(sportsForLeagues([league]).length).toBe(1);
    }
  });
});

describe('leagueMatchesFor', () => {
  it('passes short codes through where the API uses them', () => {
    expect(leagueMatchesFor(['NFL'])).toEqual(['NFL']);
    expect(leagueMatchesFor(['MLB'])).toEqual(['MLB']);
  });

  it('expands EPL to the names the API actually returns', () => {
    // Verified against a live response: the upstream league string is spelled
    // out, so filtering on the bare code would match nothing.
    const matches = leagueMatchesFor(['EPL']);
    expect(matches).toContain('English Premier League');
    expect(matches).toContain('Premier League');
  });

  it('returns nothing for an empty selection, meaning no filter', () => {
    expect(leagueMatchesFor([])).toEqual([]);
    expect(leagueMatchesFor(undefined)).toEqual([]);
  });
});
