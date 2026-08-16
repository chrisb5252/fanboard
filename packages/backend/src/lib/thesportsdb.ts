import { z } from 'zod';
import { logger as defaultLogger, registerSecret, type Logger } from './logger';
import {
  SportsProvider,
  assertIsoDate,
  deriveWinner,
  filterByLeagues,
  type CacheStore,
  type FetchGamesOptions,
  type GameStatus,
  type NormalizedGame,
} from './sports-provider';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TheSportsDBProviderOptions {
  apiKey: string;
  /** Override for tests or for the v2 host. */
  baseUrl?: string;
  /** TheSportsDB scopes eventsday.php by sport; defaults to Soccer. */
  sport?: string;
  fetchImpl?: FetchLike;
  cache?: CacheStore;
  cacheTtlSeconds?: number;
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const DEFAULT_SPORT = 'Soccer';
const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * TheSportsDB returns everything as strings, and every field is nullable in
 * practice regardless of what the docs say. The schema mirrors that reality;
 * normalisation is where it becomes trustworthy.
 */
const rawEventSchema = z.object({
  idEvent: z.string().nullish(),
  strSport: z.string().nullish(),
  strLeague: z.string().nullish(),
  strHomeTeam: z.string().nullish(),
  strAwayTeam: z.string().nullish(),
  strHomeTeamBadge: z.string().nullish(),
  strAwayTeamBadge: z.string().nullish(),
  intHomeScore: z.union([z.string(), z.number()]).nullish(),
  intAwayScore: z.union([z.string(), z.number()]).nullish(),
  strTimestamp: z.string().nullish(),
  dateEvent: z.string().nullish(),
  strTime: z.string().nullish(),
  strStatus: z.string().nullish(),
  strPostponed: z.string().nullish(),
});

const eventsDayResponseSchema = z.object({
  events: z.array(rawEventSchema).nullish(),
});

export type RawTheSportsDBEvent = z.infer<typeof rawEventSchema>;

/** Status codes that mean the game is over and the score is authoritative. */
const FINAL_STATUSES = new Set([
  'FT',
  'AET',
  'AOT',
  'PEN',
  'AP',
  'FINAL',
  'FINISHED',
  'MATCH FINISHED',
  'GAME FINISHED',
]);

/** Status codes that mean the game is currently being played. */
const LIVE_STATUSES = new Set([
  '1H',
  '2H',
  'HT',
  'ET',
  'BT',
  'P',
  'LIVE',
  'IN PLAY',
  'INPLAY',
  '1Q',
  '2Q',
  '3Q',
  '4Q',
  '1P',
  '2P',
  '3P',
  'OT',
  'BREAK',
]);

export function mapStatus(
  rawStatus: string | null | undefined,
  postponedFlag: string | null | undefined,
): GameStatus {
  const status = (rawStatus ?? '').trim().toUpperCase();

  // Order matters: a postponed game can still carry a stale in-play status.
  if (status.includes('CANC') || status.includes('ABAND')) {
    return 'cancelled';
  }
  if ((postponedFlag ?? '').trim().toLowerCase() === 'yes' || status.includes('POSTP')) {
    return 'postponed';
  }
  if (FINAL_STATUSES.has(status)) {
    return 'final';
  }
  if (LIVE_STATUSES.has(status)) {
    return 'live';
  }
  return 'scheduled';
}

export function parseScore(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  // Negative scores would violate the games_home_score_check constraint.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const HAS_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * TheSportsDB emits `strTimestamp` as "2025-01-19T10:00:00" — no offset, but
 * documented as UTC. Handing that straight to `new Date()` makes V8 read it as
 * *local* time, which silently shifts every kick-off by the server's offset and
 * puts games on the wrong day. Appending Z is the whole fix, and it is the
 * single most important line in this file.
 */
export function parseScheduledAt(event: RawTheSportsDBEvent): Date | null {
  const timestamp = event.strTimestamp?.trim();
  if (timestamp !== undefined && timestamp !== '') {
    const normalized = HAS_TIMEZONE_PATTERN.test(timestamp) ? timestamp : `${timestamp}Z`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const date = event.dateEvent?.trim();
  if (date === undefined || date === '') {
    return null;
  }

  const timeMatch = TIME_PATTERN.exec(event.strTime?.trim() ?? '');
  const time =
    timeMatch === null
      ? '00:00:00'
      : `${timeMatch[1] ?? '00'}:${timeMatch[2] ?? '00'}:${timeMatch[3] ?? '00'}`;

  const parsed = new Date(`${date}T${time}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class TheSportsDBProvider extends SportsProvider {
  readonly name = 'thesportsdb';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sport: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlSeconds: number;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(options: TheSportsDBProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.sport = options.sport ?? DEFAULT_SPORT;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.cache = options.cache;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = (options.logger ?? defaultLogger).child({ provider: this.name });

    // Belt and braces: the key lives in the URL path for the v1 API, so on top
    // of redacting it at every call site we register it for value-scrubbing.
    registerSecret(this.apiKey);
  }

  /**
   * Strips the API key from a URL before it reaches a log line.
   *
   * Targets the exact path segment rather than a global replace: a short key
   * (the public test key is "123") would otherwise corrupt unrelated digits.
   */
  private redactUrl(url: string): string {
    return url.split(`/json/${this.apiKey}/`).join('/json/***/');
  }

  /**
   * Takes the sport rather than reading the instance default.
   *
   * It used to read `this.sport`, which meant a per-call scope was accepted,
   * threaded through, cached under its own key — and then silently ignored at
   * the last step, so every request went out as the default sport. The symptom
   * was five sports' worth of requests all returning soccer.
   */
  private buildUrl(date: string, sport: string): string {
    const key = encodeURIComponent(this.apiKey);
    const query = new URLSearchParams({ d: date, s: sport });
    return `${this.baseUrl}/${key}/eventsday.php?${query.toString()}`;
  }

  /**
   * Scoped by sport as well as date.
   *
   * The endpoint answers per sport, so keying on date alone would let the first
   * sport fetched for a day serve every other sport from cache — the NFL slate
   * returned for a Basketball request. Harmless-looking and very hard to spot,
   * since the data is real, just for the wrong sport.
   */
  private cacheKey(date: string, sport: string): string {
    return `sports:${this.name}:eventsday:${sport.toLowerCase()}:${date}`;
  }

  async fetchGames(date: string, options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    try {
      assertIsoDate(date);
    } catch (error) {
      this.log.error('rejected invalid date', { date, error });
      return [];
    }

    // One request per sport scope. The endpoint answers for a single sport, so
    // covering several means several calls merged — not one wider call.
    const sports =
      options?.sports !== undefined && options.sports.length > 0
        ? options.sports
        : [options?.sport ?? this.sport];

    const merged = new Map<string, NormalizedGame>();
    for (const sport of sports) {
      const body = await this.loadResponseBody(date, sport);
      if (body === null) {
        // One scope failing must not lose the others: a 503 on Soccer should
        // still leave the day's NFL slate ingested.
        continue;
      }
      for (const game of this.normalizeBody(body, date)) {
        merged.set(game.externalId, game);
      }
    }

    return filterByLeagues([...merged.values()], options?.leagues);
  }

  /** Returns the raw JSON body from cache or the network, or null on failure. */
  private async loadResponseBody(date: string, sport: string): Promise<string | null> {
    const key = this.cacheKey(date, sport);

    if (this.cache !== undefined) {
      try {
        const cached = await this.cache.get(key);
        if (cached !== null) {
          this.log.debug('sports api cache hit', { date, sport, cacheKey: key });
          return cached;
        }
      } catch (error) {
        // A cache outage must degrade to a live call, never fail the fetch.
        this.log.warn('cache read failed, falling through to network', { date, error });
      }
    }

    const body = await this.requestDay(date, sport);
    if (body === null) {
      return null;
    }

    if (this.cache !== undefined) {
      try {
        await this.cache.set(key, body, this.cacheTtlSeconds);
      } catch (error) {
        this.log.warn('cache write failed', { date, error });
      }
    }

    return body;
  }

  /** Performs the HTTP call. Returns null on any failure, never throws. */
  private async requestDay(date: string, sport: string): Promise<string | null> {
    const url = this.buildUrl(date, sport);
    const safeUrl = this.redactUrl(url);
    const startedAt = Date.now();

    this.log.info('sports api request', { date, sport, url: safeUrl });

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        this.log.error('sports api returned an error status', {
          date,
          url: safeUrl,
          status: response.status,
          statusText: response.statusText,
          durationMs,
        });
        return null;
      }

      const body = await response.text();
      this.log.info('sports api response', {
        date,
        url: safeUrl,
        status: response.status,
        durationMs,
        bytes: body.length,
      });
      return body;
    } catch (error) {
      this.log.error('sports api request failed', {
        date,
        url: safeUrl,
        durationMs: Date.now() - startedAt,
        error,
      });
      return null;
    }
  }

  /** Parses and normalises a raw body. Returns [] for anything unusable. */
  private normalizeBody(body: string, date: string): NormalizedGame[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      this.log.error('sports api returned invalid JSON', { date, error });
      return [];
    }

    const result = eventsDayResponseSchema.safeParse(parsed);
    if (!result.success) {
      this.log.error('sports api response failed schema validation', {
        date,
        issues: result.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return [];
    }

    const events = result.data.events;
    if (events === null || events === undefined) {
      // A day with no fixtures is normal, not an error.
      this.log.debug('sports api returned no events', { date });
      return [];
    }

    const games: NormalizedGame[] = [];
    let discarded = 0;

    for (const event of events) {
      const game = this.normalizeEvent(event);
      if (game === null) {
        discarded += 1;
        continue;
      }
      games.push(game);
    }

    this.log.info('normalized sports api response', {
      date,
      received: events.length,
      normalized: games.length,
      discarded,
    });

    return games;
  }

  /** Returns null when an event lacks the fields games.* requires NOT NULL. */
  private normalizeEvent(event: RawTheSportsDBEvent): NormalizedGame | null {
    const externalId = event.idEvent?.trim();
    const homeTeam = event.strHomeTeam?.trim();
    const awayTeam = event.strAwayTeam?.trim();
    const league = event.strLeague?.trim();
    const sport = event.strSport?.trim();
    const scheduledAt = parseScheduledAt(event);

    if (
      externalId === undefined ||
      externalId === '' ||
      homeTeam === undefined ||
      homeTeam === '' ||
      awayTeam === undefined ||
      awayTeam === '' ||
      league === undefined ||
      league === '' ||
      sport === undefined ||
      sport === '' ||
      scheduledAt === null
    ) {
      return null;
    }

    const status = mapStatus(event.strStatus, event.strPostponed);
    const homeScore = parseScore(event.intHomeScore);
    const awayScore = parseScore(event.intAwayScore);

    return {
      externalId,
      league,
      sport,
      homeTeam,
      awayTeam,
      homeLogoUrl: emptyToNull(event.strHomeTeamBadge),
      awayLogoUrl: emptyToNull(event.strAwayTeamBadge),
      scheduledAt,
      status,
      homeScore,
      awayScore,
      winner: deriveWinner(status, homeScore, awayScore),
    };
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}
