import type { LeaderboardEntry, MyPick } from './types';

/**
 * Everything the profile screen shows, derived from data the API returns.
 *
 * The brief called for `GET /api/venues/:id/profile` returning nickname, total
 * points, correct count, total count and streak. No such endpoint exists and no
 * table holds those numbers — they are all aggregates over picks, which the
 * player can already fetch. Deriving them here is honest and needs no backend
 * change; inventing an endpoint would have produced a screen that 404s.
 *
 * Streak is the same story: it is not stored anywhere, and it is computed here
 * from the player's own settled picks.
 */

/** A pick counts only once settled, and voided picks are not settlements. */
function isSettled(pick: MyPick): boolean {
  return pick.gradedAt !== null && pick.correct !== null;
}

/**
 * Consecutive correct picks, counting back from the most recent result.
 *
 * Ordered by when each pick was graded rather than by kick-off: that is the
 * order the player watched results land, so it matches what they believe their
 * streak to be. A voided pick — cancelled game — neither extends nor breaks a
 * run, because breaking one on an abandoned match punishes a player for the
 * weather.
 */
export function currentStreak(picks: readonly MyPick[]): number {
  const settled = picks
    .filter(isSettled)
    .slice()
    .sort((a, b) => (b.gradedAt ?? '').localeCompare(a.gradedAt ?? ''));

  let streak = 0;
  for (const pick of settled) {
    if (pick.correct !== true) {
      break;
    }
    streak += 1;
  }
  return streak;
}

export const HOT_HAND_THRESHOLD = 3;

export function isHotHand(streak: number): boolean {
  return streak >= HOT_HAND_THRESHOLD;
}

export interface PlayerStats {
  readonly totalPoints: number;
  readonly picksCorrect: number;
  readonly picksTotal: number;
  /** Settled picks only, so a pending pick does not drag the rate down. */
  readonly winRate: number;
  readonly streak: number;
  readonly pending: number;
}

export function playerStats(picks: readonly MyPick[]): PlayerStats {
  const settled = picks.filter(isSettled);
  const correct = settled.filter((pick) => pick.correct === true).length;

  return {
    totalPoints: settled.reduce((sum, pick) => sum + (pick.points ?? 0), 0),
    picksCorrect: correct,
    picksTotal: settled.length,
    // Guarded: a player with nothing settled has no rate, not a rate of zero.
    winRate: settled.length === 0 ? 0 : Math.round((correct / settled.length) * 100),
    streak: currentStreak(picks),
    pending: picks.length - settled.length,
  };
}

/** Where the player sits, if they are on the board at all. */
export function myRank(
  board: readonly LeaderboardEntry[],
  nickname: string,
): LeaderboardEntry | null {
  return board.find((row) => row.nickname === nickname) ?? null;
}

/**
 * Points needed to catch whoever is directly ahead.
 *
 * Null when first, or when the player has not made the board — showing someone
 * a gap of zero when they simply have not started reads as though they are
 * losing.
 */
export function pointsToNextRank(
  board: readonly LeaderboardEntry[],
  nickname: string,
): { behind: number; target: string } | null {
  const index = board.findIndex((row) => row.nickname === nickname);
  if (index <= 0) {
    return null;
  }
  const me = board[index] as LeaderboardEntry;
  const above = board[index - 1] as LeaderboardEntry;
  return { behind: Math.max(0, above.points - me.points), target: above.nickname };
}

/** Encouraging, and never scolding — there is no message for a losing run. */
export function encouragement(streak: number, settledCount: number): string {
  if (settledCount === 0) return 'Make your first pick — good luck!';
  if (streak >= 5) return "Unstoppable. Don't stop now!";
  if (isHotHand(streak)) return 'Hot hand! Keep it rolling.';
  if (streak === 2) return 'Two in a row — one more for a streak!';
  if (streak === 1) return 'Nice call. Go again?';
  return 'Fresh start. You got this!';
}

/** Kick-off time, in the reader's own locale. */
export function formatKickoff(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Human countdown to lock, or '' once it has passed. */
export function timeUntil(iso: string, now: number = Date.now()): string {
  const remaining = new Date(iso).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return '';

  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
