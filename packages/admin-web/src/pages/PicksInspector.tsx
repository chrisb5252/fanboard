import { useCallback, useEffect, useState } from 'react';
import {
  fetchGames,
  fetchPicks,
  fetchPlayers,
  type AdminPick,
  type AdminPlayer,
  type Game,
  type PickStatusFilter,
} from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { formatWhen } from '../components/DeviceList';

const PLAYER_CHOICES = 200;

/**
 * Four states, not three.
 *
 * A voided pick (cancelled game) has null points *and* a gradedAt stamp — it is
 * settled but scored neither way. The brief offers Pending / Graded / All, which
 * files every voided pick under Pending and sends whoever is debugging after a
 * grading bug that is not there. "Voided" is exposed so they can see them.
 */
const STATUSES: { id: PickStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'graded', label: 'Graded' },
  { id: 'voided', label: 'Voided' },
];

function outcome(pick: AdminPick): string {
  if (pick.gradedAt === null) {
    return 'Pending';
  }
  if (pick.correct === null) {
    return 'Void';
  }
  return pick.correct ? 'Won' : 'Lost';
}

export function PicksInspector({ venueId }: { venueId: string }) {
  const [games, setGames] = useState<Game[]>([]);
  const [players, setPlayers] = useState<AdminPlayer[]>([]);

  const [gameId, setGameId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [status, setStatus] = useState<PickStatusFilter>('all');

  const [picks, setPicks] = useState<AdminPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const loadChoices = async (): Promise<void> => {
      try {
        const [nextGames, nextPlayers] = await Promise.all([
          fetchGames(venueId, controller.signal),
          fetchPlayers(venueId, PLAYER_CHOICES, 0, controller.signal),
        ]);
        setGames(nextGames);
        setPlayers(nextPlayers);
      } catch {
        // Filter choices are a convenience; the results table reports failures.
      }
    };
    void loadChoices();
    return () => {
      controller.abort();
    };
  }, [venueId]);

  const runFilter = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      try {
        const rows = await fetchPicks(venueId, { gameId, playerId, status }, signal);
        setPicks(rows);
        setError(null);
      } catch (caught) {
        setError(toAdminError(caught).message);
      } finally {
        setLoading(false);
      }
    },
    [venueId, gameId, playerId, status],
  );

  useEffect(() => {
    const controller = new AbortController();
    void runFilter(controller.signal);
    return () => {
      controller.abort();
    };
  }, [runFilter]);

  const gameById = new Map(games.map((game) => [game.id, game]));

  return (
    <section className="page">
      <h1 className="page__title">Picks inspector</h1>
      <p className="page__lede">For working out why a game graded the way it did.</p>

      <div className="card">
        <div className="filters">
          <div>
            <label className="label" htmlFor="filter-game">
              Game
            </label>
            <select
              id="filter-game"
              className="input"
              value={gameId}
              onChange={(event) => {
                setGameId(event.target.value);
              }}
            >
              <option value="">All games</option>
              {games.map((game) => (
                <option key={game.id} value={game.id}>
                  {game.homeTeam} v {game.awayTeam} ({game.status})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="filter-player">
              Player
            </label>
            <select
              id="filter-player"
              className="input"
              value={playerId}
              onChange={(event) => {
                setPlayerId(event.target.value);
              }}
            >
              <option value="">All players</option>
              {players.map((player) => (
                <option key={player.playerId} value={player.playerId}>
                  {player.nickname}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="filter-status">
              Status
            </label>
            <select
              id="filter-status"
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as PickStatusFilter);
              }}
            >
              {STATUSES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <button
            className="button button--primary"
            type="button"
            onClick={() => void runFilter()}
            disabled={loading}
          >
            {loading ? 'Filtering…' : 'Filter'}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => {
              setGameId('');
              setPlayerId('');
              setStatus('all');
            }}
          >
            Reset
          </button>
        </div>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="state" role="status">Loading picks…</p>
        ) : picks.length === 0 ? (
          <p className="state">No picks match those filters.</p>
        ) : (
          <>
            <p className="hint">
              {picks.length} {picks.length === 1 ? 'pick' : 'picks'}
              {picks.length >= 1000 && ' (capped at 1000 — narrow the filters)'}
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Game</th>
                    <th scope="col">Player</th>
                    <th scope="col">Pick</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="numeric">
                      Points
                    </th>
                    <th scope="col">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {picks.map((pick) => {
                    const game = gameById.get(pick.gameId);
                    const picked =
                      game === undefined
                        ? pick.predictedWinner
                        : pick.predictedWinner === 'home'
                          ? game.homeTeam
                          : game.awayTeam;
                    return (
                      <tr key={pick.pickId}>
                        <td>
                          {game === undefined
                            ? pick.gameId.slice(0, 8)
                            : `${game.homeTeam} v ${game.awayTeam}`}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="linklike"
                            onClick={() => {
                              setPlayerId(pick.playerId);
                              setGameId('');
                            }}
                          >
                            {pick.nickname}
                          </button>
                        </td>
                        <td>{picked}</td>
                        <td>{outcome(pick)}</td>
                        <td className="numeric">{pick.points ?? '—'}</td>
                        <td>{formatWhen(pick.submittedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
