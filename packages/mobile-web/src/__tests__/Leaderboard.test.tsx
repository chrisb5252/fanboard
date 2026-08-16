import { describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { Leaderboard } from '../pages/Leaderboard';
import { MyPicks, pickState } from '../pages/MyPicks';
import { groupGames } from '../pages/GamesList';
import { formatCountdown } from '../components/PickConfirmation';
import { isRetryable } from '../lib/api';
import type { Game, LeaderboardRow, MyPick } from '../lib/api';

const VENUE = '11111111-1111-1111-1111-111111111111';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, fetchLeaderboard: vi.fn() };
});

const api = await import('../lib/api');
const fetchLeaderboard = vi.mocked(api.fetchLeaderboard);

const ROWS: LeaderboardRow[] = [
  { rank: 1, nickname: 'Ada', wins: 5, losses: 1, points: 50 },
  { rank: 2, nickname: 'Chris', wins: 3, losses: 2, points: 30 },
  { rank: 3, nickname: 'Bo', wins: 2, losses: 3, points: 20 },
  { rank: 4, nickname: 'Del', wins: 1, losses: 4, points: 10 },
  { rank: 5, nickname: 'Eve', wins: 1, losses: 5, points: 10 },
  { rank: 6, nickname: 'Fay', wins: 0, losses: 6, points: 0 },
];

describe('Leaderboard', () => {
  it('renders ranks in order with wins, losses and points', async () => {
    fetchLeaderboard.mockResolvedValue(ROWS);
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);

    expect(rows).toHaveLength(6);
    expect(within(rows[0]!).getByText('Ada')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('50')).toBeInTheDocument();
    expect(within(rows[5]!).getByText('Fay')).toBeInTheDocument();
  });

  it('refetches when a realtime event says the standings moved', async () => {
    // The regression this pins: the nonce was wired to the games list and the
    // picks list but not to this view, so `leaderboard_updated` refreshed
    // everything except the leaderboard. A settled game reached every phone
    // instantly and the board still waited out its 10 second timer.
    fetchLeaderboard.mockResolvedValue(ROWS);
    const view = render(<Leaderboard venueId={VENUE} nickname="Chris" refreshNonce={0} />);

    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
    });

    view.rerender(<Leaderboard venueId={VENUE} nickname="Chris" refreshNonce={1} />);

    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledTimes(2);
    });
  });

  it('does not refetch when the nonce is unchanged', async () => {
    // A re-render for any other reason must not trigger a fetch, or every
    // phone in a busy venue hammers the endpoint on unrelated state changes.
    fetchLeaderboard.mockResolvedValue(ROWS);
    const view = render(<Leaderboard venueId={VENUE} nickname="Chris" refreshNonce={3} />);

    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
    });

    view.rerender(<Leaderboard venueId={VENUE} nickname="Ada" refreshNonce={3} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
  });

  it("highlights the current player's row", async () => {
    fetchLeaderboard.mockResolvedValue(ROWS);
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);

    await screen.findByRole('table');
    const mine = screen.getByText('Chris').closest('tr');
    expect(mine).toHaveAttribute('aria-current', 'true');
    expect(mine).toHaveClass('row--me');
  });

  it('switches period and refetches', async () => {
    fetchLeaderboard.mockResolvedValue(ROWS);
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);

    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledWith(VENUE, 'today', expect.anything());
    });

    await userEvent.click(screen.getByRole('tab', { name: 'This week' }));
    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledWith(VENUE, 'this_week', expect.anything());
    });

    await userEvent.click(screen.getByRole('tab', { name: 'All time' }));
    await waitFor(() => {
      expect(fetchLeaderboard).toHaveBeenCalledWith(VENUE, 'all_time', expect.anything());
    });

    expect(screen.getByRole('tab', { name: 'All time' })).toHaveAttribute('aria-selected', 'true');
  });

  it('auto-refreshes on an interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchLeaderboard.mockResolvedValue(ROWS);
      render(<Leaderboard venueId={VENUE} nickname="Chris" />);

      await waitFor(() => {
        expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await waitFor(() => {
        expect(fetchLeaderboard.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('nudges when the board is thin', async () => {
    fetchLeaderboard.mockResolvedValue(ROWS.slice(0, 2));
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);
    // The loading placeholder also carries role="status", so match on text.
    expect(await screen.findByText(/only 2 players/i)).toBeInTheDocument();
  });

  it('explains an empty board rather than showing a blank table', async () => {
    fetchLeaderboard.mockResolvedValue([]);
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);
    expect(await screen.findByText(/no graded picks yet/i)).toBeInTheDocument();
  });

  it('surfaces a fetch failure', async () => {
    fetchLeaderboard.mockRejectedValue(new AxiosError('offline'));
    render(<Leaderboard venueId={VENUE} nickname="Chris" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection lost/i);
  });
});

describe('groupGames', () => {
  function game(id: string, status: Game['status']): Game {
    return {
      id,
      league: 'NFL',
      homeTeam: 'H',
      awayTeam: 'A',
      homeScore: null,
      awayScore: null,
      status,
      scheduledAt: new Date().toISOString(),
      quarter: null,
      period: null,
      inning: null,
      homeLogoUrl: null,
      awayLogoUrl: null,
    };
  }

  it('splits into live, coming up and final', () => {
    const sections = groupGames([
      game('a', 'final'),
      game('b', 'live'),
      game('c', 'scheduled'),
    ]);
    expect(sections.map((s) => s.title)).toEqual(['Live', 'Coming up', 'Final']);
    expect(sections[0]?.games.map((g) => g.id)).toEqual(['b']);
  });

  it('omits empty sections', () => {
    expect(groupGames([game('a', 'live')]).map((s) => s.title)).toEqual(['Live']);
    expect(groupGames([])).toEqual([]);
  });

  it('keeps postponed and cancelled games visible under Final', () => {
    // A patron who picked one needs to see what became of it.
    const sections = groupGames([game('a', 'postponed'), game('b', 'cancelled')]);
    expect(sections[0]?.games).toHaveLength(2);
  });
});

describe('MyPicks', () => {
  function pick(overrides: Partial<MyPick>): MyPick {
    return {
      pickId: 'p1',
      gameId: 'g1',
      homeTeam: 'Bears',
      awayTeam: 'Packers',
      league: 'NFL',
      scheduledAt: new Date().toISOString(),
      gameStatus: 'final',
      predictedWinner: 'home',
      correct: null,
      points: null,
      submittedAt: new Date().toISOString(),
      gradedAt: null,
      ...overrides,
    };
  }

  it('separates pending, graded and voided', () => {
    expect(pickState(pick({ gradedAt: null }))).toBe('pending');
    expect(pickState(pick({ gradedAt: 'now', correct: true, points: 10 }))).toBe('graded');
    // Cancelled game: settled, but scored neither way. Splitting on points
    // alone would file it under Pending forever.
    expect(pickState(pick({ gradedAt: 'now', correct: null, points: null }))).toBe('void');
  });

  it('renders results and totals', () => {
    render(
      <MyPicks
        loading={false}
        error={null}
        picks={[
          pick({ pickId: 'a', gradedAt: 'now', correct: true, points: 10 }),
          pick({ pickId: 'b', gradedAt: 'now', correct: false, points: 0 }),
          pick({ pickId: 'c' }),
        ]}
      />,
    );

    expect(screen.getByText('10 points from 3 picks')).toBeInTheDocument();

    // "Pending" is both a filter tab and a cell value, so scope to the table.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Won')).toBeInTheDocument();
    expect(table.getByText('Lost')).toBeInTheDocument();
    expect(table.getByText('Pending')).toBeInTheDocument();
  });

  it('filters to pending only', async () => {
    render(
      <MyPicks
        loading={false}
        error={null}
        picks={[
          pick({ pickId: 'a', gradedAt: 'now', correct: true, points: 10 }),
          pick({ pickId: 'b' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Pending' }));

    const table = within(screen.getByRole('table'));
    expect(table.getByText('Pending')).toBeInTheDocument();
    expect(table.queryByText('Won')).not.toBeInTheDocument();
  });

  it('invites a first pick when there are none', () => {
    render(<MyPicks loading={false} error={null} picks={[]} />);
    expect(screen.getByText(/no picks yet/i)).toBeInTheDocument();
  });
});

describe('retry policy', () => {
  function withStatus(status: number): AxiosError {
    const error = new AxiosError('failed');
    error.response = {
      status,
      statusText: '',
      data: {},
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    };
    return error;
  }

  it('retries transport failures and 5xx', () => {
    expect(isRetryable(new AxiosError('offline'))).toBe(true);
    expect(isRetryable(withStatus(500))).toBe(true);
    expect(isRetryable(withStatus(503))).toBe(true);
  });

  it('never retries a decision the server already made', () => {
    // Retrying a 423 will not unlock the game; retrying a 429 deepens the
    // rate limit that produced it.
    expect(isRetryable(withStatus(423))).toBe(false);
    expect(isRetryable(withStatus(429))).toBe(false);
    expect(isRetryable(withStatus(401))).toBe(false);
    expect(isRetryable(withStatus(400))).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('shows hours then minutes and seconds', () => {
    expect(formatCountdown(3_900_000)).toBe('1h 05m');
    expect(formatCountdown(252_000)).toBe('4m 12s');
    expect(formatCountdown(0)).toBe('');
    expect(formatCountdown(-1)).toBe('');
  });
});
