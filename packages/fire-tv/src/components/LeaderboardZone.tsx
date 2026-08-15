import type { DisplayLeaderboardEntry } from '../lib/api';

/** Ten rows is what stays legible at ten feet on a 1080p panel. */
export const TOP_N = 10;

export function LeaderboardZone({ entries }: { entries: DisplayLeaderboardEntry[] }) {
  const top = entries.slice(0, TOP_N);

  if (top.length === 0) {
    return (
      <div className="zone zone--empty">
        <h1 className="zone__title">Leaderboard</h1>
        <p className="zone__empty">Scan to play — standings appear once games finish</p>
      </div>
    );
  }

  return (
    <div className="zone">
      <h1 className="zone__title">Leaderboard · Today</h1>
      <table className="board">
        <thead>
          <tr>
            <th scope="col" className="board__rank">
              #
            </th>
            <th scope="col">Player</th>
            <th scope="col" className="board__num">
              W
            </th>
            <th scope="col" className="board__num">
              L
            </th>
            <th scope="col" className="board__num">
              Pts
            </th>
          </tr>
        </thead>
        <tbody>
          {top.map((entry) => (
            <tr key={`${entry.rank}-${entry.nickname}`} className={entry.rank <= 3 ? 'board__row board__row--medal' : 'board__row'}>
              <td className="board__rank">{entry.rank}</td>
              <td className="board__name">{entry.nickname}</td>
              <td className="board__num">{entry.wins}</td>
              <td className="board__num">{entry.losses}</td>
              <td className="board__num board__points">{entry.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
