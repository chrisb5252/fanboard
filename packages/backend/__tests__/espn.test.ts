import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger';
import { EspnProvider, toEspnDate } from '../src/lib/espn';

/**
 * ESPN's scoreboard is undocumented, so the shape below was captured from live
 * responses rather than from a spec. That is exactly why these tests exist: if
 * the shape moves, this fails loudly instead of the poller quietly ingesting
 * nothing.
 *
 * The single most important case is the competitor layout. Home and away live
 * in a `competitors[]` array tagged with `homeAway` — there are no `home` and
 * `away` objects, however natural that looks. Reading it wrongly does not
 * throw; it yields "Unknown vs Unknown" on a television.
 */

const silent = createLogger({ level: 'silent' });

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: '401547',
    date: '2026-08-16T23:15Z',
    status: { type: { name: 'STATUS_SCHEDULED' } },
    competitions: [
      {
        competitors: [
          {
            homeAway: 'home',
            score: '0',
            team: { displayName: 'Chicago Bears', logo: 'https://cdn/bears.png' },
          },
          {
            homeAway: 'away',
            score: '0',
            team: { displayName: 'Green Bay Packers', logo: 'https://cdn/packers.png' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** A fetch that answers every league with the same payload. */
function stubFetch(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function provider(fetchImpl: typeof fetch) {
  return new EspnProvider({ logger: silent, leagues: ['NFL'], fetchImpl });
}

describe('toEspnDate', () => {
  it('compacts an ISO date to the form the endpoint wants', () => {
    expect(toEspnDate('2026-08-16')).toBe('20260816');
  });
});

describe('EspnProvider', () => {
  it('reads teams from competitors by homeAway, not by position', async () => {
    // Reversed order on purpose: the array order is not contractual, so
    // position-based reading would silently swap home and away — and a swapped
    // fixture grades every pick backwards.
    const reversed = event({
      competitions: [
        {
          competitors: [
            { homeAway: 'away', score: '3', team: { displayName: 'Green Bay Packers' } },
            { homeAway: 'home', score: '7', team: { displayName: 'Chicago Bears' } },
          ],
        },
      ],
    });

    const [game] = await provider(stubFetch({ events: [reversed] })).fetchGames('2026-08-16');

    expect(game?.homeTeam).toBe('Chicago Bears');
    expect(game?.awayTeam).toBe('Green Bay Packers');
    expect(game?.homeScore).toBe(7);
    expect(game?.awayScore).toBe(3);
  });

  it('maps ESPN statuses onto the five this system models', async () => {
    const cases: [string, string][] = [
      ['STATUS_SCHEDULED', 'scheduled'],
      ['STATUS_FINAL', 'final'],
      ['STATUS_POSTPONED', 'postponed'],
      ['STATUS_CANCELED', 'cancelled'],
      // Anything mid-game is `live`: from a patron's point of view the only
      // question is whether picks are still open.
      ['STATUS_IN_PROGRESS', 'live'],
      ['STATUS_HALFTIME', 'live'],
      ['STATUS_END_PERIOD', 'live'],
    ];

    for (const [espn, expected] of cases) {
      const [game] = await provider(
        stubFetch({ events: [event({ status: { type: { name: espn } } })] }),
      ).fetchGames('2026-08-16');
      expect(game?.status, `${espn} should map to ${expected}`).toBe(expected);
    }
  });

  it('names a winner only once the game is final', async () => {
    const live = await provider(
      stubFetch({
        events: [
          event({
            status: { type: { name: 'STATUS_IN_PROGRESS' } },
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', score: '21', team: { displayName: 'Bears' } },
                  { homeAway: 'away', score: '3', team: { displayName: 'Packers' } },
                ],
              },
            ],
          }),
        ],
      }),
    ).fetchGames('2026-08-16');

    // 21-3 with a quarter to play is not a result. Calling it would let the
    // grader settle picks on a game still being played.
    expect(live[0]?.winner).toBeNull();

    const final = await provider(
      stubFetch({
        events: [
          event({
            status: { type: { name: 'STATUS_FINAL' } },
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', score: '21', team: { displayName: 'Bears' } },
                  { homeAway: 'away', score: '3', team: { displayName: 'Packers' } },
                ],
              },
            ],
          }),
        ],
      }),
    ).fetchGames('2026-08-16');

    expect(final[0]?.winner).toBe('home');
  });

  it('calls a level final game a draw', async () => {
    const [game] = await provider(
      stubFetch({
        events: [
          event({
            status: { type: { name: 'STATUS_FINAL' } },
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', score: '2', team: { displayName: 'Bears' } },
                  { homeAway: 'away', score: '2', team: { displayName: 'Packers' } },
                ],
              },
            ],
          }),
        ],
      }),
    ).fetchGames('2026-08-16');

    expect(game?.winner).toBe('draw');
  });

  it('drops an event with no teams rather than inventing them', async () => {
    // The failure this guards: reading the wrong field yields undefined, and a
    // lenient normaliser turns that into "Unknown vs Unknown" on the big
    // screen. Dropping it is visibly wrong; a fake fixture is not.
    const games = await provider(
      stubFetch({ events: [event({ competitions: [{ competitors: [] }] })] }),
    ).fetchGames('2026-08-16');

    expect(games).toEqual([]);
  });

  it('drops an event with an unusable date', async () => {
    const games = await provider(
      stubFetch({ events: [event({ date: 'not-a-date' })] }),
    ).fetchGames('2026-08-16');
    expect(games).toEqual([]);
  });

  it('returns nothing on an error status instead of throwing', async () => {
    // A poll that throws takes the scheduler down; a poll that returns nothing
    // retries in thirty seconds.
    const games = await provider(stubFetch({}, 503)).fetchGames('2026-08-16');
    expect(games).toEqual([]);
  });

  it('returns nothing when the response is not the shape we expect', async () => {
    const games = await provider(stubFetch({ nonsense: true })).fetchGames('2026-08-16');
    expect(games).toEqual([]);
  });

  it('survives a network failure', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const games = await provider(failing).fetchGames('2026-08-16');
    expect(games).toEqual([]);
  });

  it('keeps other leagues when one of them fails', async () => {
    // The whole point of per-league isolation: an NHL hiccup must not cost the
    // NFL slate.
    let call = 0;
    const flaky = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('{}', { status: 500 });
      }
      return new Response(JSON.stringify({ events: [event()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const games = await new EspnProvider({
      logger: silent,
      leagues: ['NFL', 'NBA'],
      fetchImpl: flaky,
    }).fetchGames('2026-08-16');

    expect(games).toHaveLength(1);
  });

  it('asks only for the leagues requested', async () => {
    const seen: string[] = [];
    const recording = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await new EspnProvider({ logger: silent, fetchImpl: recording }).fetchGames('2026-08-16', {
      leagues: ['NFL', 'MLB'],
    });

    expect(seen).toHaveLength(2);
    expect(seen.some((url) => url.includes('/football/nfl/'))).toBe(true);
    expect(seen.some((url) => url.includes('/baseball/mlb/'))).toBe(true);
  });

  it('puts the date in the query in ESPN’s compact form', async () => {
    const seen: string[] = [];
    const recording = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await new EspnProvider({ logger: silent, leagues: ['NFL'], fetchImpl: recording }).fetchGames(
      '2026-08-16',
    );

    expect(seen[0]).toContain('dates=20260816');
  });

  it('de-duplicates a game reported under two leagues', async () => {
    const dupe = stubFetch({ events: [event(), event()] });
    const games = await provider(dupe).fetchGames('2026-08-16');
    expect(games).toHaveLength(1);
  });
});
