/**
 * Integration coverage for the parts a fake cannot prove: that the UNNEST
 * upsert is valid SQL, that its parameter arrays line up with their columns,
 * that timestamps survive the round trip as the same instant, and that a failed
 * statement really does roll back.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with schema.sql
 * applied. CI supplies it from the Postgres service container.
 *
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fanboard \
 *     npm run test --workspace @fanboard/backend
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger';
import {
  SportsProvider,
  type FetchGamesOptions,
  type NormalizedGame,
} from '../src/lib/sports-provider';
// Type-only namespace imports: the modules are loaded dynamically inside
// beforeAll, after DATABASE_URL has been pointed at the test database.
import type * as DbNamespace from '../src/lib/db';
import type * as WorkerNamespace from '../src/workers/poll-games';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

type DbModule = typeof DbNamespace;
type WorkerModule = typeof WorkerNamespace;

const silentLogger = createLogger({ level: 'silent' });

class StubProvider extends SportsProvider {
  readonly name = 'stub';
  constructor(private games: NormalizedGame[]) {
    super();
  }
  setGames(games: NormalizedGame[]): void {
    this.games = games;
  }
  fetchGames(): Promise<NormalizedGame[]> {
    return Promise.resolve(this.games);
  }
  override fetchGamesForRange(
    _startDate: string,
    _days: number,
    _options?: FetchGamesOptions,
  ): Promise<NormalizedGame[]> {
    return Promise.resolve(this.games);
  }
}

function game(overrides: Partial<NormalizedGame> = {}): NormalizedGame {
  return {
    externalId: 'evt-1',
    league: 'NFL',
    sport: 'American Football',
    homeTeam: 'Bears',
    awayTeam: 'Packers',
    homeLogoUrl: 'https://example.test/home.png',
    awayLogoUrl: 'https://example.test/away.png',
    scheduledAt: new Date('2025-01-19T10:00:00Z'),
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    winner: null,
    ...overrides,
  };
}

describe.skipIf(TEST_DATABASE_URL === undefined)('poll-games against real PostgreSQL', () => {
  let db: DbModule;
  let worker: WorkerModule;
  let venueId: string;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'integration-test-key';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    worker = await import('../src/workers/poll-games');
  });

  /**
   * Vitest runs test files in parallel against one database, so cleanup must
   * only ever remove rows this file created. A blanket `DELETE FROM venues`
   * cascades into whatever another file is midway through.
   */
  const VENUE_PREFIX = 'pollgames-int';
  const cleanup = () =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${VENUE_PREFIX}-%`]);

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  });

  beforeEach(async () => {
    await cleanup();
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1, $2) RETURNING id',
      [`${VENUE_PREFIX}-primary`, `key-${Date.now()}-${Math.random()}`],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('failed to seed venue');
    }
    venueId = row.id;
  });

  function run(provider: SportsProvider) {
    return worker.pollGamesOnce({
      provider,
      logger: silentLogger,
      listVenueIds: () => Promise.resolve([venueId]),
      withTransaction: db.withTransaction,
      now: () => new Date('2025-01-19T00:00:00Z'),
    });
  }

  it('inserts new games and reports them as inserted', async () => {
    const provider = new StubProvider([
      game({ externalId: 'evt-1' }),
      game({ externalId: 'evt-2', homeTeam: 'Lions', awayTeam: 'Vikings' }),
    ]);

    const result = await run(provider);

    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.failedVenues).toBe(0);

    const stored = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM games WHERE venue_id = $1',
      [venueId],
    );
    expect(stored.rows[0]?.count).toBe('2');
  });

  it('preserves the scheduled instant exactly through the timestamptz array', async () => {
    await run(new StubProvider([game({ scheduledAt: new Date('2025-01-19T10:00:00Z') })]));

    const stored = await db.query<{ scheduled_at: Date }>(
      'SELECT scheduled_at FROM games WHERE venue_id = $1 AND external_id = $2',
      [venueId, 'evt-1'],
    );
    expect(stored.rows[0]?.scheduled_at.toISOString()).toBe('2025-01-19T10:00:00.000Z');
  });

  it('updates an existing game rather than duplicating it', async () => {
    const provider = new StubProvider([game()]);
    await run(provider);

    provider.setGames([
      game({ status: 'final', homeScore: 24, awayScore: 17, winner: 'home' }),
    ]);
    const second = await run(provider);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const stored = await db.query<{
      status: string;
      home_score: number;
      away_score: number;
      winner: string;
      count: string;
    }>(
      `SELECT status, home_score, away_score, winner, (SELECT count(*) FROM games WHERE venue_id = $1) AS count
       FROM games WHERE venue_id = $1 AND external_id = $2`,
      [venueId, 'evt-1'],
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'final',
      home_score: 24,
      away_score: 17,
      winner: 'home',
      count: '1',
    });
  });

  it('keeps a previously known logo when the provider omits it', async () => {
    const provider = new StubProvider([game()]);
    await run(provider);

    provider.setGames([game({ homeLogoUrl: null, awayLogoUrl: null })]);
    await run(provider);

    const stored = await db.query<{ home_logo_url: string | null }>(
      'SELECT home_logo_url FROM games WHERE venue_id = $1 AND external_id = $2',
      [venueId, 'evt-1'],
    );
    expect(stored.rows[0]?.home_logo_url).toBe('https://example.test/home.png');
  });

  it('refuses to rewrite a game that has already been graded', async () => {
    const provider = new StubProvider([
      game({ status: 'final', homeScore: 24, awayScore: 17, winner: 'home' }),
    ]);
    await run(provider);

    await db.query(
      'UPDATE games SET graded_at = NOW() WHERE venue_id = $1 AND external_id = $2',
      [venueId, 'evt-1'],
    );

    // A late provider correction must not move the result under settled picks.
    provider.setGames([
      game({ status: 'final', homeScore: 0, awayScore: 99, winner: 'away' }),
    ]);
    const third = await run(provider);

    expect(third.skipped).toBe(1);
    expect(third.updated).toBe(0);

    const stored = await db.query<{ winner: string; away_score: number }>(
      'SELECT winner, away_score FROM games WHERE venue_id = $1 AND external_id = $2',
      [venueId, 'evt-1'],
    );
    expect(stored.rows[0]).toMatchObject({ winner: 'home', away_score: 17 });
  });

  it('rolls the whole batch back when one row violates a constraint', async () => {
    // status 'halftime' fails the games_status_check CHECK constraint.
    const provider = new StubProvider([
      game({ externalId: 'ok-1' }),
      game({ externalId: 'bad-1', status: 'halftime' as NormalizedGame['status'] }),
      game({ externalId: 'ok-2' }),
    ]);

    const result = await run(provider);

    expect(result.failedVenues).toBe(1);
    expect(result.inserted).toBe(0);

    // Atomicity: the two valid rows must not have landed either.
    const stored = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM games WHERE venue_id = $1',
      [venueId],
    );
    expect(stored.rows[0]?.count).toBe('0');
  });

  it('leaves the pool usable after a rolled-back transaction', async () => {
    await run(new StubProvider([game({ status: 'halftime' as NormalizedGame['status'] })]));
    // A leaked client would eventually exhaust the pool and hang here.
    await expect(db.pingDatabase()).resolves.toBe(true);
  });
});
