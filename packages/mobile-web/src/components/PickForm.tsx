import { useState } from 'react';
import { submitPick, type Game, type PredictedWinner } from '../lib/api';
import { toFriendlyError } from '../lib/error-handler';
import { formatKickoff } from './GameCard';

export interface PickFormProps {
  venueId: string;
  game: Game;
  existingPick?: PredictedWinner | undefined;
  onSubmitted: (winner: PredictedWinner) => void;
  onClose: () => void;
  onSessionExpired: () => void;
}

export function PickForm({
  venueId,
  game,
  existingPick,
  onSubmitted,
  onClose,
  onSessionExpired,
}: PickFormProps) {
  const [choice, setChoice] = useState<PredictedWinner | null>(existingPick ?? null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The server decides this too, atomically, at write time. This only keeps the
  // button from inviting a tap that is guaranteed to fail.
  const locked = game.status !== 'scheduled';

  async function handleSubmit(): Promise<void> {
    if (choice === null || submitting || locked) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await submitPick(venueId, game.id, choice);
      onSubmitted(choice);
    } catch (caught) {
      const friendly = toFriendlyError(caught);
      if (friendly.requiresReauth) {
        onSessionExpired();
        return;
      }
      setError(friendly.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pick-title">
      <div className="modal">
        <h2 className="title" id="pick-title">
          {game.homeTeam} vs {game.awayTeam}
        </h2>
        <p className="lede">
          {locked
            ? 'Picks are closed for this game.'
            : `Starts ${formatKickoff(game.scheduledAt)} · who wins?`}
        </p>

        {(game.status === 'live' || game.status === 'final') && (
          <p className="score-line">
            {game.homeTeam} {game.homeScore ?? '–'} · {game.awayTeam} {game.awayScore ?? '–'}
          </p>
        )}

        <fieldset className="stack" disabled={locked || submitting}>
          <legend className="label">Your pick</legend>
          {(['home', 'away'] as const).map((side) => {
            const team = side === 'home' ? game.homeTeam : game.awayTeam;
            return (
              <label className={`choice${choice === side ? ' choice--selected' : ''}`} key={side}>
                <input
                  type="radio"
                  name="predictedWinner"
                  value={side}
                  checked={choice === side}
                  onChange={() => {
                    setChoice(side);
                    setError(null);
                  }}
                />
                <span>{team}</span>
              </label>
            );
          })}
        </fieldset>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button
          className="button button--primary"
          type="button"
          onClick={() => void handleSubmit()}
          disabled={locked || submitting || choice === null}
        >
          {submitting ? 'Submitting…' : existingPick === undefined ? 'Submit pick' : 'Change pick'}
        </button>
        <button className="button button--ghost" type="button" onClick={onClose}>
          Back to games
        </button>
      </div>
    </div>
  );
}
