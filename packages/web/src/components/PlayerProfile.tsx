'use client';

import { api } from '@/lib/api';
import { usePolling } from '@/lib/hooks';
import { isHotHand, myRank, playerStats } from '@/lib/stats';
import type { LeaderboardEntry, MyPick } from '@/lib/types';

/**
 * The player's own numbers.
 *
 * There is no profile endpoint and no profile table — the brief assumed one.
 * Every figure here is an aggregate over the player's picks plus their row on
 * the board, both of which they can already fetch. Deriving them costs nothing,
 * cannot drift from the picks list the player is looking at, and works today;
 * calling an invented endpoint would have produced a screen that 404s.
 */
export function PlayerProfile({ venueId, nickname }: { venueId: string; nickname: string }) {
  const picks = usePolling<MyPick[]>((signal) => api.getMyPicks(venueId, signal), 15_000);
  const board = usePolling<LeaderboardEntry[]>(
    (signal) => api.getLeaderboard(venueId, 'all_time', signal),
    30_000,
  );

  const stats = playerStats(picks.data ?? []);
  const rank = myRank(board.data ?? [], nickname);

  if (picks.loading) {
    return <p className="p-8 text-center text-dark-400">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="space-y-5 rounded-xl border border-dark-700 bg-dark-800 p-6 text-center">
        <div>
          <h1 className="text-3xl font-bold">{nickname}</h1>
          <p className="text-dark-400">
            {rank === null ? 'Not on the board yet' : `Ranked #${rank.rank} of all time`}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-4 border-t border-dark-600 pt-5">
          <div>
            <dd className="text-2xl font-bold text-accent-green">{stats.totalPoints}</dd>
            <dt className="text-sm text-dark-400">Total points</dt>
          </div>
          <div>
            {/* An em dash rather than 0% for a player with nothing settled:
                zero reads as "you are losing", not "you have not started". */}
            <dd className="text-2xl font-bold text-accent-amber">
              {stats.picksTotal === 0 ? '—' : `${stats.winRate}%`}
            </dd>
            <dt className="text-sm text-dark-400">Win rate</dt>
          </div>
        </dl>

        <dl className="grid grid-cols-3 gap-4 border-t border-dark-600 pt-5">
          <div>
            <dd className="text-xl font-bold">{stats.picksCorrect}</dd>
            <dt className="text-sm text-dark-400">Correct</dt>
          </div>
          <div>
            <dd className="text-xl font-bold">{stats.picksTotal}</dd>
            <dt className="text-sm text-dark-400">Settled</dt>
          </div>
          <div>
            <dd className="text-xl font-bold">{stats.pending}</dd>
            <dt className="text-sm text-dark-400">Pending</dt>
          </div>
        </dl>

        {isHotHand(stats.streak) && (
          <p className="rounded-lg border border-accent-amber bg-accent-amber/20 p-3 font-bold">
            🔥 {stats.streak}-pick streak!
          </p>
        )}
      </div>
    </div>
  );
}
