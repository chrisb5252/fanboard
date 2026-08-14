import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRegisteredSecrets, createLogger, type LogLevel } from '../src/lib/logger';
import {
  addDaysIso,
  deriveWinner,
  filterByLeagues,
  isIsoDate,
  toIsoDate,
  type CacheStore,
  type NormalizedGame,
} from '../src/lib/sports-provider';
import {
  TheSportsDBProvider,
  mapStatus,
  parseScheduledAt,
  parseScore,
  type FetchLike,
} from '../src/lib/thesportsdb';

const API_KEY = 'super-secret-key-abcdef123456';

/** Shaped exactly like a real eventsday.php event (verified against the API). */
function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idEvent: '2013667',
    strSport: 'Soccer',
    strLeague: 'Singapore Premier League',
    strHomeTeam: 'Hougang United',
    strAwayTeam: 'Balestier Khalsa',
    strHomeTeamBadge: 'https://r2.thesportsdb.com/images/media/team/badge/home.png',
    strAwayTeamBadge: 'https://r2.thesportsdb.com/images/media/team/badge/away.png',
    intHomeScore: '3',
    intAwayScore: '1',
    strTimestamp: '2025-01-19T10:00:00',
    dateEvent: '2025-01-19',
    strTime: '10:00:00',
    strStatus: 'FT',
    strPostponed: 'no',
    // Fields the normalizer ignores; present to prove they are tolerated.
    strVenue: 'Hougang Stadium',
    intSpectators: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Captured {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
}

function capturingLogger(level: LogLevel = 'debug'): Captured {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return { lines, logger };
}

function makeProvider(
  fetchImpl: FetchLike,
  extra: { cache?: CacheStore; logger?: ReturnType<typeof createLogger> } = {},
): TheSportsDBProvider {
  return new TheSportsDBProvider({
    apiKey: API_KEY,
    fetchImpl,
    logger: extra.logger ?? capturingLogger().logger,
    ...(extra.cache !== undefined ? { cache: extra.cache } : {}),
  });
}

afterEach(() => {
  clearRegisteredSecrets();
  vi.restoreAllMocks();
});

describe('date helpers', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isIsoDate('2025-01-19')).toBe(true);
    expect(isIsoDate('2025-02-30')).toBe(false);
    expect(isIsoDate('19-01-2025')).toBe(false);
    expect(isIsoDate('2025-1-9')).toBe(false);
  });

  it('adds days across a month boundary in UTC', () => {
    expect(addDaysIso('2025-01-30', 3)).toBe('2025-02-02');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('formats an instant as its UTC calendar day', () => {
    expect(toIsoDate(new Date('2025-01-19T23:30:00Z'))).toBe('2025-01-19');
  });
});

describe('deriveWinner', () => {
  it('resolves a final score', () => {
    expect(deriveWinner('final', 3, 1)).toBe('home');
    expect(deriveWinner('final', 1, 3)).toBe('away');
    expect(deriveWinner('final', 2, 2)).toBe('draw');
  });

  it('refuses to name a winner before the game is final', () => {
    expect(deriveWinner('live', 3, 1)).toBeNull();
    expect(deriveWinner('scheduled', null, null)).toBeNull();
    expect(deriveWinner('cancelled', 3, 1)).toBeNull();
    expect(deriveWinner('final', 3, null)).toBeNull();
  });
});

describe('field parsers', () => {
  it('parses scores that arrive as strings', () => {
    expect(parseScore('3')).toBe(3);
    expect(parseScore(0)).toBe(0);
    expect(parseScore('0')).toBe(0);
  });

  it('treats absent and malformed scores as unknown', () => {
    expect(parseScore(null)).toBeNull();
    expect(parseScore(undefined)).toBeNull();
    expect(parseScore('')).toBeNull();
    expect(parseScore('abc')).toBeNull();
    // Would violate the games_home_score_check constraint.
    expect(parseScore('-1')).toBeNull();
  });

  it('maps provider status codes onto the schema CHECK values', () => {
    expect(mapStatus('NS', 'no')).toBe('scheduled');
    expect(mapStatus('', null)).toBe('scheduled');
    expect(mapStatus('FT', 'no')).toBe('final');
    expect(mapStatus('AET', 'no')).toBe('final');
    expect(mapStatus('Match Finished', 'no')).toBe('final');
    expect(mapStatus('1H', 'no')).toBe('live');
    expect(mapStatus('HT', 'no')).toBe('live');
    expect(mapStatus('Cancelled', 'no')).toBe('cancelled');
    expect(mapStatus('Abandoned', 'no')).toBe('cancelled');
  });

  it('lets the postponed flag override a stale status', () => {
    expect(mapStatus('NS', 'yes')).toBe('postponed');
    expect(mapStatus('1H', 'yes')).toBe('postponed');
    // Cancelled outranks postponed.
    expect(mapStatus('Cancelled', 'yes')).toBe('cancelled');
  });

  it('reads the offset-less timestamp as UTC, not local time', () => {
    // The regression this guards: `new Date("2025-01-19T10:00:00")` is parsed
    // as local time by V8, shifting kick-off by the server's offset.
    const parsed = parseScheduledAt({ strTimestamp: '2025-01-19T10:00:00' });
    expect(parsed?.toISOString()).toBe('2025-01-19T10:00:00.000Z');
  });

  it('honours an explicit offset when one is present', () => {
    const parsed = parseScheduledAt({ strTimestamp: '2025-01-19T10:00:00+02:00' });
    expect(parsed?.toISOString()).toBe('2025-01-19T08:00:00.000Z');
  });

  it('falls back to dateEvent + strTime', () => {
    const parsed = parseScheduledAt({ dateEvent: '2025-01-19', strTime: '15:30:00' });
    expect(parsed?.toISOString()).toBe('2025-01-19T15:30:00.000Z');
  });

  it('returns null when there is no usable time at all', () => {
    expect(parseScheduledAt({})).toBeNull();
    expect(parseScheduledAt({ strTimestamp: 'not-a-date' })).toBeNull();
  });
});

describe('TheSportsDBProvider.fetchGames — normalization', () => {
  it('normalizes a realistic response into NormalizedGame', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));
    const games = await makeProvider(fetchImpl).fetchGames('2025-01-19');

    expect(games).toHaveLength(1);
    expect(games[0]).toEqual<NormalizedGame>({
      externalId: '2013667',
      league: 'Singapore Premier League',
      sport: 'Soccer',
      homeTeam: 'Hougang United',
      awayTeam: 'Balestier Khalsa',
      homeLogoUrl: 'https://r2.thesportsdb.com/images/media/team/badge/home.png',
      awayLogoUrl: 'https://r2.thesportsdb.com/images/media/team/badge/away.png',
      scheduledAt: new Date('2025-01-19T10:00:00Z'),
      status: 'final',
      homeScore: 3,
      awayScore: 1,
      winner: 'home',
    });
  });

  it('normalizes an unplayed game with null scores', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        events: [rawEvent({ strStatus: 'NS', intHomeScore: null, intAwayScore: null })],
      }),
    );
    const games = await makeProvider(fetchImpl).fetchGames('2025-01-19');

    expect(games[0]?.status).toBe('scheduled');
    expect(games[0]?.homeScore).toBeNull();
    expect(games[0]?.winner).toBeNull();
  });

  it('normalizes a missing badge to null rather than an empty string', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ events: [rawEvent({ strHomeTeamBadge: '', strAwayTeamBadge: null })] }),
    );
    const games = await makeProvider(fetchImpl).fetchGames('2025-01-19');

    expect(games[0]?.homeLogoUrl).toBeNull();
    expect(games[0]?.awayLogoUrl).toBeNull();
  });

  it('discards events missing a column the games table needs NOT NULL', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        events: [
          rawEvent(),
          rawEvent({ idEvent: null }),
          rawEvent({ idEvent: '3', strHomeTeam: '  ' }),
          rawEvent({ idEvent: '4', strTimestamp: null, dateEvent: null }),
        ],
      }),
    );
    const games = await makeProvider(fetchImpl).fetchGames('2025-01-19');

    expect(games).toHaveLength(1);
    expect(games[0]?.externalId).toBe('2013667');
  });

  it('filters by league, case-insensitively', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        events: [
          rawEvent({ idEvent: '1', strLeague: 'English Premier League' }),
          rawEvent({ idEvent: '2', strLeague: 'Singapore Premier League' }),
        ],
      }),
    );
    const games = await makeProvider(fetchImpl).fetchGames('2025-01-19', {
      leagues: ['english premier league'],
    });

    expect(games.map((g) => g.externalId)).toEqual(['1']);
  });
});

describe('TheSportsDBProvider.fetchGames — error handling', () => {
  it('returns [] on a non-2xx status', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ Message: 'Invalid Premium API key' }, 400));
    await expect(makeProvider(fetchImpl).fetchGames('2025-01-19')).resolves.toEqual([]);
  });

  it('returns [] when the body is not JSON', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    await expect(makeProvider(fetchImpl).fetchGames('2025-01-19')).resolves.toEqual([]);
  });

  it('returns [] when the payload fails schema validation', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: 'nonsense' }));
    await expect(makeProvider(fetchImpl).fetchGames('2025-01-19')).resolves.toEqual([]);
  });

  it('returns [] when the network throws', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error('ECONNRESET'));
    await expect(makeProvider(fetchImpl).fetchGames('2025-01-19')).resolves.toEqual([]);
  });

  it('treats "events": null as an empty day, not a failure', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: null }));
    const { lines, logger } = capturingLogger();
    await expect(makeProvider(fetchImpl, { logger }).fetchGames('2025-01-19')).resolves.toEqual([]);
    expect(lines.some((line) => line.includes('"level":"error"'))).toBe(false);
  });

  it('rejects a malformed date without calling the API', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    await expect(makeProvider(fetchImpl).fetchGames('19-01-2025')).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('TheSportsDBProvider — API key confidentiality', () => {
  it('never writes the API key into a log line, on success or failure', async () => {
    const { lines, logger } = capturingLogger();
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ events: [rawEvent()] }))
      .mockResolvedValueOnce(jsonResponse({ Message: 'nope' }, 400))
      .mockRejectedValueOnce(new Error(`connect failed for key ${API_KEY}`));

    const provider = makeProvider(fetchImpl, { logger });
    await provider.fetchGames('2025-01-19');
    await provider.fetchGames('2025-01-20');
    await provider.fetchGames('2025-01-21');

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(API_KEY);
    }
    // The URL is still logged, just with the key masked.
    expect(lines.some((line) => line.includes('/json/***/eventsday.php'))).toBe(true);
  });

  it('still sends the real key on the wire', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [] }));
    await makeProvider(fetchImpl).fetchGames('2025-01-19');

    const calledUrl = fetchImpl.mock.calls[0]?.[0];
    expect(calledUrl).toContain(`/json/${API_KEY}/eventsday.php`);
    expect(calledUrl).toContain('d=2025-01-19');
  });
});

describe('TheSportsDBProvider — caching', () => {
  function memoryCache(): CacheStore & { store: Map<string, string>; getCalls: number } {
    const store = new Map<string, string>();
    const cache = {
      store,
      getCalls: 0,
      get: async (key: string) => {
        cache.getCalls += 1;
        return store.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    return cache;
  }

  it('serves a repeat request from cache without a second API call', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));
    const cache = memoryCache();
    const provider = makeProvider(fetchImpl, { cache });

    const first = await provider.fetchGames('2025-01-19');
    const second = await provider.fetchGames('2025-01-19');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(cache.store.size).toBe(1);
  });

  it('keys the cache per date', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));
    const provider = makeProvider(fetchImpl, { cache: memoryCache() });

    await provider.fetchGames('2025-01-19');
    await provider.fetchGames('2025-01-20');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('writes the cache entry with a 5 minute TTL', async () => {
    const set = vi.fn<CacheStore['set']>().mockResolvedValue(undefined);
    const cache: CacheStore = { get: async () => null, set };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));

    await new TheSportsDBProvider({
      apiKey: API_KEY,
      fetchImpl,
      cache,
      logger: capturingLogger().logger,
    }).fetchGames('2025-01-19');

    expect(set).toHaveBeenCalledWith(expect.stringContaining('2025-01-19'), expect.any(String), 300);
  });

  it('falls back to the network when the cache read fails', async () => {
    const cache: CacheStore = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => undefined,
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));

    const games = await makeProvider(fetchImpl, { cache }).fetchGames('2025-01-19');

    expect(games).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SportsProvider.fetchGamesForRange', () => {
  it('walks the requested number of days', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation((url) =>
      Promise.resolve(
        jsonResponse({
          events: [rawEvent({ idEvent: new URL(url).searchParams.get('d') })],
        }),
      ),
    );

    const games = await makeProvider(fetchImpl).fetchGamesForRange('2025-01-19', 7);

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(games).toHaveLength(7);
    expect(games.map((g) => g.externalId)).toContain('2025-01-25');
  });

  it('de-duplicates a fixture reported on two adjacent days', async () => {
    // A duplicate external id would abort the ON CONFLICT upsert outright.
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [rawEvent()] }));
    const games = await makeProvider(fetchImpl).fetchGamesForRange('2025-01-19', 3);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(games).toHaveLength(1);
  });

  it('keeps going when one day of the window fails', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ events: [rawEvent({ idEvent: 'a' })] }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(jsonResponse({ events: [rawEvent({ idEvent: 'c' })] }));

    const games = await makeProvider(fetchImpl).fetchGamesForRange('2025-01-19', 3);

    expect(games.map((g) => g.externalId).sort()).toEqual(['a', 'c']);
  });

  it('rejects a non-positive day count', async () => {
    const provider = makeProvider(vi.fn<FetchLike>());
    await expect(provider.fetchGamesForRange('2025-01-19', 0)).rejects.toThrow(RangeError);
  });
});

describe('filterByLeagues', () => {
  const game = (league: string): NormalizedGame => ({
    externalId: league,
    league,
    sport: 'Soccer',
    homeTeam: 'H',
    awayTeam: 'A',
    homeLogoUrl: null,
    awayLogoUrl: null,
    scheduledAt: new Date('2025-01-19T10:00:00Z'),
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    winner: null,
  });

  it('passes everything through when no filter is given', () => {
    const games = [game('NFL'), game('NBA')];
    expect(filterByLeagues(games, undefined)).toHaveLength(2);
    expect(filterByLeagues(games, [])).toHaveLength(2);
  });

  it('matches ignoring case and surrounding whitespace', () => {
    expect(filterByLeagues([game('NFL'), game('NBA')], ['  nfl '])).toHaveLength(1);
  });
});
