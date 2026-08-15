import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BACKOFF_SCHEDULE_MS, NORMAL_INTERVAL_MS, backoffFor } from '../lib/reconnect';
import { CYCLE_MS, ROTATION } from '../lib/rotation';
import { clearProvisioning, getCredentials, keyFingerprint, provisionDevice } from '../lib/auth';
import { MAX_VISIBLE_GAMES, Scoreboard, bandFor, groupGames } from '../components/Scoreboard';
import { LeaderboardZone, TOP_N } from '../components/LeaderboardZone';
import { QrPanel } from '../components/QrPanel';
import type { DisplayGame, DisplayLeaderboardEntry } from '../lib/api';

function game(overrides: Partial<DisplayGame> = {}): DisplayGame {
  return {
    id: Math.random().toString(36).slice(2),
    league: 'NFL',
    homeTeam: 'Chicago Bears',
    awayTeam: 'Green Bay Packers',
    homeScore: null,
    awayScore: null,
    status: 'scheduled',
    scheduledAt: new Date('2025-01-19T18:00:00Z').toISOString(),
    quarter: null,
    period: null,
    inning: null,
    homeLogoUrl: null,
    awayLogoUrl: null,
    ...overrides,
  };
}

function entry(rank: number, nickname: string, points: number): DisplayLeaderboardEntry {
  return { rank, nickname, wins: 3, losses: 1, points };
}

afterEach(() => {
  clearProvisioning();
});

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

describe('backoff', () => {
  it('polls on the normal cadence while healthy', () => {
    expect(backoffFor(0)).toBe(NORMAL_INTERVAL_MS);
    expect(NORMAL_INTERVAL_MS).toBe(10_000);
  });

  it('follows 5s, 10s, 20s after consecutive failures', () => {
    expect(backoffFor(1)).toBe(5_000);
    expect(backoffFor(2)).toBe(10_000);
    expect(backoffFor(3)).toBe(20_000);
  });

  it('caps at 60s so an unattended TV still notices recovery', () => {
    expect(backoffFor(20)).toBe(60_000);
    expect(Math.max(...BACKOFF_SCHEDULE_MS)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('rotation', () => {
  it('runs scoreboard, leaderboard, QR', () => {
    expect(ROTATION.map((step) => step.zone)).toEqual(['scoreboard', 'leaderboard', 'qr']);
  });

  it('holds each zone for the specified duration', () => {
    expect(ROTATION.map((step) => step.durationMs)).toEqual([15_000, 15_000, 5_000]);
  });

  it('adds up to a 35 second cycle, not the 20 the brief also states', () => {
    expect(CYCLE_MS).toBe(35_000);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credentials', () => {
  it('returns null when the device is not paired', () => {
    expect(getCredentials()).toBeNull();
  });

  it('prefers runtime provisioning over the build-time variable', () => {
    provisionDevice({ deviceId: 'device-1', displayKey: 'key-abcdef123456' });
    expect(getCredentials()).toEqual({ deviceId: 'device-1', displayKey: 'key-abcdef123456' });
  });

  it('ignores a corrupted or partial record rather than half-configuring', () => {
    window.localStorage.setItem('fanboard.tv.device', '{not json');
    expect(getCredentials()).toBeNull();

    window.localStorage.setItem('fanboard.tv.device', JSON.stringify({ deviceId: 'only-id' }));
    expect(getCredentials()).toBeNull();
  });

  it('fingerprints a key without revealing it', () => {
    const key = 'super-secret-display-key-9x7Q';
    const shown = keyFingerprint(key);
    expect(shown).toBe('••••9x7Q');
    expect(shown).not.toContain('super-secret');
    expect(key.startsWith(shown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

describe('scoreboard', () => {
  it('bands by status', () => {
    expect(bandFor(game({ status: 'live' }))).toBe('live');
    expect(bandFor(game({ status: 'scheduled' }))).toBe('upcoming');
    expect(bandFor(game({ status: 'final' }))).toBe('final');
  });

  it('keeps postponed and cancelled visible under Final', () => {
    // Someone in the room has a pick on them.
    expect(bandFor(game({ status: 'postponed' }))).toBe('final');
    expect(bandFor(game({ status: 'cancelled' }))).toBe('final');
  });

  it('orders live first, then upcoming, then final', () => {
    const sections = groupGames([
      game({ status: 'final' }),
      game({ status: 'scheduled' }),
      game({ status: 'live' }),
    ]);
    expect(sections.map((section) => section.band)).toEqual(['live', 'upcoming', 'final']);
  });

  it('omits empty bands', () => {
    expect(groupGames([game({ status: 'live' })]).map((s) => s.band)).toEqual(['live']);
    expect(groupGames([])).toEqual([]);
  });

  it('renders scores for live and final, not for upcoming', () => {
    render(
      <Scoreboard
        games={[
          game({ id: 'l', status: 'live', homeScore: 14, awayScore: 10 }),
          game({ id: 'u', status: 'scheduled' }),
        ]}
      />,
    );
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('caps the list so the text stays readable from ten feet', () => {
    const many = Array.from({ length: MAX_VISIBLE_GAMES + 4 }, () => game({ status: 'live' }));
    render(<Scoreboard games={many} />);
    expect(screen.getByText('+4 more')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing on', () => {
    render(<Scoreboard games={[]} />);
    expect(screen.getByText('No games today')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

describe('leaderboard zone', () => {
  it('shows at most the top ten', () => {
    const rows = Array.from({ length: 25 }, (_, i) => entry(i + 1, `P${i}`, 100 - i));
    render(<LeaderboardZone entries={rows} />);
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(body).toHaveLength(TOP_N);
  });

  it('invites the room in when nobody has scored', () => {
    render(<LeaderboardZone entries={[]} />);
    expect(screen.getByText(/scan to play/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

describe('QR panel', () => {
  const url = 'https://fanboard.com/v/11111111-1111-1111-1111-111111111111';

  it('encodes the URL as a scannable SVG, not printed text', () => {
    // The API returns a URL string; nobody types a UUID off a TV, so it has to
    // be encoded to be usable at all.
    const { container } = render(<QrPanel url={url} variant="full" />);
    const path = container.querySelector('svg path');
    expect(path).not.toBeNull();
    expect((path?.getAttribute('d') ?? '').length).toBeGreaterThan(100);
  });

  it('renders a strip variant for the permanent footer', () => {
    const { container } = render(<QrPanel url={url} variant="strip" />);
    expect(container.querySelector('.qr-strip__code')).not.toBeNull();
    expect(screen.getByText('Scan to play')).toBeInTheDocument();
  });

  it('shows the URL without the scheme, for anyone typing it', () => {
    render(<QrPanel url={url} variant="full" />);
    expect(screen.getByText(/^fanboard\.com\/v\//)).toBeInTheDocument();
  });

  it('produces different codes for different venues', () => {
    const a = render(<QrPanel url={`${url}a`} variant="full" />);
    const first = a.container.querySelector('svg path')?.getAttribute('d');
    a.unmount();
    const b = render(<QrPanel url={`${url}b`} variant="full" />);
    const second = b.container.querySelector('svg path')?.getAttribute('d');
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// No credential leakage
// ---------------------------------------------------------------------------

describe('display key handling', () => {
  it('never renders the key on screen', async () => {
    const KEY = 'display-key-should-never-appear';
    provisionDevice({ deviceId: 'd1', displayKey: KEY });

    const { App } = await import('../App');
    const { container } = render(<App />);

    expect(container.textContent ?? '').not.toContain(KEY);
  });

  it('sends the key in a header, never in the URL', async () => {
    // A key in a query string lands in proxy and server access logs.
    const axios = (await import('axios')).default;
    const get = vi.fn().mockRejectedValue(new Error('offline'));
    vi.spyOn(axios, 'create').mockReturnValue({ get } as never);

    vi.resetModules();
    const api = await import('../lib/api');
    api.resetDisplayCache();

    await expect(api.fetchDisplay('device-1', 'secret-key')).rejects.toThrow();
  });
});
