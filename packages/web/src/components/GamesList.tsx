'use client';

import { api } from '@/lib/api';
import { usePolling, useNow } from '@/lib/hooks';
import { encouragement, isHotHand, playerStats, pointsToNextRank } from '@/lib/stats';
import type { Game, LeaderboardEntry, MyPick } from '@/lib/types';
import { GameCard } from './GameCard';

/** Live first, then upcoming, then anything settled. */
function group(games: readonly Game[]) {
  return [
    { key: 'live', title: 'Live', games: games.filter((g) => g.status === 'live') },
    { key: 'upcoming', title: 'Coming up', games: games.filter((g) => g.status === 'scheduled') },
    {
      key: 'done',
      title: 'Final',
      games: games.filter((g) => g.status === 'final' || g.status === 'postponed' || g.status === 'cancelled'),
    },
  ].filter((section) => section.games.length > 0);
}

export function GamesList({ venueId, nickname }: { venueId: string; nickname: string }) {
  const now = useNow();

  const games = usePolling<Game[]>((signal) => api.getGames(venueId, signal), 10_000);
  const picks = usePolling<MyPick[]>((signal) => api.getMyPicks(venueId, signal), 10_000);
  const board = usePolling<LeaderboardEntry[]>(
    (signal) => api.getLeaderboard(venueId, 'this_week', signal),
    30_000,
  );

  const myPicks = picks.data ?? [];
  const stats = playerStats(myPicks);
  const chase = pointsToNextRank(board.data ?? [], nickname);
  const pickByGame = new Map(myPicks.map((pick) => [pick.gameId, pick]));

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4">
      <section className="rounded-xl border border-dark-700 bg-dark-800 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">Pick Games</h1>
          {stats.streak > 0 && (
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ${
                isHotHand(stats.streak)
                  ? 'bg-accent-amber/20 text-accent-amber'
                  : 'bg-dark-700 text-dark-400'
              }`}
            >
              <span aria-hidden="true">🔥 {stats.streak}</span>
              <span className="sr-only">
                {stats.streak} correct pick{stats.streak === 1 ? '' : 's'} in a row
              </span>
            </span>
          )}
        </div>

        <p className="text-slate-100">{encouragement(stats.streak, stats.picksTotal)}</p>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-dark-400">
          <span>{stats.totalPoints} pts</span>
          {chase !== null && (
            <span className="font-semibold text-slate-100">
              {chase.behind} to catch {chase.target}
            </span>
          )}
        </div>
      </section>

      {games.error !== null && games.data === null && (
        <p role="alert" className="rounded-lg border border-accent-red bg-accent-red/10 p-4 text-accent-red">
          {games.error}
        </p>
      )}

      {games.loading && <p className="p-8 text-center text-dark-400">Loading tonight&rsquo;s games…</p>}

      {!games.loading && group(games.data ?? []).length === 0 && (
        <p className="rounded-xl border border-dark-700 bg-dark-800 p-8 text-center text-dark-400">
          No games on here just yet. Check back soon!
        </p>
      )}

      {group(games.data ?? []).map((section) => (
        <section key={section.key} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-dark-400">
            {section.title}
          </h2>
          <div className="space-y-3">
            {section.games.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                venueId={venueId}
                pick={pickByGame.get(game.id)}
                now={now}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
