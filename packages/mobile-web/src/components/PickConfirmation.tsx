import { useEffect, useState } from 'react';
import type { Game, PredictedWinner } from '../lib/api';

/** Formats milliseconds as "1h 04m" or "4m 12s". Empty once elapsed. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) {
    return '';
  }
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export interface PickConfirmationProps {
  game: Game;
  winner: PredictedWinner;
  onBack: () => void;
}

export function PickConfirmation({ game, winner, onBack }: PickConfirmationProps) {
  const lockAt = new Date(game.scheduledAt).getTime();
  const [remaining, setRemaining] = useState(() => lockAt - Date.now());

  useEffect(() => {
    // Only tick while there is something to count down to.
    if (game.status !== 'scheduled') {
      return;
    }
    const timer = setInterval(() => {
      setRemaining(lockAt - Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [game.status, lockAt]);

  const countdown = game.status === 'scheduled' ? formatCountdown(remaining) : '';
  const team = winner === 'home' ? game.homeTeam : game.awayTeam;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="modal modal--confirm">
        <div className="tick" aria-hidden="true">
          ✓
        </div>
        <h2 className="title" id="confirm-title">
          Pick submitted
        </h2>
        <p className="lede">
          {game.homeTeam} vs {game.awayTeam}
        </p>
        <p className="pick-summary">
          You picked <strong>{team}</strong>
        </p>

        <p className="hint" role="status">
          {countdown === ''
            ? 'Picks for this game are now closed.'
            : `You can change your pick for another ${countdown}.`}
        </p>

        <button className="button button--primary" type="button" onClick={onBack}>
          Back to games
        </button>
      </div>
    </div>
  );
}
