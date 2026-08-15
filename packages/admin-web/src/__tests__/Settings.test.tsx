import { describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { Settings } from '../pages/Settings';
import { DevicePairing } from '../pages/DevicePairing';
import { Stats, summarise } from '../components/Stats';
import { formatWhen } from '../components/DeviceList';
import { useAdminStore } from '../lib/store';
import type { AdminPick, Game } from '../lib/api';

const VENUE = '11111111-1111-1111-1111-111111111111';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    fetchConfig: vi.fn(),
    saveConfig: vi.fn(),
    pairDevice: vi.fn(),
    fetchDeviceStatus: vi.fn(),
    fetchPlayers: vi.fn(),
    fetchPicks: vi.fn(),
    fetchGames: vi.fn(),
  };
});

const api = await import('../lib/api');
const fetchConfig = vi.mocked(api.fetchConfig);
const saveConfig = vi.mocked(api.saveConfig);
const pairDevice = vi.mocked(api.pairDevice);
const fetchDeviceStatus = vi.mocked(api.fetchDeviceStatus);
const fetchPlayers = vi.mocked(api.fetchPlayers);
const fetchPicks = vi.mocked(api.fetchPicks);
const fetchGames = vi.mocked(api.fetchGames);

function axiosErrorWithStatus(status: number, data: unknown = {}): AxiosError {
  const error = new AxiosError('failed');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

describe('Settings', () => {
  it('loads the current leagues and checks them', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: ['NFL', 'NHL'] });
    render(<Settings venueId={VENUE} />);

    await waitFor(() => {
      expect(fetchConfig).toHaveBeenCalledWith(VENUE);
    });

    expect(await screen.findByLabelText('NFL')).toBeChecked();
    expect(screen.getByLabelText('NHL')).toBeChecked();
    expect(screen.getByLabelText('NBA')).not.toBeChecked();
  });

  it('labels the college codes in plain English', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    render(<Settings venueId={VENUE} />);

    // NCAAFB / NCAAB are the stored codes; an operator should not decode them.
    expect(await screen.findByLabelText('College Football')).toBeInTheDocument();
    expect(screen.getByLabelText('College Basketball')).toBeInTheDocument();
  });

  it('saves the selection to the backend', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    saveConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: ['NFL'] });

    render(<Settings venueId={VENUE} />);
    await userEvent.click(await screen.findByLabelText('NFL'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(saveConfig).toHaveBeenCalledWith(VENUE, ['NFL']);
    });
  });

  it('sends leagues in whitelist order regardless of click order', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    saveConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: ['NFL', 'NBA'] });

    render(<Settings venueId={VENUE} />);
    await userEvent.click(await screen.findByLabelText('NBA'));
    await userEvent.click(screen.getByLabelText('NFL'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Canonical order keeps the audit diff meaningful.
    await waitFor(() => {
      expect(saveConfig).toHaveBeenCalledWith(VENUE, ['NFL', 'NBA']);
    });
  });

  it('confirms with a toast on success', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    saveConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });

    render(<Settings venueId={VENUE} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(useAdminStore.getState().toasts.map((t) => t.message)).toContain('Settings saved');
    });
  });

  it('reports a save failure without claiming success', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    saveConfig.mockRejectedValue(axiosErrorWithStatus(403));

    render(<Settings venueId={VENUE} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const toasts = useAdminStore.getState().toasts;
      expect(toasts.some((t) => t.tone === 'error')).toBe(true);
      expect(toasts.some((t) => t.message === 'Settings saved')).toBe(false);
    });
  });

  it('says the setting is not applied to ingestion yet', async () => {
    fetchConfig.mockResolvedValue({ venueId: VENUE, enabledLeagues: [] });
    render(<Settings venueId={VENUE} />);
    expect(await screen.findByText(/not yet applied to ingestion/i)).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    fetchConfig.mockRejectedValue(axiosErrorWithStatus(404));
    render(<Settings venueId={VENUE} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i);
  });
});

describe('DevicePairing', () => {
  it('shows the display key once and warns it cannot be shown again', async () => {
    fetchDeviceStatus.mockResolvedValue([]);
    pairDevice.mockResolvedValue({
      deviceId: 'dev-1',
      displayKey: 'SUPER-SECRET-DISPLAY-KEY',
      displayName: 'Front Bar TV',
    });

    render(<DevicePairing venueId={VENUE} />);
    await userEvent.type(screen.getByLabelText('Display name'), 'Front Bar TV');
    await userEvent.type(screen.getByLabelText('Fire TV device ID'), 'G070VM1');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    expect(await screen.findByText('SUPER-SECRET-DISPLAY-KEY')).toBeInTheDocument();
    expect(screen.getByText(/only time it can be shown/i)).toBeInTheDocument();
  });

  it('never persists the display key', async () => {
    fetchDeviceStatus.mockResolvedValue([]);
    pairDevice.mockResolvedValue({
      deviceId: 'dev-1',
      displayKey: 'SUPER-SECRET-DISPLAY-KEY',
      displayName: 'Front Bar TV',
    });

    render(<DevicePairing venueId={VENUE} />);
    await userEvent.type(screen.getByLabelText('Display name'), 'TV');
    await userEvent.type(screen.getByLabelText('Fire TV device ID'), 'G1');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));
    await screen.findByText('SUPER-SECRET-DISPLAY-KEY');

    // The server keeps only a hash; a copy here would be a second home for it.
    expect(JSON.stringify(window.sessionStorage)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(window.localStorage)).not.toContain('SUPER-SECRET');
  });

  it('dismisses the key once the operator confirms', async () => {
    fetchDeviceStatus.mockResolvedValue([]);
    pairDevice.mockResolvedValue({
      deviceId: 'dev-1',
      displayKey: 'SUPER-SECRET-DISPLAY-KEY',
      displayName: 'TV',
    });

    render(<DevicePairing venueId={VENUE} />);
    await userEvent.type(screen.getByLabelText('Display name'), 'TV');
    await userEvent.type(screen.getByLabelText('Fire TV device ID'), 'G1');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));
    await screen.findByText('SUPER-SECRET-DISPLAY-KEY');

    await userEvent.click(screen.getByRole('button', { name: /saved it/i }));
    expect(screen.queryByText('SUPER-SECRET-DISPLAY-KEY')).not.toBeInTheDocument();
  });

  it('reports a duplicate device instead of a bare failure', async () => {
    fetchDeviceStatus.mockResolvedValue([]);
    pairDevice.mockRejectedValue(
      axiosErrorWithStatus(409, {
        error: { message: 'This Fire TV device is already paired to this venue' },
      }),
    );

    render(<DevicePairing venueId={VENUE} />);
    await userEvent.type(screen.getByLabelText('Display name'), 'TV');
    await userEvent.type(screen.getByLabelText('Fire TV device ID'), 'dup');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    await waitFor(() => {
      expect(useAdminStore.getState().toasts.some((t) => /already paired/i.test(t.message))).toBe(
        true,
      );
    });
    expect(screen.queryByText(/only time it can be shown/i)).not.toBeInTheDocument();
  });

  it('lists paired displays with online state', async () => {
    fetchDeviceStatus.mockResolvedValue([
      {
        deviceId: 'd1',
        displayName: 'Front Bar TV',
        online: true,
        lastHeartbeat: new Date().toISOString(),
        fireTvDeviceId: 'G070VM1',
      },
      {
        deviceId: 'd2',
        displayName: 'Patio TV',
        online: false,
        lastHeartbeat: null,
        fireTvDeviceId: null,
      },
    ]);

    render(<DevicePairing venueId={VENUE} />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Front Bar TV')).toBeInTheDocument();
    expect(within(table).getByText(/Online/)).toBeInTheDocument();
    expect(within(table).getByText(/Offline/)).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
  });
});

describe('formatWhen', () => {
  it('reads as relative time, falling back to a date', () => {
    expect(formatWhen(null)).toBe('Never');
    expect(formatWhen(new Date().toISOString())).toBe('Just now');
    expect(formatWhen(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(formatWhen(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(formatWhen('nonsense')).toBe('Unknown');
  });
});

describe('Stats', () => {
  function game(id: string, status: string, home: string, away: string): Game {
    return {
      id,
      league: 'NFL',
      homeTeam: home,
      awayTeam: away,
      homeScore: null,
      awayScore: null,
      status,
      scheduledAt: new Date().toISOString(),
      homeLogoUrl: null,
      awayLogoUrl: null,
    };
  }

  function pick(gameId: string, side: 'home' | 'away'): AdminPick {
    return {
      pickId: Math.random().toString(36).slice(2),
      gameId,
      playerId: 'p',
      nickname: 'n',
      predictedWinner: side,
      correct: null,
      points: null,
      submittedAt: new Date().toISOString(),
      gradedAt: null,
    };
  }

  it('counts completed games and the most-picked team', () => {
    const games = [game('g1', 'final', 'Bears', 'Packers'), game('g2', 'live', 'Lions', 'Vikings')];
    const picks = [pick('g1', 'home'), pick('g1', 'home'), pick('g1', 'away')];

    const summary = summarise({ length: 12 }, picks, games);

    expect(summary.gamesCompleted).toBe(1);
    expect(summary.gamesTotal).toBe(2);
    expect(summary.popularTeam).toBe('Bears');
    expect(summary.popularCount).toBe(2);
    expect(summary.players).toBe(12);
  });

  it('flags counts that hit the page ceiling rather than implying they are exact', () => {
    const capped = summarise({ length: 200 }, [], []);
    expect(capped.playersCapped).toBe(true);
  });

  it('renders without a most-picked team when there are no picks', async () => {
    fetchPlayers.mockResolvedValue([]);
    fetchPicks.mockResolvedValue([]);
    fetchGames.mockResolvedValue([]);

    render(<Stats venueId={VENUE} />);
    expect(await screen.findByText('Most picked')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
