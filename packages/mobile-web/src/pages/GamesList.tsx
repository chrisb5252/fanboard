import { useCallback, useMemo } from 'react';
import { fetchGames, type Game, type MyPick } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { GameCard } from '../components/GameCard';

const REFRESH_MS = 30_000;

interface Section {
  key: string;
  title: string;
  games: Game[];
}

/**
 * Groups into the three sections the brief names.
 *
 * The API returns lower-case statuses (`live`, `scheduled`, `final`) — the
 * uppercase forms in the brief do not exist anywhere in the system. Postponed
 * and cancelled games are folded into FINAL rather than dropped: a patron who
 * picked one needs to see what became of it.
 */
export function groupGames(games: readonly Game[]): Section[] {
  const live = games.filter((game) => game.status === 'live');
  const upcoming = games.filter((game) => game.status === 'scheduled');
  const done = games.filter(
    (game) =>
      game.status === 'final' || game.status === 'postponed' || game.status === 'cancelled',
  );

  return [
    { key: 'live', title: 'Live', games: live },
    { key: 'upcoming', title: 'Coming up', games: upcoming },
    { key: 'final', title: 'Final', games: done },
  ].filter((section) => section.games.length > 0);
}

export interface GamesListProps {
  venueId: string;
  picks: MyPick[];
  onSelectGame: (game: Game) => void;
  onSessionExpired: () => void;
}

export function GamesList({ venueId, picks, onSelectGame, onSessionExpired }: GamesListProps) {
  const fetcher = useCallback(
    (signal: AbortSignal) => fetchGames(venueId, signal),
    [venueId],
  );

  const { data, error, loading } = usePolling<Game[]>(fetcher, REFRESH_MS, {
    onError: (friendly) => {
      if (friendly.requiresReauth) {
        onSessionExpired();
      }
    },
  });

  const pickByGame = useMemo(() => {
    const map = new Map<string, MyPick>();
    for (const pick of picks) {
      map.set(pick.gameId, pick);
    }
    return map;
  }, [picks]);

  const sections = useMemo(() => groupGames(data ?? []), [data]);

  if (loading) {
    return <p className="state" role="status">Loading tonight&rsquo;s games…</p>;
  }

  if (data === null && error !== null) {
    return (
      <p className="state state--error" role="alert">
        {error.message}
      </p>
    );
  }

  if (sections.length === 0) {
    return <p className="state">No games scheduled here today. Check back later.</p>;
  }

  return (
    <div className="page">
      {/* A failed refresh keeps the last good list on screen rather than
          blanking it; the banner says the data may be stale. */}
      {error !== null && (
        <p className="banner" role="status">
          {error.message}
        </p>
      )}

      {sections.map((section) => (
        <section key={section.key} className="section">
          <h2 className="section__title">{section.title}</h2>
          <div className="section__body">
            {section.games.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                onSelect={onSelectGame}
                pickedWinner={pickByGame.get(game.id)?.predictedWinner}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
