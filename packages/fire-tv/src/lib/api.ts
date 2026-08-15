import axios, { type AxiosInstance } from 'axios';
import { log } from './log';

/** Mirrors the backend's DisplayGame. Statuses are lower-case. */
export interface DisplayGame {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: string;
  scheduledAt: string;
  /** Always null today; the backend has no column for in-game progress. */
  quarter: string | null;
  period: string | null;
  inning: string | null;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
}

export interface DisplayLeaderboardEntry {
  rank: number;
  nickname: string;
  wins: number;
  losses: number;
  points: number;
}

export interface DisplayPayload {
  qrCode: string;
  games: DisplayGame[];
  leaderboard: DisplayLeaderboardEntry[];
  refreshedAt: string;
}

/** Empty by default so requests are same-origin via the dev proxy. */
export const BASE_URL = (import.meta.env as Record<string, unknown>)['VITE_API_URL'];

const REQUEST_TIMEOUT_MS = 8_000;

const client: AxiosInstance = axios.create({
  baseURL: typeof BASE_URL === 'string' ? BASE_URL : '',
  timeout: REQUEST_TIMEOUT_MS,
});

/**
 * Last good payload.
 *
 * A TV must always be showing something. When the network drops mid-evening the
 * right behaviour is to keep the last scoreboard on screen, not to blank it —
 * a slightly stale score is useful, an empty screen is not.
 */
let cached: DisplayPayload | null = null;

export function getCachedDisplay(): DisplayPayload | null {
  return cached;
}

/** Test seam. */
export function resetDisplayCache(): void {
  cached = null;
}

function isDisplayPayload(value: unknown): value is DisplayPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['qrCode'] === 'string' &&
    Array.isArray(candidate['games']) &&
    Array.isArray(candidate['leaderboard'])
  );
}

export class DisplayFetchError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = 'DisplayFetchError';
    this.status = status;
  }
}

export interface DisplayResult {
  payload: DisplayPayload;
  /**
   * False when the payload came from cache because the request failed.
   *
   * This flag exists because resolving with the cache is indistinguishable from
   * success to a caller that only sees a payload — which silently disabled the
   * reconnect backoff: once anything was cached, every failure looked like a
   * win and the poll stayed at 10s no matter how long the API was down.
   */
  live: boolean;
}

/**
 * Fetches the display payload.
 *
 * Resolves with the cached payload when the request fails, flagged `live:
 * false`, so a caller can render unconditionally and still know the link is
 * down. Throws only when there is nothing at all to show — the very first fetch
 * failing — which the caller turns into a holding screen, not an error message.
 *
 * The display key travels in a header and is never logged, never placed in a
 * URL (where it would land in proxy and server access logs), and never rendered.
 */
export async function fetchDisplay(
  deviceId: string,
  displayKey: string,
  signal?: AbortSignal,
): Promise<DisplayResult> {
  try {
    const response = await client.get<unknown>(`/api/devices/${deviceId}/display`, {
      headers: { 'x-display-key': displayKey },
      ...(signal === undefined ? {} : { signal }),
    });

    if (!isDisplayPayload(response.data)) {
      throw new DisplayFetchError('malformed display payload', response.status);
    }

    cached = response.data;
    return { payload: response.data, live: true };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;

    // Deliberately logs the status and device, never the key.
    log.warn('display fetch failed', {
      deviceId,
      status: status ?? 'network',
      servingCache: cached !== null,
    });

    if (cached !== null) {
      return { payload: cached, live: false };
    }
    throw new DisplayFetchError('display fetch failed and no cached payload exists', status);
  }
}
