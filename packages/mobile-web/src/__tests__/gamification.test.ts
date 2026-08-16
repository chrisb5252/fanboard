import { describe, expect, it } from 'vitest';
import {
  currentStreak,
  encouragement,
  isHotHand,
  newlyCorrect,
  rankProgress,
  tierFor,
  tierProgress,
} from '../lib/gamification';
import type { LeaderboardRow, MyPick } from '../lib/api';

/**
 * These numbers are shown to a player as fact, next to their own list of picks.
 * A streak that disagrees with that list is worse than no streak, so the edge
 * cases here are the ones where "obvious" and "correct" come apart: voided
 * picks, ungraded picks, and results arriving out of kick-off order.
 */

function pick(overrides: Partial<MyPick> = {}): MyPick {
  return {
    pickId: `p-${Math.random().toString(36).slice(2)}`,
    gameId: `g-${Math.random().toString(36).slice(2)}`,
    homeTeam: 'Bears',
    awayTeam: 'Packers',
    league: 'NFL',
    scheduledAt: '2026-01-01T18:00:00.000Z',
    gameStatus: 'final',
    predictedWinner: 'home',
    correct: true,
    points: 10,
    submittedAt: '2026-01-01T17:00:00.000Z',
    gradedAt: '2026-01-01T20:00:00.000Z',
    ...overrides,
  };
}

describe('currentStreak', () => {
  it('counts consecutive wins back from the most recent result', () => {
    const streak = currentStreak([
      pick({ correct: true, gradedAt: '2026-01-01T20:00:00.000Z' }),
      pick({ correct: true, gradedAt: '2026-01-01T21:00:00.000Z' }),
      pick({ correct: true, gradedAt: '2026-01-01T22:00:00.000Z' }),
    ]);
    expect(streak).toBe(3);
  });

  it('stops at the first loss', () => {
    const streak = currentStreak([
      pick({ correct: true, gradedAt: '2026-01-01T22:00:00.000Z' }),
      pick({ correct: false, gradedAt: '2026-01-01T21:00:00.000Z' }),
      pick({ correct: true, gradedAt: '2026-01-01T20:00:00.000Z' }),
    ]);
    expect(streak).toBe(1);
  });

  it('orders by when results landed, not by kick-off', () => {
    // An early game that settles late must not be counted as the newest result,
    // or a player who just won sees their streak reset by an older game.
    const streak = currentStreak([
      pick({ correct: false, scheduledAt: '2026-01-01T12:00:00.000Z', gradedAt: '2026-01-01T23:00:00.000Z' }),
      pick({ correct: true, scheduledAt: '2026-01-01T20:00:00.000Z', gradedAt: '2026-01-01T21:00:00.000Z' }),
    ]);
    expect(streak).toBe(0);
  });

  it('ignores picks that are not settled yet', () => {
    const streak = currentStreak([
      pick({ correct: null, points: null, gradedAt: null }),
      pick({ correct: true, gradedAt: '2026-01-01T20:00:00.000Z' }),
    ]);
    expect(streak).toBe(1);
  });

  it('ignores voided picks rather than treating them as losses', () => {
    // A cancelled game is nobody's fault; breaking a streak on it would be
    // punishing a player for the weather.
    const streak = currentStreak([
      pick({ correct: true, gradedAt: '2026-01-01T20:00:00.000Z' }),
      pick({ correct: null, points: null, gradedAt: '2026-01-01T21:00:00.000Z' }),
      pick({ correct: true, gradedAt: '2026-01-01T22:00:00.000Z' }),
    ]);
    expect(streak).toBe(2);
  });

  it('is zero with no picks at all', () => {
    expect(currentStreak([])).toBe(0);
  });
});

describe('isHotHand', () => {
  it('starts at three', () => {
    expect(isHotHand(2)).toBe(false);
    expect(isHotHand(3)).toBe(true);
  });
});

describe('tiers', () => {
  it('places a player by points', () => {
    expect(tierFor(0).name).toBe('Rookie');
    expect(tierFor(30).name).toBe('Regular');
    expect(tierFor(80).name).toBe('Sharp');
    expect(tierFor(150).name).toBe('Legend');
    expect(tierFor(9999).name).toBe('Legend');
  });

  it('survives nonsense input rather than rendering NaN at someone', () => {
    expect(tierFor(-50).name).toBe('Rookie');
    expect(tierFor(Number.NaN).name).toBe('Rookie');
  });

  it('reports progress through the current tier, and full at the top', () => {
    expect(tierProgress(0)).toBe(0);
    expect(tierProgress(15)).toBeCloseTo(0.5);
    expect(tierProgress(200)).toBe(1);
  });
});

describe('rankProgress', () => {
  const board: LeaderboardRow[] = [
    { rank: 1, nickname: 'Ada', wins: 5, losses: 0, points: 50 },
    { rank: 2, nickname: 'Bo', wins: 3, losses: 1, points: 30 },
    { rank: 3, nickname: 'Cy', wins: 2, losses: 2, points: 20 },
  ];

  it('reports the gap to the player directly above', () => {
    const progress = rankProgress(board, 'Bo');
    expect(progress?.pointsBehind).toBe(20);
    expect(progress?.chasing?.nickname).toBe('Ada');
    expect(progress?.fraction).toBeCloseTo(0.6);
  });

  it('has nobody to chase at the top', () => {
    const progress = rankProgress(board, 'Ada');
    expect(progress?.chasing).toBeNull();
    expect(progress?.fraction).toBe(1);
  });

  it('returns null for a player not on the board', () => {
    // A newcomer shown a bar at zero reads it as losing rather than as not
    // having started.
    expect(rankProgress(board, 'Nobody')).toBeNull();
  });

  it('does not divide by zero when everyone is on nothing', () => {
    const fresh: LeaderboardRow[] = [
      { rank: 1, nickname: 'Ada', wins: 0, losses: 1, points: 0 },
      { rank: 2, nickname: 'Bo', wins: 0, losses: 1, points: 0 },
    ];
    const progress = rankProgress(fresh, 'Bo');
    expect(progress?.fraction).toBe(1);
    expect(progress?.pointsBehind).toBe(0);
  });
});

describe('encouragement', () => {
  it('never scolds a losing run', () => {
    const copy = encouragement(0, 5);
    expect(copy).toMatch(/fresh start/i);
    expect(copy).not.toMatch(/lost|wrong|bad|fail/i);
  });

  it('welcomes a player who has not started', () => {
    expect(encouragement(0, 0)).toMatch(/first pick/i);
  });

  it('escalates with the streak', () => {
    expect(encouragement(1, 1)).toMatch(/nice call/i);
    expect(encouragement(3, 3)).toMatch(/hot hand/i);
    expect(encouragement(5, 5)).toMatch(/unstoppable/i);
  });
});

describe('newlyCorrect', () => {
  it('fires only on the transition to correct', () => {
    const before = [pick({ pickId: 'a', correct: null, gradedAt: null })];
    const after = [pick({ pickId: 'a', correct: true })];
    expect(newlyCorrect(before, after)).toEqual(['a']);
  });

  it('does not fire again on a later poll', () => {
    const settled = [pick({ pickId: 'a', correct: true })];
    expect(newlyCorrect(settled, settled)).toEqual([]);
  });

  it('does not celebrate history on first load', () => {
    // An empty previous snapshot is a page load, not a win. Without this, a
    // returning player is confettied for picks they made hours ago.
    const after = [pick({ pickId: 'a', correct: true })];
    expect(newlyCorrect([], after)).toEqual([]);
  });

  it('ignores a pick that settles wrong', () => {
    const before = [pick({ pickId: 'a', correct: null, gradedAt: null })];
    const after = [pick({ pickId: 'a', correct: false, points: 0 })];
    expect(newlyCorrect(before, after)).toEqual([]);
  });
});
