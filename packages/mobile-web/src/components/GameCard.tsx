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
}

export function GameCard({ game, onSelect, pickedWinner }: GameCardProps) {
  const showScore = game.status === 'live' || game.status === 'final';
  const progress = progressLabel(game);
  const open = game.status === 'scheduled';

  return (
    <button
      type="button"
      className="card"
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

      {pickedWinner !== undefined && (
        <p className="card__foot">
          Your pick: {pickedWinner === 'home' ? game.homeTeam : game.awayTeam}
        </p>
      )}
      {pickedWinner === undefined && open && <p className="card__foot card__foot--cta">Tap to pick</p>}
    </button>
  );
}
