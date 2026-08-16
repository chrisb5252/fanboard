/**
 * Types transcribed from what the backend actually returns.
 *
 * Every shape here was captured from a live response rather than assumed. Two
 * things differ from the brief and matter:
 *
 *  - The API speaks camelCase, not snake_case. `homeTeam`, not `home_team`.
 *  - Game status is the five-value set the schema's CHECK constraint allows.
 *    There is no `upcoming` or `in_progress`; a game that has not started is
 *    `scheduled` and one in play is `live`.
 */

export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';
export type PredictedWinner = 'home' | 'away';
export type LeaderboardPeriod = 'today' | 'this_week' | 'all_time';

export interface Game {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: GameStatus;
  /** Kick-off. Picks close at this moment; there is no separate `locks_at`. */
  scheduledAt: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  /** Present in the payload, always null today — no column holds them yet. */
  quarter: string | null;
  period: string | null;
  inning: string | null;
}

/**
 * One of the player's own picks.
 *
 * Three states, distinguishable only by combining fields:
 *   ungraded  gradedAt null,     correct null
 *   graded    gradedAt set,      correct true/false, points 10 or 0
 *   voided    gradedAt set,      correct null        (cancelled game)
 */
export interface MyPick {
  pickId: string;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  scheduledAt: string;
  gameStatus: GameStatus;
  predictedWinner: PredictedWinner;
  correct: boolean | null;
  points: number | null;
  submittedAt: string;
  gradedAt: string | null;
}

/**
 * A leaderboard row.
 *
 * Note what is NOT here: no player id, and no streak.
 *
 * The id is withheld deliberately — this endpoint is public and unauthenticated,
 * and player_session_id is a tenant-internal identifier. Exposing it would let
 * anyone reading a TV correlate players across boards.
 *
 * Streak is not stored anywhere server-side. It is derived from the player's own
 * picks in lib/stats.ts.
 */
export interface LeaderboardEntry {
  rank: number;
  nickname: string;
  wins: number;
  losses: number;
  points: number;
}

export interface CreatedPlayer {
  playerId: string;
  nickname: string;
}

export interface SubmittedPick {
  pickId: string;
  gameId: string;
  predictedWinner: PredictedWinner;
  locked: false;
}

/** What a correct pick is worth. Mirrors the backend's grading worker. */
export const POINTS_FOR_CORRECT_PICK = 10;
