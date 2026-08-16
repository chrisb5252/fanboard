import { useCallback, useState } from 'react';
import { fetchLeaderboard, type LeaderboardPeriod, type LeaderboardRow } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { rankProgress, tierFor } from '../lib/gamification';

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
  /**
   * Bumped when a realtime event says the standings moved.
   *
   * Without it this view only ever refreshed on its own 10 second timer — so
   * the leaderboard, which is the thing the realtime layer exists to make
   * live, was the one screen that ignored `leaderboard_updated`. A game would
   * settle, every phone would be told immediately, and the board would sit
   * unchanged for up to ten more seconds.
   *
   * The event is a hint to refetch, never data to apply: it names the venue,
   * not the period this view happens to be showing.
   */
  refreshNonce?: number;
}

export function Leaderboard({ venueId, nickname, refreshNonce = 0 }: LeaderboardProps) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('today');

  const fetcher = useCallback(
    (signal: AbortSignal) => fetchLeaderboard(venueId, period, signal),
    // refreshNonce is a dependency rather than a value the fetch reads: changing
    // the identity is what makes usePolling refetch now instead of on its timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [venueId, period, refreshNonce],
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

          {/* The chase line, repeated from the games header so a player does not
            have to switch tabs to see what is within reach. */}
        {(() => {
          const mine = rankProgress(rows, nickname);
          if (mine === null || mine.chasing === null) {
            return null;
          }
          return (
            <p className="chase__inline">
              <strong>{mine.pointsBehind}</strong>{' '}
              {mine.pointsBehind === 1 ? 'point' : 'points'} to catch {mine.chasing.nickname}. You
              got this!
            </p>
          );
        })()}

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
                    <td>
                      {/* Medal for the podium; the rank number stays available
                          to screen readers, so the emoji is decorative only. */}
                      {row.rank <= 3 ? (
                        <>
                          <span aria-hidden="true">
                            {row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : '🥉'}
                          </span>
                          <span className="visually-hidden">{row.rank}</span>
                        </>
                      ) : (
                        row.rank
                      )}
                    </td>
                    <td>
                      {row.nickname}
                      {isMe && <span className="you"> you</span>}
                      <span className="tier-dot">
                        <span aria-hidden="true">{tierFor(row.points).emoji}</span>
                        <span className="visually-hidden">{tierFor(row.points).name}</span>
                      </span>
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
