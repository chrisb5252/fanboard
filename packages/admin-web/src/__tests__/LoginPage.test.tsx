import { describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { LoginPage } from '../components/LoginPage';
import { API_KEY_STORAGE } from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { useAdminStore } from '../lib/store';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, fetchSession: vi.fn() };
});

const api = await import('../lib/api');
const fetchSession = vi.mocked(api.fetchSession);

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

const SESSION = {
  venueId: '11111111-1111-1111-1111-111111111111',
  name: 'The Anchor',
  enabledLeagues: ['NFL' as const],
};

describe('LoginPage', () => {
  it('renders a single key field', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
    // The venue is resolved from the key, so there is no venue id to ask for.
    expect(screen.queryByLabelText(/venue id/i)).not.toBeInTheDocument();
  });

  it('rejects an empty key without calling the API', async () => {
    render(<LoginPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fetchSession).not.toHaveBeenCalled();
  });

  it('signs in and stores the session on success', async () => {
    fetchSession.mockResolvedValue(SESSION);
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText('API key'), 'venue-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      expect(useAdminStore.getState().session).toEqual(SESSION);
    });
    expect(window.sessionStorage.getItem(API_KEY_STORAGE)).toBe('venue-key-123');
  });

  it('uses sessionStorage, never localStorage', async () => {
    fetchSession.mockResolvedValue(SESSION);
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText('API key'), 'venue-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      expect(window.sessionStorage.getItem(API_KEY_STORAGE)).toBe('venue-key-123');
    });
    // localStorage would survive the browser closing on a shared back-office PC.
    expect(window.localStorage.getItem(API_KEY_STORAGE)).toBeNull();
  });

  it('shows "Invalid API key" on 401 and keeps nothing', async () => {
    fetchSession.mockRejectedValue(axiosErrorWithStatus(401));
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText('API key'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid API key.');
    // A failed attempt must not leave the key behind for the next request.
    expect(window.sessionStorage.getItem(API_KEY_STORAGE)).toBeNull();
    expect(useAdminStore.getState().session).toBeNull();
  });

  it('reports a network failure differently from a bad key', async () => {
    fetchSession.mockRejectedValue(new AxiosError('offline'));
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText('API key'), 'venue-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);
  });

  it('shows a loading state and blocks double submission', async () => {
    let release!: (value: typeof SESSION) => void;
    fetchSession.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText('API key'), 'venue-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    release(SESSION);
    await waitFor(() => {
      expect(fetchSession).toHaveBeenCalledTimes(1);
    });
  });

  it('masks the key as it is typed', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  });
});

describe('admin error mapping', () => {
  it('separates a bad key from a wrong-venue key', () => {
    // 401 means sign in again; 403 means the same key will fail identically,
    // so bouncing to login would send the operator round a loop.
    expect(toAdminError(axiosErrorWithStatus(401)).requiresLogin).toBe(true);
    expect(toAdminError(axiosErrorWithStatus(403)).requiresLogin).toBe(false);
  });

  it('maps the statuses an admin will actually hit', () => {
    expect(toAdminError(axiosErrorWithStatus(404)).message).toMatch(/not found/i);
    expect(toAdminError(axiosErrorWithStatus(429)).kind).toBe('rate_limited');
    expect(toAdminError(axiosErrorWithStatus(500)).kind).toBe('server');
    expect(toAdminError(new AxiosError('x')).kind).toBe('network');
  });

  it('surfaces the server message for a conflict', () => {
    const error = axiosErrorWithStatus(409, {
      error: { message: 'This Fire TV device is already paired to this venue' },
    });
    expect(toAdminError(error).message).toMatch(/already paired/i);
  });
});
