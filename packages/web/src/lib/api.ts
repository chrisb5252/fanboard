import type {
  CreatedPlayer,
  Game,
  LeaderboardEntry,
  LeaderboardPeriod,
  MyPick,
  PredictedWinner,
  SubmittedPick,
} from './types';

/**
 * Client for the FanBoard backend.
 *
 * Every path here was checked against the running API. Three endpoints in the
 * brief do not exist and are handled differently:
 *
 *  - `GET /api/venues/:id` — no such route. A venue is validated by asking for
 *    its games; a bad id answers 400 and a real one answers 200.
 *  - `GET /api/venues/:id/my-picks` — the route is `/picks`. A GET returns the
 *    caller's own picks, a POST places one.
 *  - `GET /api/venues/:id/profile` — no such route, and no profile table. The
 *    profile screen derives its numbers from picks and the leaderboard, which
 *    is where they come from anyway. See lib/stats.ts.
 *
 * All requests are relative. next.config.js rewrites /api to the backend, so
 * the browser stays same-origin and the httpOnly SameSite=Lax session cookie
 * is actually sent — it would not be on a cross-site call.
 */

/** Server-rendered passes need an absolute URL; the browser must not. */
const BASE = typeof window === 'undefined' ? (process.env['BACKEND_ORIGIN'] ?? 'http://localhost:3000') : '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the session is missing or expired and the player must rejoin. */
  get requiresRejoin(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      // Sends the session cookie. Only effective same-origin, which the rewrite
      // guarantees.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
  } catch {
    // A thrown fetch is a transport failure, not an HTTP status. Reported as 0
    // so callers can tell "we never reached the server" from "the server said
    // no" — the two need different words in front of a player.
    throw new ApiError(0, 'Cannot reach FanBoard. Check your connection.');
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string; code?: string } }
      | null;
    throw new ApiError(
      response.status,
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.code,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  /**
   * Joins a venue and mints a session.
   *
   * The brief has no join step, but every authenticated call needs one: without
   * a session, listing or placing picks answers 401. The cookie is set by this
   * response and the browser keeps it.
   */
  joinVenue(venueId: string, nickname: string): Promise<CreatedPlayer> {
    return request<CreatedPlayer>(`/api/venues/${venueId}/players`, {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    });
  },

  getGames(venueId: string, signal?: AbortSignal): Promise<Game[]> {
    return request<Game[]>(`/api/venues/${venueId}/games`, { signal });
  },

  /** Public and unauthenticated, same as the board on the TV. */
  getLeaderboard(
    venueId: string,
    period: LeaderboardPeriod = 'this_week',
    signal?: AbortSignal,
  ): Promise<LeaderboardEntry[]> {
    return request<LeaderboardEntry[]>(
      `/api/venues/${venueId}/leaderboard?period=${period}`,
      { signal },
    );
  },

  /** The caller's own picks. 401 when the session has gone. */
  getMyPicks(venueId: string, signal?: AbortSignal): Promise<MyPick[]> {
    return request<MyPick[]>(`/api/venues/${venueId}/picks`, { signal });
  },

  /**
   * Places or changes a pick.
   *
   * Body is exactly `{ gameId, predictedWinner }`. There is no stake, no odds
   * and no payout anywhere in this system: a correct pick scores 10, a wrong
   * one scores 0, and the server decides which at grading time.
   *
   * 423 means the game locked. Whether a game is open is decided by PostgreSQL
   * in the same statement that writes the pick, so a client-side countdown is a
   * courtesy — the server is the authority.
   */
  placePick(
    venueId: string,
    input: { gameId: string; predictedWinner: PredictedWinner },
  ): Promise<SubmittedPick> {
    return request<SubmittedPick>(`/api/venues/${venueId}/picks`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
