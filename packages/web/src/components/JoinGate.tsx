'use client';

import { useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession, type StoredSession } from '@/lib/hooks';

/**
 * Stands between a visitor and the venue until they have a session.
 *
 * The brief has no join step — its venue entry routes straight to
 * `/venue/{code}`. But a session is what authenticates every write: without
 * one, listing your picks and placing a pick both answer 401, and the app looks
 * broken in a way that points at the wrong thing.
 *
 * The session itself is an httpOnly cookie the browser holds; what is kept in
 * localStorage is only the venue and display name, which the UI needs and
 * cannot read from a cookie.
 */
export function JoinGate({
  venueId,
  children,
}: {
  venueId: string;
  children: (session: StoredSession, onExpired: () => void) => ReactNode;
}) {
  const { session, save, clear, ready } = useSession(venueId);
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function handleJoin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = nickname.trim();
    if (trimmed === '') {
      setError('Pick a nickname first');
      return;
    }

    setJoining(true);
    setError(null);
    try {
      const player = await api.joinVenue(venueId, trimmed);
      save({ venueId, playerId: player.playerId, nickname: player.nickname });
    } catch (caught) {
      // The server's message is the useful one here: it distinguishes a taken
      // nickname (409) from a rate limit (429) from a bad venue (404), and each
      // needs a different response from the player.
      setError(caught instanceof ApiError ? caught.message : 'Could not join. Try again.');
    } finally {
      setJoining(false);
    }
  }

  // Reading localStorage happens after hydration, so render nothing rather than
  // flashing the join form at someone who is already in.
  if (!ready) {
    return <div className="p-8 text-center text-dark-400">Loading…</div>;
  }

  if (session !== null) {
    return <>{children(session, clear)}</>;
  }

  return (
    <div className="mx-auto max-w-md p-4 pt-12">
      <div className="space-y-6 rounded-xl border border-dark-700 bg-dark-800 p-8">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold">Pick a nickname</h1>
          <p className="text-dark-400">This is how you appear on the big screen.</p>
        </div>

        <form onSubmit={handleJoin} className="space-y-4" noValidate>
          <div>
            <label htmlFor="nickname" className="mb-2 block text-sm font-medium">
              Nickname
            </label>
            <input
              id="nickname"
              type="text"
              value={nickname}
              autoComplete="off"
              autoCapitalize="words"
              maxLength={30}
              onChange={(event) => {
                setNickname(event.target.value);
                setError(null);
              }}
              placeholder="e.g. Casey"
              /* 16px minimum stops iOS Safari zooming the page on focus. */
              className="w-full rounded-lg border border-dark-600 bg-dark-700 px-4 py-3 text-[16px] text-slate-100 placeholder-dark-500 focus:border-accent-green focus:outline-none"
            />
            {error !== null && (
              <p role="alert" className="mt-2 text-sm text-accent-red">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={joining}
            className="w-full rounded-lg bg-accent-green py-3 font-bold text-dark-900 transition hover:brightness-110 disabled:opacity-50"
          >
            {joining ? 'Joining…' : 'Join the game'}
          </button>
        </form>
      </div>
    </div>
  );
}
