import type { Game } from '../lib/api';

export function formatKickoff(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * In-game progress, when the backend can supply it.
 *
 * It cannot today: `quarter`, `period` and `inning` are always null because no
 * column holds them and the provider endpoint in use does not return them. The
 * component reads them anyway so the moment they are populated the UI shows
 * them with no change here.
 */
export function progressLabel(game: Game): string | null {
  return game.quarter ?? game.period ?? game.inning;
}

function TeamRow({
  name,
  logoUrl,
  score,
  showScore,
}: {
  name: string;
  logoUrl: string | null;
  score: number | null;
  showScore: boolean;
}) {
  return (
    <div className="team">
      {logoUrl === null ? (
        <span className="team__logo team__logo--placeholder" aria-hidden="true">
          {name.slice(0, 1)}
        </span>
      ) : (
        <img className="team__logo" src={logoUrl} alt="" loading="lazy" />
      )}
      <span className="team__name">{name}</span>
      {showScore && <span className="team__score">{score ?? '–'}</span>}
    </div>
  );
}

export interface GameCardProps {
  game: Game;
  onSelect: (game: Game) => void;
  pickedWinner?: 'home' | 'away' | undefined;
  /** true correct, false wrong, null not settled yet (or voided). */
  pickResult?: boolean | null;
}

export function GameCard({ game, onSelect, pickedWinner, pickResult = null }: GameCardProps) {
  const showScore = game.status === 'live' || game.status === 'final';
  const progress = progressLabel(game);
  const open = game.status === 'scheduled';
  const picked = pickedWinner !== undefined;

  return (
    <button
      type="button"
      className={`card${picked ? ' card--picked' : ''}`}
      onClick={() => onSelect(game)}
      aria-label={`${game.homeTeam} versus ${game.awayTeam}, ${
        open ? `starts ${formatKickoff(game.scheduledAt)}` : game.status
      }`}
    >
      <div className="card__head">
        <span className="chip">{game.league}</span>
        {game.status === 'live' && <span className="chip chip--live">LIVE{progress === null ? '' : ` · ${progress}`}</span>}
        {open && <span className="chip">{formatKickoff(game.scheduledAt)}</span>}
        {game.status === 'final' && <span className="chip">FINAL</span>}
        {(game.status === 'postponed' || game.status === 'cancelled') && (
          <span className="chip">{game.status.toUpperCase()}</span>
        )}
      </div>

      <TeamRow name={game.homeTeam} logoUrl={game.homeLogoUrl} score={game.homeScore} showScore={showScore} />
      <TeamRow name={game.awayTeam} logoUrl={game.awayLogoUrl} score={game.awayScore} showScore={showScore} />

      {picked && (
        <p className="card__foot">
          <span>You picked {pickedWinner === 'home' ? game.homeTeam : game.awayTeam}</span>
          {/* Only shown once settled. A wrong pick gets a muted chip rather
              than red: it is information, not a telling-off. */}
          {pickResult === true && (
            <span className="result result--win">
              <span aria-hidden="true">🎉</span> Nailed it +10
            </span>
          )}
          {pickResult === false && (
            <span className="result result--loss">Not this time</span>
          )}
        </p>
      )}
      {!picked && open && <p className="card__foot card__foot--cta">Tap to pick →</p>}
    </button>
  );
}
