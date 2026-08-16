'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useNow, usePolling } from '@/lib/hooks';
import { formatKickoff, timeUntil } from '@/lib/stats';
import { POINTS_FOR_CORRECT_PICK, type Game, type MyPick, type PredictedWinner } from '@/lib/types';
import { Toast } from './Toast';

/**
 * The pick screen.
 *
 * A binary choice and nothing else. There is no stake, no slider and no odds:
 * the backend scores a correct pick at a flat 10 and a wrong one at 0, so a
 * wager interface on top of it would be inventing a product.
 *
 * The countdown is a courtesy. Whether a game is open is decided by PostgreSQL
 * inside the same statement that writes the pick, so a client clock can never
 * be the authority — which is why 423 is handled as an ordinary outcome with
 * its own sentence rather than as an unexpected failure.
 */
export function PredictionForm({
  venueId,
  gameId,
}: {
  venueId: string;
  gameId: string;
}) {
  const router = useRouter();
  const now = useNow();

  const games = usePolling<Game[]>((signal) => api.getGames(venueId, signal), 30_000);
  const picks = usePolling<MyPick[]>((signal) => api.getMyPicks(venueId, signal), 30_000);

  const game = (games.data ?? []).find((candidate) => candidate.id === gameId) ?? null;
  const existing = (picks.data ?? []).find((pick) => pick.gameId === gameId);

  const [selection, setSelection] = useState<PredictedWinner | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const chosen = selection ?? existing?.predictedWinner ?? null;
  const open = game !== null && game.status === 'scheduled';
  const countdown = open && game !== null ? timeUntil(game.scheduledAt, now) : '';

  async function handleSubmit(): Promise<void> {
    if (chosen === null || game === null || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.placePick(venueId, { gameId: game.id, predictedWinner: chosen });
      setToast('Pick locked in!');
      // Let the confirmation land before navigating, so it is actually seen.
      setTimeout(() => router.push(`/venue/${venueId}`), 900);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 423) {
        setError('This game just kicked off, so picks are closed. Catch the next one!');
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not save your pick.');
      }
      setSubmitting(false);
    }
  }

  if (games.loading) {
    return <p className="p-8 text-center text-dark-400">Loading…</p>;
  }

  if (game === null) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4 text-center">
        <p className="text-dark-400">That game is not on tonight&rsquo;s card.</p>
        <button
          type="button"
          onClick={() => router.push(`/venue/${venueId}`)}
          className="w-full rounded-lg bg-dark-800 py-3 font-bold hover:bg-dark-700"
        >
          Back to games
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold">
          {open ? 'Who is taking this one?' : 'Picks are closed'}
        </h1>
        <p className="text-dark-400">
          {game.homeTeam} vs {game.awayTeam}
        </p>
      </div>

      {open ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-accent-green/20 px-3 py-1 text-sm font-bold text-accent-green">
            🎯 +{POINTS_FOR_CORRECT_PICK} if you call it
          </span>
          {countdown !== '' && (
            <span className="text-sm font-semibold text-accent-amber">Locks in {countdown}</span>
          )}
        </div>
      ) : (
        <p className="text-dark-400">
          This one kicked off at {formatKickoff(game.scheduledAt)}. Catch the next one!
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-accent-red bg-accent-red/10 p-4 text-accent-red"
        >
          {error}
        </p>
      )}

      <fieldset disabled={!open || submitting} className="space-y-3 border-0 p-0">
        <legend className="sr-only">Your pick</legend>
        {(['home', 'away'] as const).map((side) => {
          const team = side === 'home' ? game.homeTeam : game.awayTeam;
          const selected = chosen === side;
          return (
            <label
              key={side}
              className={`flex min-h-[64px] cursor-pointer items-center gap-3 rounded-xl border-2 p-4 transition focus-within:ring-2 focus-within:ring-accent-green ${
                selected
                  ? 'border-accent-green bg-accent-green/10'
                  : 'border-dark-700 bg-dark-800 hover:border-dark-600'
              }`}
            >
              {/* A real radio, visually hidden: keyboard and screen-reader
                  behaviour come for free, and the whole card is the target. */}
              <input
                type="radio"
                name="predictedWinner"
                value={side}
                checked={selected}
                aria-label={team}
                onChange={() => {
                  setSelection(side);
                  setError(null);
                }}
                className="sr-only"
              />
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-dark-700 font-bold text-dark-400">
                {team.slice(0, 1)}
              </span>
              <span className="text-lg font-semibold">{team}</span>
              {selected && (
                <span aria-hidden="true" className="ml-auto font-bold text-accent-green">
                  ✓
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      {existing !== undefined && open && (
        <p className="text-sm text-dark-400">
          Changed your mind? Totally fine — swap it any time before kick-off.
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!open || submitting || chosen === null}
        className="w-full rounded-lg bg-accent-green py-3 text-lg font-bold text-dark-900 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Locking it in…' : existing !== undefined ? 'Change my pick' : 'Lock it in'}
      </button>

      <button
        type="button"
        onClick={() => router.push(`/venue/${venueId}`)}
        className="w-full rounded-lg border border-dark-700 py-3 font-bold text-slate-100 hover:bg-dark-800"
      >
        {open ? 'Not yet' : 'Back to games'}
      </button>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
