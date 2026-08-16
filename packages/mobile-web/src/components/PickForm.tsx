import { useEffect, useState } from 'react';
import { submitPick, type Game, type PredictedWinner } from '../lib/api';
import { toFriendlyError } from '../lib/error-handler';
import { POINTS_FOR_CORRECT_PICK } from '../lib/gamification';
import { formatKickoff } from './GameCard';
import { formatCountdown } from './PickConfirmation';

export interface PickFormProps {
  venueId: string;
  game: Game;
  existingPick?: PredictedWinner | undefined;
  onSubmitted: (winner: PredictedWinner) => void;
  onClose: () => void;
  onSessionExpired: () => void;
}

/** Ticks once a second so the time-to-lock stays honest while the sheet is open. */
function useCountdown(iso: string, active: boolean): string {
  const [label, setLabel] = useState(() => formatCountdown(new Date(iso).getTime() - Date.now()));

  useEffect(() => {
    if (!active) {
      return;
    }
    const tick = (): void => {
      setLabel(formatCountdown(new Date(iso).getTime() - Date.now()));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [iso, active]);

  return label;
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
  const countdown = useCountdown(game.scheduledAt, !locked);
  const changing = existingPick !== undefined;

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
      <div className="modal modal--sheet">
        <h2 className="pick-title" id="pick-title">
          {locked ? 'Picks are closed' : "Who's taking this one?"}
        </h2>

        <p className="pick-sub">
          {game.homeTeam} vs {game.awayTeam}
        </p>

        {/* Stakes and urgency together, stated plainly. The countdown is the
            one bit of pressure in the app and it is factual, not a nag. */}
        {!locked && (
          <div className="pick-meta">
            <span className="pick-meta__reward">
              <span aria-hidden="true">🎯</span> +{POINTS_FOR_CORRECT_PICK} if you call it
            </span>
            {countdown !== '' && (
              <span className="pick-meta__clock">
                Locks in {countdown}
              </span>
            )}
          </div>
        )}

        {locked && (
          <p className="lede">
            This one kicked off at {formatKickoff(game.scheduledAt)}. Catch the next one!
          </p>
        )}

        {(game.status === 'live' || game.status === 'final') && (
          <p className="score-line">
            {game.homeTeam} {game.homeScore ?? '–'} · {game.awayTeam} {game.awayScore ?? '–'}
          </p>
        )}

        <fieldset className="pick-options" disabled={locked || submitting}>
          <legend className="visually-hidden">Your pick</legend>
          {(['home', 'away'] as const).map((side) => {
            const team = side === 'home' ? game.homeTeam : game.awayTeam;
            const logo = side === 'home' ? game.homeLogoUrl : game.awayLogoUrl;
            const selected = choice === side;
            return (
              <label
                className={`pick-option${selected ? ' pick-option--selected' : ''}`}
                key={side}
              >
                {/* A real radio, visually hidden: keyboard, screen readers and
                    the arrow-key group behaviour all come for free, and the
                    whole card becomes the 44px+ target. */}
                <input
                  className="visually-hidden"
                  type="radio"
                  name="predictedWinner"
                  value={side}
                  // Names the option as just the team. Without it the label's
                  // own text is announced, which now includes the placeholder
                  // initial and the tick — "B Bears ✓".
                  aria-label={team}
                  checked={selected}
                  onChange={() => {
                    setChoice(side);
                    setError(null);
                  }}
                />
                {logo === null ? (
                  <span className="pick-option__logo" aria-hidden="true">
                    {team.slice(0, 1)}
                  </span>
                ) : (
                  <img className="pick-option__logo" src={logo} alt="" loading="lazy" />
                )}
                <span className="pick-option__team">{team}</span>
                <span className="pick-option__tick" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
              </label>
            );
          })}
        </fieldset>

        {changing && !locked && (
          <p className="hint">Changed your mind? Totally fine — swap it any time before kick-off.</p>
        )}

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button
          className="button button--primary button--lock"
          type="button"
          onClick={() => void handleSubmit()}
          disabled={locked || submitting || choice === null}
        >
          {submitting ? 'Locking it in…' : changing ? 'Change my pick' : 'Lock it in'}
        </button>
        <button className="button button--ghost" type="button" onClick={onClose}>
          {locked ? 'Back to games' : 'Not yet'}
        </button>
      </div>
    </div>
  );
}
