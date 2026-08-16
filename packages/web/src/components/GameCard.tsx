'use client';

import Link from 'next/link';
import type { Game, MyPick } from '@/lib/types';
import { formatKickoff, timeUntil } from '@/lib/stats';

export interface GameCardProps {
  game: Game;
  venueId: string;
  pick?: MyPick | undefined;
  now: number;
}

function StatusChip({ game }: { game: Game }) {
  if (game.status === 'live') {
    return <span className="rounded-full bg-accent-red/20 px-2 py-1 text-xs font-bold uppercase text-accent-red">Live</span>;
  }
  if (game.status === 'final') {
    return <span className="rounded-full bg-dark-700 px-2 py-1 text-xs font-bold uppercase text-dark-400">Final</span>;
  }
  if (game.status === 'postponed' || game.status === 'cancelled') {
    return <span className="rounded-full bg-dark-700 px-2 py-1 text-xs font-bold uppercase text-dark-400">{game.status}</span>;
  }
  return <span className="rounded-full bg-dark-700 px-2 py-1 text-xs font-medium text-dark-400">{formatKickoff(game.scheduledAt)}</span>;
}

/**
 * One fixture.
 *
 * A whole card is the tap target — this is the primary action of the app and it
 * happens one-handed. Open games link to the pick screen; closed ones render as
 * a plain block, so nothing invites a tap that would only be refused.
 */
export function GameCard({ game, venueId, pick, now }: GameCardProps) {
  const open = game.status === 'scheduled';
  const showScore = game.status === 'live' || game.status === 'final';
  const countdown = open ? timeUntil(game.scheduledAt, now) : '';

  const body = (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-dark-700 px-2 py-1 text-xs font-medium uppercase text-dark-400">
          {game.league}
        </span>
        <StatusChip game={game} />
        {countdown !== '' && (
          <span className="ml-auto text-xs font-semibold text-accent-amber">Locks in {countdown}</span>
        )}
      </div>

      {([['home', game.homeTeam, game.homeScore], ['away', game.awayTeam, game.awayScore]] as const).map(
        ([side, team, score]) => (
          <div key={side} className="flex items-center gap-3 py-1">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-dark-700 text-sm font-bold text-dark-400">
              {team.slice(0, 1)}
            </span>
            <span className={`font-medium ${pick?.predictedWinner === side ? 'text-accent-green' : ''}`}>
              {team}
            </span>
            {showScore && <span className="ml-auto text-lg font-bold">{score ?? '–'}</span>}
          </div>
        ),
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        {pick === undefined ? (
          <span className={open ? 'font-medium text-accent-green' : 'text-dark-400'}>
            {open ? 'Tap to pick →' : 'No pick'}
          </span>
        ) : (
          <>
            <span className="text-dark-400">
              You picked {pick.predictedWinner === 'home' ? game.homeTeam : game.awayTeam}
            </span>
            {pick.correct === true && (
              <span className="rounded-full bg-accent-green/20 px-2 py-1 text-xs font-bold text-accent-green">
                🎉 Nailed it +{pick.points ?? 10}
              </span>
            )}
            {pick.correct === false && (
              <span className="rounded-full bg-white/5 px-2 py-1 text-xs font-bold text-dark-400">
                Not this time
              </span>
            )}
          </>
        )}
      </div>
    </>
  );

  const shell = `block rounded-xl border p-4 transition ${
    pick !== undefined ? 'border-accent-green bg-dark-800' : 'border-dark-700 bg-dark-800'
  }`;

  if (!open) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <Link
      href={`/venue/${venueId}/games/${game.id}`}
      className={`${shell} hover:border-accent-green hover:bg-dark-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green`}
      aria-label={`${game.homeTeam} versus ${game.awayTeam}, starts ${formatKickoff(game.scheduledAt)}`}
    >
      {body}
    </Link>
  );
}
