import { useEffect, useState } from 'react';

export type Zone = 'scoreboard' | 'leaderboard' | 'qr';

/**
 * The rotation the brief specifies: 15s scoreboard, 15s leaderboard, 5s QR.
 *
 * That is a 35-second cycle. The brief also calls it "every 20 sec", which the
 * three durations cannot add up to; the per-zone numbers are the concrete ones
 * so those are what is implemented.
 */
export const ROTATION: { zone: Zone; durationMs: number }[] = [
  { zone: 'scoreboard', durationMs: 15_000 },
  { zone: 'leaderboard', durationMs: 15_000 },
  { zone: 'qr', durationMs: 5_000 },
];

export const CYCLE_MS = ROTATION.reduce((total, step) => total + step.durationMs, 0);

/**
 * Advances through the rotation.
 *
 * One timer that reschedules itself, rather than an interval per zone. On an
 * ARM stick with a browser that throttles background work, fewer timers means
 * fewer wakeups and less drift.
 *
 * A zone with nothing to show is skipped — a blank "Leaderboard" heading above
 * an empty table for 15 seconds of every 35 is worse than not showing it.
 */
export function useRotation(available: Record<Zone, boolean>): Zone {
  const [index, setIndex] = useState(0);

  const showable = ROTATION.filter((step) => available[step.zone]);
  const effective = showable.length === 0 ? ROTATION : showable;
  const safeIndex = index % effective.length;
  const current = effective[safeIndex] ?? ROTATION[0]!;

  useEffect(() => {
    const timer = setTimeout(() => {
      setIndex((value) => value + 1);
    }, current.durationMs);
    return () => {
      clearTimeout(timer);
    };
  }, [current.durationMs, safeIndex, effective.length]);

  return current.zone;
}
