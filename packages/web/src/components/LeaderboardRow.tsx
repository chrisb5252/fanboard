import type { LeaderboardEntry } from '@/lib/types';

const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/**
 * One standing.
 *
 * The medal is decorative; the rank number stays available to screen readers,
 * and "you" is spelled out rather than signalled only by the highlight.
 */
export function LeaderboardRow({ entry, isMe }: { entry: LeaderboardEntry; isMe: boolean }) {
  const medal = MEDALS[entry.rank];

  return (
    <li
      aria-current={isMe ? 'true' : undefined}
      className={`flex items-center gap-3 rounded-xl border p-4 ${
        isMe ? 'border-accent-green bg-accent-green/10' : 'border-dark-700 bg-dark-800'
      }`}
    >
      <span className="w-8 shrink-0 text-center text-lg font-bold">
        {medal === undefined ? (
          `#${entry.rank}`
        ) : (
          <>
            <span aria-hidden="true">{medal}</span>
            <span className="sr-only">{entry.rank}</span>
          </>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate font-bold">
          {entry.nickname}
          {isMe && <span className="ml-2 text-sm font-medium text-accent-green">you</span>}
        </div>
        <div className="text-sm text-dark-400">
          {entry.wins}W · {entry.losses}L
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-lg font-bold">{entry.points}</div>
        <div className="text-sm text-dark-400">points</div>
      </div>
    </li>
  );
}
