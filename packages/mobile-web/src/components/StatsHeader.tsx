import type { LeaderboardRow, MyPick } from '../lib/api';
import {
  currentStreak,
  encouragement,
  isHotHand,
  rankProgress,
  tierFor,
  tierProgress,
} from '../lib/gamification';

export interface StatsHeaderProps {
  nickname: string;
  picks: readonly MyPick[];
  /** This week's board, used for the chase. Empty until it loads. */
  board: readonly LeaderboardRow[];
}

/**
 * The "how am I doing?" strip above the games list.
 *
 * Three things, in the order a player asks them: am I on a run, how close am I
 * to the person above me, and what should I do next. Everything shown is
 * derived from their own picks and the real board — see lib/gamification.ts for
 * why there is no invented weekly target here.
 */
export function StatsHeader({ nickname, picks, board }: StatsHeaderProps) {
  const settled = picks.filter((pick) => pick.gradedAt !== null && pick.correct !== null);
  const streak = currentStreak(picks);
  const hot = isHotHand(streak);
  const progress = rankProgress(board, nickname);
  const points = progress?.points ?? 0;
  const tier = tierFor(points);

  return (
    <section className="stats" aria-label="Your progress">
      {/* "Pick Games", not "Available Markets". The h1 for this screen lives
          here rather than in the shell, because this block is what a player
          lands on. */}
      <h1 className="stats__heading">Pick Games</h1>

      <div className="stats__row">
        <span className={`tier${hot ? ' tier--hot' : ''}`}>
          <span aria-hidden="true">{tier.emoji}</span> {tier.name}
        </span>

        {streak > 0 && (
          <span className={`streak${hot ? ' streak--hot' : ''}`}>
            <span aria-hidden="true">🔥</span>
            {/* The visible text is short; the label carries the full sentence
                so a screen reader is not left decoding "3" next to a flame. */}
            <span aria-hidden="true">{streak}</span>
            <span className="visually-hidden">{`${streak} correct pick${streak === 1 ? '' : 's'} in a row`}</span>
          </span>
        )}
      </div>

      <p className="stats__cheer">{encouragement(streak, settled.length)}</p>

      {progress !== null && progress.chasing !== null && (
        <div className="chase">
          <div className="chase__line">
            <span>
              {progress.points} pts · #{progress.rank}
            </span>
            <span className="chase__gap">
              {progress.pointsBehind === 0
                ? `Level with ${progress.chasing.nickname}`
                : `${progress.pointsBehind} to catch ${progress.chasing.nickname}`}
            </span>
          </div>
          <div
            className="bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.chasing.points}
            aria-valuenow={progress.points}
            aria-label={`${progress.points} of ${progress.chasing.points} points to catch ${progress.chasing.nickname}`}
          >
            <span className="bar__fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        </div>
      )}

      {progress !== null && progress.chasing === null && (
        <div className="chase">
          <div className="chase__line">
            <span>
              {progress.points} pts · #1
            </span>
            <span className="chase__gap chase__gap--lead">Top of the board 🏆</span>
          </div>
          <div
            className="bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={tier.next ?? progress.points}
            aria-valuenow={progress.points}
            aria-label={
              tier.next === null
                ? 'Top tier reached'
                : `${progress.points} of ${tier.next} points to the next tier`
            }
          >
            <span className="bar__fill" style={{ width: `${Math.round(tierProgress(points) * 100)}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}
