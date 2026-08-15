import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchPlayers, type AdminPlayer } from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { formatWhen } from '../components/DeviceList';

const PAGE_SIZE = 50;

export function Players({ venueId }: { venueId: string }) {
  const [page, setPage] = useState(0);
  const [players, setPlayers] = useState<AdminPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      try {
        const rows = await fetchPlayers(venueId, PAGE_SIZE, page * PAGE_SIZE, signal);
        setPlayers(rows);
        setError(null);
      } catch (caught) {
        setError(toAdminError(caught).message);
      } finally {
        setLoading(false);
      }
    },
    [venueId, page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  /**
   * Client-side, as specified — so it only filters the page in hand, not the
   * venue. With a full page of results the match may simply be on another page,
   * which the empty state says rather than implying the player does not exist.
   */
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term === '') {
      return players;
    }
    return players.filter((player) => player.nickname.toLowerCase().includes(term));
  }, [players, search]);

  // The API returns a page, not a total. A full page means there may be
  // another; a short one means this is the end.
  const maybeMore = players.length === PAGE_SIZE;

  return (
    <section className="page">
      <h1 className="page__title">Players</h1>
      <p className="page__lede">Most recently seen first. Expired sessions are included.</p>

      <div className="card">
        <label className="label" htmlFor="player-search">
          Search this page
        </label>
        <input
          id="player-search"
          className="input"
          type="search"
          placeholder="Nickname"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="state" role="status">Loading players…</p>
        ) : visible.length === 0 ? (
          <p className="state">
            {players.length === 0
              ? 'No players on this page.'
              : `No match on page ${page + 1}. Try another page.`}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Nickname</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last seen</th>
                  <th scope="col" className="numeric">
                    Picks
                  </th>
                  <th scope="col" className="numeric">
                    Points
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((player) => (
                  <tr key={player.playerId}>
                    <td>{player.nickname}</td>
                    <td>{formatWhen(player.createdAt)}</td>
                    <td>{formatWhen(player.lastSeenAt)}</td>
                    <td className="numeric">{player.totalPicks}</td>
                    <td className="numeric">{player.totalPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row row--between">
          <button
            className="button button--ghost"
            type="button"
            disabled={page === 0 || loading}
            onClick={() => {
              setPage((value) => Math.max(0, value - 1));
              setSearch('');
            }}
          >
            Previous
          </button>
          <span className="hint">Page {page + 1}</span>
          <button
            className="button button--ghost"
            type="button"
            disabled={!maybeMore || loading}
            onClick={() => {
              setPage((value) => value + 1);
              setSearch('');
            }}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
