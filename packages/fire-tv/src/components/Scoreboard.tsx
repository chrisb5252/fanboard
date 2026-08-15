import type { DisplayGame } from '../lib/api';

/**
 * Grouping for the wall.
 *
 * The API returns lower-case statuses. Postponed and cancelled sit with FINAL
 * rather than disappearing — someone in the room has a pick on them.
 */
export type Band = 'live' | 'upcoming' | 'final';

export function bandFor(game: DisplayGame): Band {
  if (game.status === 'live') {
    return 'live';
  }
  if (game.status === 'scheduled') {
    return 'upcoming';
  }
  return 'final';
}

export function groupGames(games: readonly DisplayGame[]): { band: Band; label: string; games: DisplayGame[] }[] {
  const bands: { band: Band; label: string }[] = [
    { band: 'live', label: 'Live' },
    { band: 'upcoming', label: 'Coming up' },
    { band: 'final', label: 'Final' },
  ];

  return bands
    .map((entry) => ({ ...entry, games: games.filter((game) => bandFor(game) === entry.band) }))
    .filter((section) => section.games.length > 0);
}

export function formatKickoff(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Reads whichever progress field the sport uses. All null until the backend can supply them. */
export function progressLabel(game: DisplayGame): string | null {
  return game.quarter ?? game.period ?? game.inning;
}

/**
 * How many games fit before the text stops being readable at ten feet.
 *
 * A TV that tries to show twenty games shows none of them legibly. Beyond this
 * the list is cut and a count is shown instead.
 */
export const MAX_VISIBLE_GAMES = 6;

function Row({ game }: { game: DisplayGame }) {
  const band = bandFor(game);
  const showScore = game.status === 'live' || game.status === 'final';
  const progress = progressLabel(game);

  return (
    <li className={`game game--${band}`}>
      <div className="game__meta">
        <span className="game__league">{game.league}</span>
        <span className="game__state">
          {band === 'live' && (progress === null ? 'LIVE' : `LIVE · ${progress}`)}
          {band === 'upcoming' && formatKickoff(game.scheduledAt)}
          {band === 'final' && game.status.toUpperCase()}
        </span>
      </div>

      <div className="game__side">
        <span className="game__team">{game.homeTeam}</span>
        {showScore && <span className="game__score">{game.homeScore ?? '–'}</span>}
      </div>
      <div className="game__side">
        <span className="game__team">{game.awayTeam}</span>
        {showScore && <span className="game__score">{game.awayScore ?? '–'}</span>}
      </div>
    </li>
  );
}

export function Scoreboard({ games }: { games: DisplayGame[] }) {
  const sections = groupGames(games);

  if (sections.length === 0) {
    return (
      <div className="zone zone--empty">
        <p className="zone__empty">No games today</p>
      </div>
    );
  }

  let budget = MAX_VISIBLE_GAMES;
  const hidden = Math.max(0, games.length - MAX_VISIBLE_GAMES);

  return (
    <div className="zone">
      <h1 className="zone__title">Tonight</h1>
      <div className="bands">
        {sections.map((section) => {
          const take = section.games.slice(0, budget);
          budget -= take.length;
          if (take.length === 0) {
            return null;
          }
          return (
            <section className="band" key={section.band}>
              <h2 className={`band__title band__title--${section.band}`}>{section.label}</h2>
              <ul className="band__list">
                {take.map((game) => (
                  <Row key={game.id} game={game} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {hidden > 0 && <p className="zone__more">+{hidden} more</p>}
    </div>
  );
}
