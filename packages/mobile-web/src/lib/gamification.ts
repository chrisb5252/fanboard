import type { LeaderboardRow, MyPick } from './api';

/**
 * Derived progress signals: streaks, tiers, and the gap to the player above.
 *
 * Every value here is computed from data the API already returns. Nothing is
 * stored server-side and nothing is invented, which matters more than it
 * sounds: a streak that disagrees with the player's own list of picks is worse
 * than no streak at all, because it teaches them the numbers are decorative.
 *
 * The one thing deliberately NOT built is a weekly points *target* ("240 / 300").
 * There is no goal concept anywhere in the system, so the denominator could only
 * be a number picked here for the look of the progress bar. The gap to the
 * player above is used instead — it is real, it moves for reasons the player
 * can see, and it is the thing they actually care about.
 */

/** A pick counts toward a streak only once settled and not voided. */
function isSettled(pick: MyPick): boolean {
  return pick.gradedAt !== null && pick.correct !== null;
}

/**
 * Consecutive correct picks, counting back from the most recently settled.
 *
 * Ordered by when each pick was *graded* rather than when its game kicked off:
 * that is the order the player watched results arrive in, so it matches what
 * they think their streak is.
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

/** Three in a row is where a run starts feeling like one. */
export const HOT_HAND_THRESHOLD = 3;

export function isHotHand(streak: number): boolean {
  return streak >= HOT_HAND_THRESHOLD;
}

export interface Tier {
  readonly name: string;
  readonly emoji: string;
  /** Points needed to reach this tier. */
  readonly from: number;
  /** Points needed for the next one, or null at the top. */
  readonly next: number | null;
}

/**
 * Tiers are spaced in whole correct picks, since a pick is worth 10 points and
 * a player counts in picks, not points: 0, 3, 8, 15 correct.
 */
const TIERS: readonly Tier[] = [
  { name: 'Rookie', emoji: '🌱', from: 0, next: 30 },
  { name: 'Regular', emoji: '⭐', from: 30, next: 80 },
  { name: 'Sharp', emoji: '🎯', from: 80, next: 150 },
  { name: 'Legend', emoji: '👑', from: 150, next: null },
];

export function tierFor(points: number): Tier {
  const safe = Number.isFinite(points) ? Math.max(0, points) : 0;
  let current = TIERS[0] as Tier;
  for (const tier of TIERS) {
    if (safe >= tier.from) {
      current = tier;
    }
  }
  return current;
}

/** 0..1 through the current tier. Always 1 at the top tier. */
export function tierProgress(points: number): number {
  const tier = tierFor(points);
  if (tier.next === null) {
    return 1;
  }
  const span = tier.next - tier.from;
  return Math.min(1, Math.max(0, (points - tier.from) / span));
}

export interface RankProgress {
  readonly rank: number;
  readonly points: number;
  /** The player directly above, or null when already first. */
  readonly chasing: { nickname: string; points: number } | null;
  /** Points needed to draw level. 0 when first, or when already tied. */
  readonly pointsBehind: number;
  /** 0..1 for a progress bar against the player above. 1 when first. */
  readonly fraction: number;
}

/**
 * Where the player stands relative to whoever is directly ahead.
 *
 * Returns null when the player is not on the board at all — a newcomer with no
 * settled picks — because showing them a bar at zero implies they are losing
 * rather than that they have not started.
 */
export function rankProgress(
  rows: readonly LeaderboardRow[],
  nickname: string,
): RankProgress | null {
  const index = rows.findIndex((row) => row.nickname === nickname);
  if (index === -1) {
    return null;
  }

  const me = rows[index] as LeaderboardRow;
  if (index === 0) {
    return { rank: me.rank, points: me.points, chasing: null, pointsBehind: 0, fraction: 1 };
  }

  const above = rows[index - 1] as LeaderboardRow;
  const pointsBehind = Math.max(0, above.points - me.points);
  // Guard the divide: at the very start of a night everyone sits on zero.
  const fraction = above.points <= 0 ? 1 : Math.min(1, me.points / above.points);

  return {
    rank: me.rank,
    points: me.points,
    chasing: { nickname: above.nickname, points: above.points },
    pointsBehind,
    fraction,
  };
}

/**
 * Encouraging line for the header. Never scolds.
 *
 * The tone rule from the brief, made concrete: there is no message for a losing
 * run. A player who just got three wrong does not need it counted back to them,
 * so the copy falls through to something forward-looking.
 */
export function encouragement(streak: number, settledCount: number): string {
  if (settledCount === 0) {
    return 'Make your first pick — good luck!';
  }
  if (streak >= 5) {
    return "Unstoppable. Don't stop now!";
  }
  if (isHotHand(streak)) {
    return 'Hot hand! Keep it rolling.';
  }
  if (streak === 2) {
    return 'Two in a row — one more for a streak!';
  }
  if (streak === 1) {
    return 'Nice call. Go again?';
  }
  return 'Fresh start. You got this!';
}

/**
 * Picks that just flipped to correct, for a one-off celebration.
 *
 * Compares two snapshots rather than reacting to any correct pick, so the
 * confetti fires on the transition and not on every poll. Returns the pick ids
 * so the caller can avoid celebrating the same win twice.
 */
export function newlyCorrect(
  previous: readonly MyPick[],
  next: readonly MyPick[],
): string[] {
  const before = new Map(previous.map((pick) => [pick.pickId, pick.correct]));
  return next
    .filter((pick) => pick.correct === true && before.get(pick.pickId) !== true)
    .filter((pick) => before.has(pick.pickId))
    .map((pick) => pick.pickId);
}
