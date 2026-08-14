import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import { createLogger } from '../src/lib/logger';
import {
  SportsProvider,
  type FetchGamesOptions,
  type NormalizedGame,
} from '../src/lib/sports-provider';
import {
  POLL_GAMES_INTERVAL_MS,
  pollGamesOnce,
  upsertVenueGames,
  type PollGamesDeps,
} from '../src/workers/poll-games';

const VENUE_A = '11111111-1111-1111-1111-111111111111';
const VENUE_B = '22222222-2222-2222-2222-222222222222';

const silentLogger = createLogger({ level: 'silent' });

function game(overrides: Partial<NormalizedGame> = {}): NormalizedGame {
  return {
    externalId: '2013667',
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

/** A provider that returns canned games and counts how often it was asked. */
class StubProvider extends SportsProvider {
  readonly name = 'stub';
  calls = 0;
  lastOptions: FetchGamesOptions | undefined;

  constructor(private readonly games: NormalizedGame[]) {
    super();
  }

  fetchGames(_date: string, options?: FetchGamesOptions): Promise<NormalizedGame[]> {
    this.calls += 1;
    this.lastOptions = options;
    return Promise.resolve(this.games);
  }

  // Collapse the 7-day walk so tests assert on the worker, not the range loop.
  override fetchGamesForRange(
    _startDate: string,
    _days: number,
    options?: FetchGamesOptions,
  ): Promise<NormalizedGame[]> {
    this.calls += 1;
    this.lastOptions = options;
    return Promise.resolve(this.games);
  }
}

/**
 * Records the statement log so tests can assert BEGIN/COMMIT/ROLLBACK ordering,
 * which is the observable part of "the upsert is atomic".
 */
function fakeTransactor(
  handler: (sql: string, params?: readonly unknown[]) => Promise<SqlResult<never>>,
): {
  withTransaction: PollGamesDeps['withTransaction'];
  statements: string[];
} {
  const statements: string[] = [];

  const withTransaction: PollGamesDeps['withTransaction'] = async (work) => {
    statements.push('BEGIN');
    const tx: SqlExecutor = {
      query: async <T,>(sql: string, params?: readonly unknown[]) => {
        statements.push(sql.trim().split('\n')[0] ?? sql);
        return (await handler(sql, params)) as unknown as SqlResult<T>;
      },
    };
    try {
      const value = await work(tx);
      statements.push('COMMIT');
      return value;
    } catch (error) {
      statements.push('ROLLBACK');
      throw error;
    }
  };

  return { withTransaction, statements };
}

function rows(inserted: boolean[]): SqlResult<never> {
  return {
    rows: inserted.map((value) => ({ inserted: value })) as unknown as never[],
    rowCount: inserted.length,
  };
}

function baseDeps(overrides: Partial<PollGamesDeps> = {}): Partial<PollGamesDeps> {
  return {
    logger: silentLogger,
    now: () => new Date('2025-01-19T12:00:00Z'),
    daysAhead: 7,
    ...overrides,
  };
}

describe('upsertVenueGames', () => {
  it('sends one statement carrying parallel arrays, not one statement per game', async () => {
    const query = vi.fn().mockResolvedValue(rows([true, true]));
    const tx: SqlExecutor = { query };

    await upsertVenueGames(tx, VENUE_A, [game({ externalId: 'a' }), game({ externalId: 'b' })]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (venue_id, external_id) DO UPDATE');
    expect(sql).toContain('UNNEST');
    expect(params[0]).toBe(VENUE_A);
    expect(params[1]).toEqual(['a', 'b']);
  });

  it('counts inserts and updates apart via xmax', async () => {
    const tx: SqlExecutor = { query: vi.fn().mockResolvedValue(rows([true, false, false])) };

    const counts = await upsertVenueGames(tx, VENUE_A, [
      game({ externalId: 'a' }),
      game({ externalId: 'b' }),
      game({ externalId: 'c' }),
    ]);

    expect(counts).toEqual({ inserted: 1, updated: 2, skipped: 0 });
  });

  it('counts rows the WHERE clause protected as skipped', async () => {
    // Two games sent, one row back: the other was already graded.
    const tx: SqlExecutor = { query: vi.fn().mockResolvedValue(rows([false])) };

    const counts = await upsertVenueGames(tx, VENUE_A, [
      game({ externalId: 'a' }),
      game({ externalId: 'b' }),
    ]);

    expect(counts).toEqual({ inserted: 0, updated: 1, skipped: 1 });
  });

  it('does not issue a statement for an empty game list', async () => {
    const query = vi.fn();
    await expect(upsertVenueGames({ query }, VENUE_A, [])).resolves.toEqual({
      inserted: 0,
      updated: 0,
      skipped: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('derives the cancelled flag from status', async () => {
    const query = vi.fn().mockResolvedValue(rows([true, true]));
    await upsertVenueGames({ query }, VENUE_A, [
      game({ externalId: 'a', status: 'cancelled' }),
      game({ externalId: 'b', status: 'scheduled' }),
    ]);

    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[13]).toEqual([true, false]);
  });
});

describe('pollGamesOnce — insert and update paths', () => {
  it('inserts new games for every venue', async () => {
    const provider = new StubProvider([game({ externalId: 'a' }), game({ externalId: 'b' })]);
    const { withTransaction, statements } = fakeTransactor(() =>
      Promise.resolve(rows([true, true])),
    );

    const result = await pollGamesOnce(
      baseDeps({
        provider,
        listVenueIds: () => Promise.resolve([VENUE_A, VENUE_B]),
        withTransaction,
      }),
    );

    expect(result.fetched).toBe(2);
    expect(result.venues).toBe(2);
    expect(result.inserted).toBe(4);
    expect(result.updated).toBe(0);
    expect(result.failedVenues).toBe(0);
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(2);
  });

  it('updates games that already exist', async () => {
    const provider = new StubProvider([
      game({ externalId: 'a', status: 'final', homeScore: 3, awayScore: 1, winner: 'home' }),
    ]);
    const { withTransaction } = fakeTransactor(() => Promise.resolve(rows([false])));

    const result = await pollGamesOnce(
      baseDeps({
        provider,
        listVenueIds: () => Promise.resolve([VENUE_A]),
        withTransaction,
      }),
    );

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
  });

  it('fetches once and fans the same games out to every venue', async () => {
    const provider = new StubProvider([game()]);
    const { withTransaction } = fakeTransactor(() => Promise.resolve(rows([true])));

    await pollGamesOnce(
      baseDeps({
        provider,
        listVenueIds: () => Promise.resolve([VENUE_A, VENUE_B]),
        withTransaction,
      }),
    );

    // One provider call regardless of venue count — this is what stops venue
    // growth from multiplying third-party API traffic.
    expect(provider.calls).toBe(1);
  });

  it('de-duplicates games before they reach the upsert', async () => {
    // A duplicate external_id makes ON CONFLICT abort the whole statement.
    const provider = new StubProvider([
      game({ externalId: 'dup', homeScore: null }),
      game({ externalId: 'dup', homeScore: 2 }),
    ]);
    const query = vi.fn().mockResolvedValue(rows([true]));
    const withTransaction: PollGamesDeps['withTransaction'] = (work) => work({ query });

    const result = await pollGamesOnce(
      baseDeps({ provider, listVenueIds: () => Promise.resolve([VENUE_A]), withTransaction }),
    );

    expect(result.fetched).toBe(1);
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[1]).toEqual(['dup']);
    // Last one wins, so the fresher score survives.
    expect(params[10]).toEqual([2]);
  });
});

describe('pollGamesOnce — atomicity and failure isolation', () => {
  it('rolls back the transaction when the upsert fails', async () => {
    const provider = new StubProvider([game()]);
    const { withTransaction, statements } = fakeTransactor(() =>
      Promise.reject(new Error('deadlock detected')),
    );

    const result = await pollGamesOnce(
      baseDeps({ provider, listVenueIds: () => Promise.resolve([VENUE_A]), withTransaction }),
    );

    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(result.failedVenues).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('isolates a failing venue so the others still commit', async () => {
    const provider = new StubProvider([game()]);
    let call = 0;
    const { withTransaction, statements } = fakeTransactor(() => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('constraint violation')) : Promise.resolve(rows([true]));
    });

    const result = await pollGamesOnce(
      baseDeps({
        provider,
        listVenueIds: () => Promise.resolve([VENUE_A, VENUE_B]),
        withTransaction,
      }),
    );

    expect(result.failedVenues).toBe(1);
    expect(result.inserted).toBe(1);
    expect(statements.filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('never rejects when the provider blows up', async () => {
    const provider = new StubProvider([]);
    vi.spyOn(provider, 'fetchGamesForRange').mockRejectedValue(new Error('provider exploded'));

    const result = await pollGamesOnce(
      baseDeps({
        provider,
        listVenueIds: () => Promise.resolve([VENUE_A]),
        withTransaction: fakeTransactor(() => Promise.resolve(rows([]))).withTransaction,
      }),
    );

    expect(result.fetched).toBe(0);
    expect(result.venues).toBe(0);
  });

  it('never rejects when the venue lookup fails', async () => {
    const result = await pollGamesOnce(
      baseDeps({
        provider: new StubProvider([game()]),
        listVenueIds: () => Promise.reject(new Error('pool exhausted')),
        withTransaction: fakeTransactor(() => Promise.resolve(rows([]))).withTransaction,
      }),
    );

    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('touches no transaction when the provider returns nothing', async () => {
    const { withTransaction, statements } = fakeTransactor(() => Promise.resolve(rows([])));

    const result = await pollGamesOnce(
      baseDeps({
        provider: new StubProvider([]),
        listVenueIds: () => Promise.resolve([VENUE_A]),
        withTransaction,
      }),
    );

    expect(result.fetched).toBe(0);
    expect(statements).toEqual([]);
  });

  it('handles a venue list that is empty', async () => {
    const { withTransaction, statements } = fakeTransactor(() => Promise.resolve(rows([])));

    const result = await pollGamesOnce(
      baseDeps({
        provider: new StubProvider([game()]),
        listVenueIds: () => Promise.resolve([]),
        withTransaction,
      }),
    );

    expect(result.venues).toBe(0);
    expect(statements).toEqual([]);
  });
});

describe('pollGamesOnce — reporting and wiring', () => {
  it('reports a run id and duration for log correlation', async () => {
    const result = await pollGamesOnce(
      baseDeps({
        provider: new StubProvider([game()]),
        listVenueIds: () => Promise.resolve([VENUE_A]),
        withTransaction: fakeTransactor(() => Promise.resolve(rows([true]))).withTransaction,
      }),
    );

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes the league filter through to the provider', async () => {
    const provider = new StubProvider([game()]);

    await pollGamesOnce(
      baseDeps({
        provider,
        leagues: ['NFL'],
        listVenueIds: () => Promise.resolve([VENUE_A]),
        withTransaction: fakeTransactor(() => Promise.resolve(rows([true]))).withTransaction,
      }),
    );

    expect(provider.lastOptions?.leagues).toEqual(['NFL']);
  });

  it('polls on the 30 second cadence the spec calls for', () => {
    expect(POLL_GAMES_INTERVAL_MS).toBe(30_000);
  });
});
