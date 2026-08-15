import axios, { type AxiosInstance } from 'axios';

/**
 * Admin API client.
 *
 * The key is held in sessionStorage and attached per request rather than baked
 * into the instance, so a logout takes effect immediately and a request issued
 * after sign-out cannot carry a stale credential.
 *
 * sessionStorage rather than localStorage, as specified: it clears when the tab
 * closes, so a shared back-office machine does not leave a venue signed in
 * indefinitely. It is worth being clear about the limit — sessionStorage is
 * still readable by any script on this origin, so an XSS here reads the key.
 * Removing that exposure needs a server-set HttpOnly admin session cookie,
 * which the backend does not offer today.
 */

export const API_KEY_STORAGE = 'fanboard.admin.key';

export function readApiKey(): string | null {
  try {
    return window.sessionStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function writeApiKey(key: string): void {
  try {
    window.sessionStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    // Storage blocked; the session lives only as long as this page view.
  }
}

export function clearApiKey(): void {
  try {
    window.sessionStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Nothing to do.
  }
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const key = readApiKey();
  if (key !== null) {
    config.headers.set('Authorization', `Bearer ${key}`);
  }
  return config;
});

// ---------------------------------------------------------------------------
// Shapes, mirroring the backend
// ---------------------------------------------------------------------------

export const LEAGUES = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAFB', 'NCAAB'] as const;
export type League = (typeof LEAGUES)[number];

/** The whitelist codes are terse; operators should not have to decode them. */
export const LEAGUE_LABELS: Record<League, string> = {
  NFL: 'NFL',
  NBA: 'NBA',
  MLB: 'MLB',
  NHL: 'NHL',
  NCAAFB: 'College Football',
  NCAAB: 'College Basketball',
};

export interface VenueSession {
  venueId: string;
  name: string;
  enabledLeagues: League[];
}

export interface VenueConfig {
  venueId: string;
  enabledLeagues: League[];
}

export interface PairedDevice {
  deviceId: string;
  displayKey: string;
  displayName: string;
}

export interface DeviceStatus {
  deviceId: string;
  displayName: string;
  online: boolean;
  lastHeartbeat: string | null;
  fireTvDeviceId: string | null;
}

export interface AdminPlayer {
  playerId: string;
  nickname: string;
  createdAt: string;
  lastSeenAt: string;
  totalPicks: number;
  totalPoints: number;
}

export type PickStatusFilter = 'all' | 'pending' | 'graded' | 'voided';

export interface AdminPick {
  pickId: string;
  gameId: string;
  playerId: string;
  nickname: string;
  predictedWinner: 'home' | 'away' | 'draw';
  correct: boolean | null;
  points: number | null;
  submittedAt: string;
  gradedAt: string | null;
}

export interface Game {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: string;
  scheduledAt: string;
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

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Resolves the API key to its venue. A 200 is also the sign-in check. */
export async function fetchSession(): Promise<VenueSession> {
  const { data } = await apiClient.get<VenueSession>('/api/admin/session');
  return data;
}

export async function fetchConfig(venueId: string): Promise<VenueConfig> {
  const { data } = await apiClient.get<VenueConfig>(`/api/admin/venues/${venueId}/config`);
  return data;
}

export async function saveConfig(venueId: string, enabledLeagues: League[]): Promise<VenueConfig> {
  const { data } = await apiClient.post<VenueConfig>(`/api/admin/venues/${venueId}/config`, {
    enabledLeagues,
  });
  return data;
}

export async function pairDevice(
  venueId: string,
  displayName: string,
  fireTvDeviceId: string,
): Promise<PairedDevice> {
  const { data } = await apiClient.post<PairedDevice>(
    `/api/admin/venues/${venueId}/device-pairing`,
    { displayName, fireTvDeviceId },
  );
  return data;
}

export async function fetchDeviceStatus(
  venueId: string,
  signal?: AbortSignal,
): Promise<DeviceStatus[]> {
  const { data } = await apiClient.get<DeviceStatus[]>(
    `/api/admin/venues/${venueId}/device-status`,
    { signal },
  );
  return data;
}

export async function fetchPlayers(
  venueId: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<AdminPlayer[]> {
  const { data } = await apiClient.get<AdminPlayer[]>(`/api/admin/venues/${venueId}/players`, {
    params: { limit, offset },
    signal,
  });
  return data;
}

export async function fetchPicks(
  venueId: string,
  filters: { gameId?: string; playerId?: string; status?: PickStatusFilter },
  signal?: AbortSignal,
): Promise<AdminPick[]> {
  const params: Record<string, string> = {};
  if (filters.gameId !== undefined && filters.gameId !== '') {
    params['gameId'] = filters.gameId;
  }
  if (filters.playerId !== undefined && filters.playerId !== '') {
    params['playerId'] = filters.playerId;
  }
  if (filters.status !== undefined) {
    params['status'] = filters.status;
  }
  const { data } = await apiClient.get<AdminPick[]>(`/api/admin/venues/${venueId}/picks`, {
    params,
    signal,
  });
  return data;
}

/** Public endpoints — no API key needed, but the console uses them for context. */
export async function fetchGames(venueId: string, signal?: AbortSignal): Promise<Game[]> {
  const { data } = await apiClient.get<Game[]>(`/api/venues/${venueId}/games`, { signal });
  return data;
}

export async function fetchLeaderboard(
  venueId: string,
  signal?: AbortSignal,
): Promise<LeaderboardRow[]> {
  const { data } = await apiClient.get<LeaderboardRow[]>(
    `/api/venues/${venueId}/leaderboard`,
    { params: { period: 'today' }, signal },
  );
  return data;
}
