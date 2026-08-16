'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/hooks';
import { pointsToNextRank } from '@/lib/stats';
import type { LeaderboardEntry, LeaderboardPeriod } from '@/lib/types';
import { LeaderboardRow } from './LeaderboardRow';

const TABS: { id: LeaderboardPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This Week' },
  { id: 'all_time', label: 'All Time' },
];

export function LeaderboardView({ venueId, nickname }: { venueId: string; nickname: string }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('this_week');

  // period is in the key so switching tabs refetches immediately rather than
  // showing the previous window's rows until the next poll.
  const board = usePolling<LeaderboardEntry[]>(
    (signal) => api.getLeaderboard(venueId, period, signal),
    10_000,
  );

  const rows = board.data ?? [];
  const chase = pointsToNextRank(rows, nickname);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">🏆 Leaderboard</h1>

      <div role="tablist" aria-label="Leaderboard period" className="flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={period === tab.id}
            onClick={() => setPeriod(tab.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              period === tab.id
                ? 'bg-accent-green text-dark-900'
                : 'bg-dark-800 text-dark-400 hover:bg-dark-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {chase !== null && (
        <p className="rounded-xl bg-accent-green/10 p-3 text-sm">
          <strong>{chase.behind}</strong> {chase.behind === 1 ? 'point' : 'points'} to catch{' '}
          {chase.target}. You got this!
        </p>
      )}

      {board.loading && <p className="p-8 text-center text-dark-400">Loading standings…</p>}

      {!board.loading && rows.length === 0 && (
        <p className="rounded-xl border border-dark-700 bg-dark-800 p-8 text-center text-dark-400">
          No graded picks yet. Standings appear once games finish.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((entry) => (
            <LeaderboardRow
              key={`${entry.rank}-${entry.nickname}`}
              entry={entry}
              isMe={entry.nickname === nickname}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
