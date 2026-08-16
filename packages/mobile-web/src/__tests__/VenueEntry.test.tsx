import { describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { VenueEntry } from '../components/VenueEntry';
import { NicknameModal, validateNicknameLocally } from '../components/NicknameModal';
import { PickForm } from '../components/PickForm';
import { toFriendlyError } from '../lib/error-handler';
import { loadSession, saveSession, venueIdFromLocation } from '../lib/session';
import type { Game } from '../lib/api';

const VENUE = '11111111-1111-1111-1111-111111111111';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, joinVenue: vi.fn(), submitPick: vi.fn() };
});

const api = await import('../lib/api');
const joinVenue = vi.mocked(api.joinVenue);
const submitPick = vi.mocked(api.submitPick);

function axiosErrorWithStatus(status: number, data: unknown = {}): AxiosError {
  const error = new AxiosError('request failed');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

const GAME: Game = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  league: 'NFL',
  homeTeam: 'Bears',
  awayTeam: 'Packers',
  homeScore: null,
  awayScore: null,
  status: 'scheduled',
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  quarter: null,
  period: null,
  inning: null,
  homeLogoUrl: null,
  awayLogoUrl: null,
};

describe('VenueEntry', () => {
  it('renders the entry prompt', () => {
    render(<VenueEntry onVenueChosen={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'FanBoard' })).toBeInTheDocument();
    expect(screen.getByLabelText('Venue code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  it('rejects a malformed venue code without calling anything', async () => {
    const onVenueChosen = vi.fn();
    render(<VenueEntry onVenueChosen={onVenueChosen} />);

    await userEvent.type(screen.getByLabelText('Venue code'), 'not-a-uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Enter' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onVenueChosen).not.toHaveBeenCalled();
  });

  it('accepts a valid code and normalises its case', async () => {
    const onVenueChosen = vi.fn();
    render(<VenueEntry onVenueChosen={onVenueChosen} />);

    await userEvent.type(screen.getByLabelText('Venue code'), VENUE.toUpperCase());
    await userEvent.click(screen.getByRole('button', { name: 'Enter' }));

    expect(onVenueChosen).toHaveBeenCalledWith(VENUE);
  });
});

describe('venue id from a scanned QR code', () => {
  it('reads ?venue= and the /v/<id> path the TV renders', () => {
    expect(venueIdFromLocation({ search: `?venue=${VENUE}`, pathname: '/' })).toBe(VENUE);
    expect(venueIdFromLocation({ search: '', pathname: `/v/${VENUE}` })).toBe(VENUE);
  });

  it('ignores anything that is not a uuid', () => {
    expect(venueIdFromLocation({ search: '?venue=evil', pathname: '/' })).toBeNull();
    expect(venueIdFromLocation({ search: '', pathname: '/' })).toBeNull();
  });
});

describe('NicknameModal', () => {
  it('submits the nickname to the API and reports the new player', async () => {
    joinVenue.mockResolvedValue({ playerId: 'p1', nickname: 'Chris' });
    const onJoined = vi.fn();

    render(<NicknameModal venueId={VENUE} onJoined={onJoined} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Nickname'), 'Chris');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(joinVenue).toHaveBeenCalledWith(VENUE, 'Chris');
    });
    expect(onJoined).toHaveBeenCalledWith({ playerId: 'p1', nickname: 'Chris' });
  });

  it('shows a loading state and blocks double submission', async () => {
    let release!: (value: { playerId: string; nickname: string }) => void;
    joinVenue.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<NicknameModal venueId={VENUE} onJoined={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Nickname'), 'Chris');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    const button = await screen.findByRole('button', { name: 'Joining…' });
    expect(button).toBeDisabled();

    release({ playerId: 'p1', nickname: 'Chris' });
    await waitFor(() => {
      expect(joinVenue).toHaveBeenCalledTimes(1);
    });
  });

  it('validates locally before spending a request', async () => {
    render(<NicknameModal venueId={VENUE} onJoined={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Nickname'), 'J');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(joinVenue).not.toHaveBeenCalled();
  });

  it('surfaces a taken nickname from the server', async () => {
    joinVenue.mockRejectedValue(
      axiosErrorWithStatus(409, {
        error: { code: 'nickname_taken', message: 'That nickname is in use at this venue.' },
      }),
    );

    render(<NicknameModal venueId={VENUE} onJoined={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Nickname'), 'Mike');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/in use at this venue/i);
  });

  it('surfaces the rate limit with a wait time', async () => {
    joinVenue.mockRejectedValue(
      axiosErrorWithStatus(429, { error: { details: { retryAfterSeconds: 3600 } } }),
    );

    render(<NicknameModal venueId={VENUE} onJoined={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Nickname'), 'Chris');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/60 minutes/i);
  });

  it('mirrors the server nickname rules', () => {
    expect(validateNicknameLocally('Chris')).toBeNull();
    expect(validateNicknameLocally('Badminton')).toBeNull();
    expect(validateNicknameLocally('J')).not.toBeNull();
    expect(validateNicknameLocally('111111')).not.toBeNull();
    expect(validateNicknameLocally('admin')).not.toBeNull();
    expect(validateNicknameLocally('aaaaaaaa')).not.toBeNull();
    expect(validateNicknameLocally('x'.repeat(31))).not.toBeNull();
  });
});

describe('session persistence', () => {
  it('stores venue, player and nickname across a refresh', () => {
    saveSession({ venueId: VENUE, playerId: 'p1', nickname: 'Chris' });
    expect(loadSession()).toEqual({ venueId: VENUE, playerId: 'p1', nickname: 'Chris' });
  });

  it('never stores the session token', () => {
    // The token lives in an HttpOnly cookie precisely so JavaScript cannot
    // reach it. Copying it here would hand it to any XSS on the page.
    saveSession({ venueId: VENUE, playerId: 'p1', nickname: 'Chris' });
    const raw = window.localStorage.getItem('fanboard.session') ?? '';
    expect(raw).not.toMatch(/session_token|sessionToken/i);
  });

  it('ignores a corrupted entry rather than crashing the app', () => {
    window.localStorage.setItem('fanboard.session', '{not json');
    expect(loadSession()).toBeNull();
  });
});

describe('PickForm', () => {
  it('submits the chosen winner', async () => {
    submitPick.mockResolvedValue({
      pickId: 'pick1',
      gameId: GAME.id,
      predictedWinner: 'home',
      locked: false,
    });
    const onSubmitted = vi.fn();

    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        onSubmitted={onSubmitted}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByLabelText('Bears'));
    await userEvent.click(screen.getByRole('button', { name: 'Lock it in' }));

    await waitFor(() => {
      expect(submitPick).toHaveBeenCalledWith(VENUE, GAME.id, 'home');
    });
    expect(onSubmitted).toHaveBeenCalledWith('home');
  });

  it('names each option as just the team, not the decoration around it', () => {
    // The option is a card carrying a placeholder initial and a tick glyph.
    // The accessible name has to stay the team, or a screen reader announces
    // "B Bears ✓".
    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: 'Bears' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Packers' })).toBeInTheDocument();
  });

  it('says what a correct pick is worth', () => {
    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );
    expect(screen.getByText(/\+10 if you call it/i)).toBeInTheDocument();
  });

  it('offers to change an existing pick rather than submit a new one', () => {
    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        existingPick="home"
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Change my pick' })).toBeInTheDocument();
    // The reassurance appears only when there is something to change, and it
    // never implies the player erred by changing their mind.
    expect(screen.getByText(/changed your mind/i)).toBeInTheDocument();
  });

  it('drops the stakes and the clock once the game is closed', () => {
    render(
      <PickForm
        venueId={VENUE}
        game={{ ...GAME, status: 'live' }}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(screen.getByText(/picks are closed/i)).toBeInTheDocument();
    expect(screen.queryByText(/if you call it/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/locks in/i)).not.toBeInTheDocument();
    // Encouraging even here: no scolding for arriving late.
    expect(screen.getByText(/catch the next one/i)).toBeInTheDocument();
  });

  it('shows the locked message on 423', async () => {
    submitPick.mockRejectedValue(axiosErrorWithStatus(423));

    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByLabelText('Packers'));
    await userEvent.click(screen.getByRole('button', { name: 'Lock it in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/picks are locked/i);
  });

  it('sends the player back to entry on 401', async () => {
    submitPick.mockRejectedValue(axiosErrorWithStatus(401));
    const onSessionExpired = vi.fn();

    render(
      <PickForm
        venueId={VENUE}
        game={GAME}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={onSessionExpired}
      />,
    );

    await userEvent.click(screen.getByLabelText('Bears'));
    await userEvent.click(screen.getByRole('button', { name: 'Lock it in' }));

    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalled();
    });
  });

  it('disables submission once the game is live', () => {
    render(
      <PickForm
        venueId={VENUE}
        game={{ ...GAME, status: 'live' }}
        onSubmitted={vi.fn()}
        onClose={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Lock it in' })).toBeDisabled();
    expect(screen.getByText(/picks are closed/i)).toBeInTheDocument();
  });
});

describe('error handler', () => {
  it('maps each status to something a patron can act on', () => {
    expect(toFriendlyError(axiosErrorWithStatus(423)).kind).toBe('locked');
    expect(toFriendlyError(axiosErrorWithStatus(404)).kind).toBe('not_found');
    expect(toFriendlyError(axiosErrorWithStatus(500)).kind).toBe('server');
    expect(toFriendlyError(new AxiosError('offline')).kind).toBe('network');
    expect(toFriendlyError(new AxiosError('offline')).message).toMatch(/connection lost/i);
  });

  it('flags only the statuses that need a fresh session', () => {
    expect(toFriendlyError(axiosErrorWithStatus(401)).requiresReauth).toBe(true);
    expect(toFriendlyError(axiosErrorWithStatus(403)).requiresReauth).toBe(true);
    expect(toFriendlyError(axiosErrorWithStatus(423)).requiresReauth).toBe(false);
  });
});
