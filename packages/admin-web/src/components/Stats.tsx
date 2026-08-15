import { useEffect, useState } from 'react';
import { fetchGames, fetchPicks, fetchPlayers, type AdminPick, type Game } from '../lib/api';
import { toAdminError } from '../lib/api-error';

const PLAYER_SAMPLE = 200;

export interface StatSummary {
  players: number;
  playersCapped: boolean;
  picks: number;
  picksCapped: boolean;
  gamesCompleted: number;
  gamesTotal: number;
  popularTeam: string | null;
  popularCount: number;
}

/**
 * Derives the summary from the endpoints that exist.
 *
 * There is no stats endpoint, and the list endpoints return pages rather than
 * totals, so these are counts over what could be fetched: up to 200 players and
 * up to 1000 picks. Both are flagged when they hit the ceiling instead of being
 * presented as exact — a number an operator cannot trust is worse than one that
 * admits its limits.
 */
export function summarise(
  players: { length: number },
  picks: AdminPick[],
  games: Game[],
): StatSummary {
  const byTeam = new Map<string, number>();
  const gameById = new Map(games.map((game) => [game.id, game]));

  for (const pick of picks) {
    const game = gameById.get(pick.gameId);
    if (game === undefined) {
      continue;
    }
    const team = pick.predictedWinner === 'home' ? game.homeTeam : game.awayTeam;
    byTeam.set(team, (byTeam.get(team) ?? 0) + 1);
  }

  let popularTeam: string | null = null;
  let popularCount = 0;
  for (const [team, count] of byTeam) {
    if (count > popularCount) {
      popularTeam = team;
      popularCount = count;
    }
  }

  return {
    players: players.length,
    playersCapped: players.length >= PLAYER_SAMPLE,
    picks: picks.length,
    picksCapped: picks.length >= 1000,
    gamesCompleted: games.filter((game) => game.status === 'final').length,
    gamesTotal: games.length,
    popularTeam,
    popularCount,
  };
}

export function Stats({ venueId }: { venueId: string }) {
  const [summary, setSummary] = useState<StatSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const [players, picks, games] = await Promise.all([
          fetchPlayers(venueId, PLAYER_SAMPLE, 0, controller.signal),
          fetchPicks(venueId, {}, controller.signal),
          fetchGames(venueId, controller.signal),
        ]);
        setSummary(summarise(players, picks, games));
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(toAdminError(caught).message);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [venueId]);

  if (error !== null) {
    return (
      <section className="page">
        <h1 className="page__title">Overview</h1>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (summary === null) {
    return <p className="state" role="status">Loading overview…</p>;
  }

  return (
    <section className="page">
      <h1 className="page__title">Overview</h1>
      <p className="page__lede">Today at this venue.</p>

      <div className="stats">
        <Stat
          label="Players"
          value={summary.playersCapped ? `${summary.players}+` : String(summary.players)}
        />
        <Stat
          label="Picks submitted"
          value={summary.picksCapped ? `${summary.picks}+` : String(summary.picks)}
        />
        <Stat label="Games completed" value={`${summary.gamesCompleted} / ${summary.gamesTotal}`} />
        <Stat
          label="Most picked"
          value={summary.popularTeam ?? '—'}
          sub={
            summary.popularTeam === null
              ? undefined
              : `${summary.popularCount} ${summary.popularCount === 1 ? 'pick' : 'picks'}`
          }
        />
      </div>

      {(summary.playersCapped || summary.picksCapped) && (
        <p className="hint">
          Counts marked with + hit the page limit — there is no totals endpoint, so these are
          derived from the first page of results.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {sub !== undefined && <span className="stat__sub">{sub}</span>}
    </div>
  );
}
