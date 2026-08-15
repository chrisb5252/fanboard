import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

/**
 * HTTP client for the FanBoard API.
 *
 * Two things the brief asked for that are not possible as stated, and what is
 * done instead:
 *
 *  - "Auto-attach session_token from cookies (httpOnly)". An HttpOnly cookie is
 *    invisible to JavaScript by definition — that is the entire point of the
 *    flag. It cannot be read, and it does not need to be: the browser attaches
 *    it automatically. `withCredentials: true` is what makes that happen on
 *    XHR, and it is the whole implementation.
 *
 *  - "Session persists across page refresh (localStorage backup)". Copying the
 *    token into localStorage would hand it to any XSS on the page, undoing the
 *    HttpOnly protection. The cookie already survives a refresh on its own. We
 *    persist only non-secret context (venue, player id, nickname) so the app can
 *    resume the right screen.
 */

/** Base URL. Empty by default so requests are same-origin via the dev proxy. */
export const BASE_URL = import.meta.env['VITE_API_URL'] ?? '';

export const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 10_000;

export const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  // Sends the HttpOnly session cookie. Without it the browser omits credentials
  // on XHR and every authenticated call returns 401.
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

interface RetryState {
  retryCount?: number;
}

type RetryableConfig = AxiosRequestConfig & RetryState;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Only transport failures and 5xx are retried.
 *
 * A 4xx is a decision the server already made — retrying a 423 will not unlock
 * the game, and retrying a 429 actively deepens the rate limit. Retrying a
 * non-idempotent POST that failed with 4xx risks duplicating work for nothing.
 */
export function isRetryable(error: AxiosError): boolean {
  if (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK') {
    return true;
  }
  const status = error.response?.status;
  if (status === undefined) {
    return true;
  }
  return status >= 500 && status < 600;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetryableConfig | undefined;

    if (config === undefined || !isRetryable(error)) {
      return Promise.reject(error);
    }

    const attempt = config.retryCount ?? 0;
    if (attempt >= MAX_RETRIES) {
      return Promise.reject(error);
    }

    config.retryCount = attempt + 1;
    // Exponential backoff: 300ms, 600ms, 1200ms.
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    return apiClient.request(config);
  },
);

// ---------------------------------------------------------------------------
// Response shapes, mirroring the backend
// ---------------------------------------------------------------------------

/** Lower-case, matching the games.status CHECK constraint. */
export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';

export interface Game {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: GameStatus;
  scheduledAt: string;
  /** Always null today: no column holds in-game progress. */
  quarter: string | null;
  period: string | null;
  inning: string | null;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
}

export interface LeaderboardRow {
  rank: number;
  nickname: string;
  wins: number;
  losses: number;
  points: number;
}

export type PredictedWinner = 'home' | 'away';

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

export type LeaderboardPeriod = 'today' | 'this_week' | 'all_time';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function joinVenue(venueId: string, nickname: string): Promise<CreatedPlayer> {
  const { data } = await apiClient.post<CreatedPlayer>(`/api/venues/${venueId}/players`, {
    nickname,
  });
  return data;
}

export async function fetchGames(venueId: string, signal?: AbortSignal): Promise<Game[]> {
  const { data } = await apiClient.get<Game[]>(`/api/venues/${venueId}/games`, { signal });
  return data;
}

export async function fetchLeaderboard(
  venueId: string,
  period: LeaderboardPeriod,
  signal?: AbortSignal,
): Promise<LeaderboardRow[]> {
  const { data } = await apiClient.get<LeaderboardRow[]>(
    `/api/venues/${venueId}/leaderboard`,
    { params: { period }, signal },
  );
  return data;
}

export async function fetchMyPicks(venueId: string, signal?: AbortSignal): Promise<MyPick[]> {
  const { data } = await apiClient.get<MyPick[]>(`/api/venues/${venueId}/picks`, { signal });
  return data;
}

export async function submitPick(
  venueId: string,
  gameId: string,
  predictedWinner: PredictedWinner,
): Promise<SubmittedPick> {
  const { data } = await apiClient.post<SubmittedPick>(`/api/venues/${venueId}/picks`, {
    gameId,
    predictedWinner,
  });
  return data;
}
