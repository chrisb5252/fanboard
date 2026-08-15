import { useCallback, useState } from 'react';
import { fetchLeaderboard, type LeaderboardPeriod, type LeaderboardRow } from '../lib/api';
import { usePolling } from '../lib/usePolling';

const REFRESH_MS = 10_000;
const THIN_BOARD_THRESHOLD = 5;

const TABS: { id: LeaderboardPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This week' },
  { id: 'all_time', label: 'All time' },
];

export interface LeaderboardProps {
  venueId: string;
  /** Used to highlight the player's own row. */
  nickname: string;
}

export function Leaderboard({ venueId, nickname }: LeaderboardProps) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('today');

  const fetcher = useCallback(
    (signal: AbortSignal) => fetchLeaderboard(venueId, period, signal),
    [venueId, period],
  );

  const { data, error, loading } = usePolling<LeaderboardRow[]>(fetcher, REFRESH_MS);
  const rows = data ?? [];

  return (
    <div className="page">
      <div className="tabs" role="tablist" aria-label="Leaderboard period">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={period === tab.id}
            className={`tab${period === tab.id ? ' tab--active' : ''}`}
            onClick={() => {
              setPeriod(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <p className="state" role="status">Loading standings…</p>}

      {!loading && error !== null && rows.length === 0 && (
        <p className="state state--error" role="alert">
          {error.message}
        </p>
      )}

      {!loading && rows.length === 0 && error === null && (
        <p className="state">No graded picks yet. Standings appear once games finish.</p>
      )}

      {rows.length > 0 && (
        <>
          {rows.length < THIN_BOARD_THRESHOLD && (
            <p className="banner" role="status">
              Only {rows.length} {rows.length === 1 ? 'player has' : 'players have'} scored so far —
              get your picks in.
            </p>
          )}

          <table className="table">
            <caption className="visually-hidden">Leaderboard, {period}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">W</th>
                <th scope="col">L</th>
                <th scope="col">Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isMe = row.nickname === nickname;
                return (
                  <tr
                    key={`${row.rank}-${row.nickname}`}
                    className={isMe ? 'row row--me' : 'row'}
                    aria-current={isMe ? 'true' : undefined}
                  >
                    <td>{row.rank}</td>
                    <td>
                      {row.nickname}
                      {isMe && <span className="you"> you</span>}
                    </td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td className="numeric">{row.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
