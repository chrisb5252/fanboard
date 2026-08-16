import { logger as rootLogger, type Logger } from './logger';
import {
  SportsProvider,
  type FetchGamesOptions,
  type GameStatus,
  type GameWinner,
  type NormalizedGame,
} from './sports-provider';

/**
 * ESPN's public scoreboard as a SportsProvider.
 *
 * Why a second provider rather than replacing TheSportsDB: measured against the
 * live APIs on the same day, TheSportsDB's free key returned 4 NFL games and no
 * NHL at all, while ESPN returned 16 and 7. The free key is a sample, not a
 * slate. ESPN needs no key.
 *
 * The endpoint is undocumented, which is the real risk here — it can change
 * without notice. Everything below is therefore defensive: a missing field
 * skips one game rather than failing a poll, and the shape is read from
 * `competitors[]`, verified against live responses rather than assumed.
 */

const DEFAULT_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';
const DEFAULT_TIMEOUT_MS = 8_000;

/** The four leagues ESPN covers for this product, and their URL segments. */
export const ESPN_LEAGUES = {
  NFL: { sport: 'football', league: 'nfl' },
  NBA: { sport: 'basketball', league: 'nba' },
  MLB: { sport: 'baseball', league: 'mlb' },
  NHL: { sport: 'hockey', league: 'nhl' },
} as const;

export type EspnLeague = keyof typeof ESPN_LEAGUES;

export interface EspnProviderOptions {
  baseUrl?: string;
  logger?: Logger;
  timeoutMs?: number;
  /** Which leagues to ask for. Defaults to all four. */
  leagues?: readonly EspnLeague[];
  fetchImpl?: typeof fetch;
}

/**
 * Maps ESPN's status vocabulary onto ours.
 *
 * ESPN has many more states than this product models — delayed, rain delay,
 * end of period, halftime. Anything in play maps to `live`, because from a
 * patron's point of view the only question is whether picks are still open.
 */
function toStatus(name: string | undefined): GameStatus {
  switch (name) {
    case 'STATUS_SCHEDULED':
    case 'STATUS_PRE':
      return 'scheduled';
    case 'STATUS_FINAL':
    case 'STATUS_FULL_TIME':
      return 'final';
    case 'STATUS_POSTPONED':
    case 'STATUS_DELAYED':
    case 'STATUS_RAIN_DELAY':
      return 'postponed';
    case 'STATUS_CANCELED':
    case 'STATUS_CANCELLED':
    case 'STATUS_SUSPENDED':
      return 'cancelled';
    case undefined:
      return 'scheduled';
    default:
      // Anything else ESPN reports mid-game — halftime, end of period,
      // overtime — is a game in progress.
      return 'live';
  }
}

/** ISO date (YYYY-MM-DD) to ESPN's compact form (YYYYMMDD). */
export function toEspnDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

function parseScore(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Decides the winner, and only once the game is actually final.
 *
 * Reading it from scores at any other time would call a game for whoever
 * happens to be ahead, and grading would settle a pick mid-match.
 */
function decideWinner(
  status: GameStatus,
  homeScore: number | null,
  awayScore: number | null,
): GameWinner | null {
  if (status !== 'final' || homeScore === null || awayScore === null) {
    return null;
  }
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return 'draw';
}

interface EspnCompetitor {
  homeAway?: string;
  score?: unknown;
  team?: { displayName?: string; shortDisplayName?: string; logo?: string };
}

export class EspnProvider extends SportsProvider {
  readonly name = 'espn';

  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly leagues: readonly EspnLeague[];
  private readonly fetchImpl: typeof fetch;

  constructor(options: EspnProviderOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.log = options.logger ?? rootLogger.child({ provider: 'espn' });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.leagues = options.leagues ?? (Object.keys(ESPN_LEAGUES) as EspnLeague[]);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One request per league for the given day, merged.
   *
   * A league failing is logged and skipped rather than thrown: a poll that
   * loses the NFL slate because the NHL endpoint hiccuped would be worse than
   * one that ingests three leagues out of four.
   */
  async fetchGames(date: string, options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    const wanted = this.selectLeagues(options?.leagues);
    const merged = new Map<string, NormalizedGame>();

    for (const league of wanted) {
      const games = await this.fetchLeague(league, date);
      for (const game of games) {
        merged.set(game.externalId, game);
      }
    }

    return [...merged.values()];
  }

  /** Intersects the caller's league filter with what ESPN can serve. */
  private selectLeagues(requested: readonly string[] | undefined): readonly EspnLeague[] {
    if (requested === undefined || requested.length === 0) {
      return this.leagues;
    }
    const wanted = new Set(requested.map((entry) => entry.trim().toUpperCase()));
    return this.leagues.filter((league) => wanted.has(league));
  }

  private async fetchLeague(league: EspnLeague, date: string): Promise<NormalizedGame[]> {
    const { sport, league: slug } = ESPN_LEAGUES[league];
    const url = `${this.baseUrl}/${sport}/${slug}/scoreboard?dates=${toEspnDate(date)}`;

    let body: unknown;
    try {
      // ESPN is a third party on the critical path of a background job; an
      // unbounded fetch would let one slow response stall the whole poll.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
          this.log.error('espn returned an error status', {
            league,
            date,
            status: response.status,
          });
          return [];
        }
        body = await response.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      this.log.error('espn request failed', { league, date, error });
      return [];
    }

    return this.normalize(body, league, date);
  }

  private normalize(body: unknown, league: EspnLeague, date: string): NormalizedGame[] {
    if (body === null || typeof body !== 'object') {
      return [];
    }

    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events)) {
      // No events for a date is ordinary — most leagues do not play daily.
      return [];
    }

    const games: NormalizedGame[] = [];
    let discarded = 0;

    for (const raw of events) {
      const game = this.normalizeEvent(raw, league);
      if (game === null) {
        discarded += 1;
        continue;
      }
      games.push(game);
    }

    this.log.info('normalized espn response', {
      league,
      date,
      received: events.length,
      normalized: games.length,
      discarded,
    });

    return games;
  }

  /** Returns null for anything unusable, rather than a half-built game. */
  private normalizeEvent(raw: unknown, league: EspnLeague): NormalizedGame | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const event = raw as {
      id?: unknown;
      date?: unknown;
      status?: { type?: { name?: string } };
      competitions?: unknown;
    };

    const externalId = typeof event.id === 'string' ? event.id : String(event.id ?? '');
    if (externalId === '' || externalId === 'undefined') {
      return null;
    }

    const scheduledAt = new Date(String(event.date ?? ''));
    if (Number.isNaN(scheduledAt.getTime())) {
      return null;
    }

    const competitions = Array.isArray(event.competitions) ? event.competitions : [];
    const competition = competitions[0] as { competitors?: unknown } | undefined;
    const competitors = Array.isArray(competition?.competitors)
      ? (competition.competitors as EspnCompetitor[])
      : [];

    // Read by homeAway rather than by position: ESPN has no `home`/`away`
    // objects, and the array order is not contractual.
    const home = competitors.find((entry) => entry.homeAway === 'home');
    const away = competitors.find((entry) => entry.homeAway === 'away');

    const homeTeam = home?.team?.displayName ?? home?.team?.shortDisplayName;
    const awayTeam = away?.team?.displayName ?? away?.team?.shortDisplayName;
    if (
      typeof homeTeam !== 'string' ||
      typeof awayTeam !== 'string' ||
      homeTeam === '' ||
      awayTeam === ''
    ) {
      // A game with no teams cannot be picked on; better dropped than shown as
      // "Unknown vs Unknown" on a TV.
      return null;
    }

    const status = toStatus(event.status?.type?.name);
    const homeScore = parseScore(home?.score);
    const awayScore = parseScore(away?.score);

    return {
      externalId,
      league,
      sport: ESPN_LEAGUES[league].sport,
      homeTeam,
      awayTeam,
      homeLogoUrl: home?.team?.logo ?? null,
      awayLogoUrl: away?.team?.logo ?? null,
      scheduledAt,
      status,
      homeScore,
      awayScore,
      winner: decideWinner(status, homeScore, awayScore),
    };
  }
}
