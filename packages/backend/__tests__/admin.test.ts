import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, auditLog } from '../src/lib/audit';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import { ApiError } from '../src/lib/errors';
import { LEAGUE_WHITELIST, isLeague, validateEnabledLeagues } from '../src/lib/leagues';
import { createLogger, redactSensitive } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import {
  trustedUuid,
  validateLimit,
  validateOffset,
  validateOptionalUuid,
  type UUID,
} from '../src/lib/validators';
import {
  PICK_INSPECTOR_LIMIT,
  PLAYER_LIMIT_DEFAULT,
  PLAYER_LIMIT_MAX,
  listPicks,
  listPlayers,
  setVenueConfig,
} from '../src/services/admin';
import type * as AdminNamespace from '../src/services/admin';
import type * as AuditNamespace from '../src/lib/audit';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';

const silent = createLogger({ level: 'silent' });
const VENUE_A = trustedUuid('11111111-1111-1111-1111-111111111111');

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected rejection with ${status}, but it resolved`);
}

// ---------------------------------------------------------------------------
// League whitelist
// ---------------------------------------------------------------------------

describe('league whitelist', () => {
  it('accepts every whitelisted code', () => {
    expect(validateEnabledLeagues([...LEAGUE_WHITELIST])).toEqual([...LEAGUE_WHITELIST]);
  });

  it('accepts an empty list, meaning no filter', () => {
    expect(validateEnabledLeagues([])).toEqual([]);
  });

  it('rejects anything outside the whitelist with 400', () => {
    for (const bad of [['EPL'], ['NFL', 'CFL'], ['nfl'], [42], [null], ['']]) {
      const error = expectApiErrorSync(() => validateEnabledLeagues(bad));
      expect(error.status).toBe(400);
    }
  });

  it('rejects a non-array', () => {
    for (const bad of ['NFL', null, undefined, 7, { NFL: true }]) {
      expect(expectApiErrorSync(() => validateEnabledLeagues(bad)).status).toBe(400);
    }
  });

  it('names what was rejected and what is allowed', () => {
    const error = expectApiErrorSync(() => validateEnabledLeagues(['EPL']));
    expect(error.message).toContain('EPL');
    expect(error.details).toMatchObject({ allowed: [...LEAGUE_WHITELIST] });
  });

  it('de-duplicates and canonicalises order', () => {
    // ["NBA","NFL"] and ["NFL","NBA"] are the same configuration; storing them
    // differently would read as a change in an audit diff.
    expect(validateEnabledLeagues(['NBA', 'NFL', 'NBA'])).toEqual(['NFL', 'NBA']);
    expect(validateEnabledLeagues(['NFL', 'NBA'])).toEqual(validateEnabledLeagues(['NBA', 'NFL']));
  });

  it('rejects a list longer than the whitelist', () => {
    const tooMany = [...LEAGUE_WHITELIST, 'NFL', 'NBA'];
    expect(expectApiErrorSync(() => validateEnabledLeagues(tooMany)).status).toBe(400);
  });

  it('narrows correctly', () => {
    expect(isLeague('NFL')).toBe(true);
    expect(isLeague('EPL')).toBe(false);
  });
});

function expectApiErrorSync(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected a rejection, but it returned');
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination parsing', () => {
  it('defaults when absent', () => {
    expect(validateLimit(null, PLAYER_LIMIT_DEFAULT, PLAYER_LIMIT_MAX)).toBe(50);
    expect(validateOffset(null)).toBe(0);
  });

  it('clamps an over-large limit rather than rejecting it', () => {
    expect(validateLimit('9999', PLAYER_LIMIT_DEFAULT, PLAYER_LIMIT_MAX)).toBe(PLAYER_LIMIT_MAX);
  });

  it('rejects values that are not whole numbers', () => {
    for (const bad of ['-1', '1.5', 'abc', '50abc', '1e3', ' ']) {
      expect(expectApiErrorSync(() => validateLimit(bad, 50, 200)).status).toBe(400);
    }
  });

  it('rejects a zero limit', () => {
    expect(expectApiErrorSync(() => validateLimit('0', 50, 200)).status).toBe(400);
  });

  it('accepts an offset of zero and beyond', () => {
    expect(validateOffset('0')).toBe(0);
    expect(validateOffset('250')).toBe(250);
  });

  it('treats an absent optional uuid as no filter, and a malformed one as 400', () => {
    expect(validateOptionalUuid('gameId', null)).toBeUndefined();
    expect(validateOptionalUuid('gameId', '')).toBeUndefined();
    expect(validateOptionalUuid('gameId', VENUE_A)).toBe(VENUE_A);
    expect(expectApiErrorSync(() => validateOptionalUuid('gameId', 'nope')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Venue config
// ---------------------------------------------------------------------------

describe('setVenueConfig', () => {
  it('writes the leagues as a jsonb array scoped to the venue', async () => {
    let captured: { sql: string; params: readonly unknown[] } | null = null;
    const db: SqlExecutor = {
      query: async <T,>(sql: string, params?: readonly unknown[]) => {
        captured = { sql, params: params ?? [] };
        return result([{ id: VENUE_A, enabled_leagues: ['NFL'] }]) as SqlResult<T>;
      },
    };

    const config = await setVenueConfig(VENUE_A, ['NFL'], { db });

    expect(config).toEqual({ venueId: VENUE_A, enabledLeagues: ['NFL'] });
    expect(captured!.sql).toContain('WHERE id = $1::uuid');
    expect(captured!.params[0]).toBe(VENUE_A);
    expect(captured!.params[1]).toBe('["NFL"]');
  });

  it('returns 404 for a venue that does not exist', async () => {
    const db: SqlExecutor = { query: async <T,>() => result([]) as SqlResult<T> };
    await expectApiError(setVenueConfig(VENUE_A, ['NFL'], { db }), 404);
  });
});

// ---------------------------------------------------------------------------
// Player list
// ---------------------------------------------------------------------------

describe('listPlayers', () => {
  it('aggregates from picks rather than from a leaderboard snapshot', async () => {
    // A snapshot is period-scoped and may not exist yet; joining it would
    // report 0 for everyone at a venue whose leaderboard has not been built.
    let captured = '';
    const db: SqlExecutor = {
      query: async <T,>(sql: string) => {
        captured = sql;
        return result([]) as SqlResult<T>;
      },
    };

    await listPlayers(VENUE_A, 50, 0, { db });

    expect(captured).toContain('FROM picks p');
    expect(captured).not.toContain('leaderboard_snapshot');
  });

  it('aggregates per page with a lateral join, not over the whole table', async () => {
    let captured = '';
    const db: SqlExecutor = {
      query: async <T,>(sql: string) => {
        captured = sql;
        return result([]) as SqlResult<T>;
      },
    };

    await listPlayers(VENUE_A, 50, 0, { db });

    expect(captured).toContain('LEFT JOIN LATERAL');
    expect(captured).toContain('ORDER BY ps.last_seen_at DESC');
    expect(captured).toContain('LIMIT $2::int OFFSET $3::int');
  });

  it('maps rows to the documented shape', async () => {
    const db: SqlExecutor = {
      query: async <T,>() =>
        result([
          {
            id: '33333333-3333-3333-3333-333333333333',
            nickname: 'Chris',
            created_at: new Date('2025-01-19T09:00:00Z'),
            last_seen_at: new Date('2025-01-19T12:00:00Z'),
            total_picks: 7,
            total_points: 40,
          },
        ]) as SqlResult<T>,
    };

    const players = await listPlayers(VENUE_A, 50, 0, { db });

    expect(players).toEqual([
      {
        playerId: '33333333-3333-3333-3333-333333333333',
        nickname: 'Chris',
        createdAt: '2025-01-19T09:00:00.000Z',
        lastSeenAt: '2025-01-19T12:00:00.000Z',
        totalPicks: 7,
        totalPoints: 40,
      },
    ]);
  });

  it('never selects the session token', async () => {
    const db: SqlExecutor = {
      query: async <T,>(sql: string) => {
        expect(sql).not.toContain('session_token');
        return result([]) as SqlResult<T>;
      },
    };
    await listPlayers(VENUE_A, 50, 0, { db });
  });
});

// ---------------------------------------------------------------------------
// Picks inspector
// ---------------------------------------------------------------------------

describe('listPicks', () => {
  async function capture(filters: Parameters<typeof listPicks>[1]) {
    let captured: { sql: string; params: readonly unknown[] } = { sql: '', params: [] };
    const db: SqlExecutor = {
      query: async <T,>(sql: string, params?: readonly unknown[]) => {
        captured = { sql, params: params ?? [] };
        return result([]) as SqlResult<T>;
      },
    };
    await listPicks(VENUE_A, filters, { db });
    return captured;
  }

  it('filters pending by graded_at, not by points', async () => {
    // A voided pick has NULL points but is finished. Using points IS NULL would
    // report every voided pick as pending -- the exact misreading this endpoint
    // exists to prevent.
    const captured = await capture({ status: 'pending' });
    expect(captured.sql).toContain('p.graded_at IS NULL');
    expect(captured.sql).not.toContain('p.points IS NULL');
  });

  it('separates graded from voided', async () => {
    const graded = await capture({ status: 'graded' });
    expect(graded.sql).toContain('p.graded_at IS NOT NULL AND p.correct IS NOT NULL');

    const voided = await capture({ status: 'voided' });
    expect(voided.sql).toContain('p.graded_at IS NOT NULL AND p.correct IS NULL');
  });

  it('applies no status predicate when unfiltered', async () => {
    const captured = await capture({});
    expect(captured.sql).not.toContain('graded_at IS NULL');
    expect(captured.sql).not.toContain('graded_at IS NOT NULL');
  });

  it('binds optional filters as parameters with a NULL sentinel', async () => {
    const gameId = trustedUuid('aaaaaaaa-0000-0000-0000-000000000001');
    const captured = await capture({ gameId });

    expect(captured.sql).toContain('($2::uuid IS NULL OR p.game_id = $2::uuid)');
    expect(captured.params[1]).toBe(gameId);
    expect(captured.params[2]).toBeNull();
    // No caller value is ever concatenated into the statement.
    expect(captured.sql).not.toContain(gameId);
  });

  it('always scopes to the venue and caps the result set', async () => {
    const captured = await capture({});
    expect(captured.sql).toContain('p.venue_id = $1::uuid');
    expect(captured.params[0]).toBe(VENUE_A);
    expect(captured.params[3]).toBe(PICK_INSPECTOR_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

describe('auditLog', () => {
  it('inserts the action, venue and details', async () => {
    let captured: readonly unknown[] = [];
    const db: SqlExecutor = {
      query: async <T,>(_sql: string, params?: readonly unknown[]) => {
        captured = params ?? [];
        return result([{ id: 'x' }]) as SqlResult<T>;
      },
    };

    await auditLog(AUDIT_ACTIONS.venueConfigUpdated, undefined, VENUE_A, { after: ['NFL'] }, { db });

    expect(captured[0]).toBe('venue.config.updated');
    expect(captured[1]).toBeNull();
    expect(captured[2]).toBe(VENUE_A);
    expect(JSON.parse(String(captured[3]))).toEqual({ after: ['NFL'] });
  });

  it('redacts credential-shaped keys before they are persisted', async () => {
    let captured: readonly unknown[] = [];
    const db: SqlExecutor = {
      query: async <T,>(_sql: string, params?: readonly unknown[]) => {
        captured = params ?? [];
        return result([{ id: 'x' }]) as SqlResult<T>;
      },
    };

    await auditLog(
      'test',
      undefined,
      VENUE_A,
      {
        displayKey: 'super-secret-value',
        nested: { api_key: 'another-secret', safe: 'kept' },
      },
      { db },
    );

    const details = String(captured[3]);
    expect(details).not.toContain('super-secret-value');
    expect(details).not.toContain('another-secret');
    expect(details).toContain('kept');
  });

  it('never throws when the insert fails', async () => {
    // The action already happened; reporting it as failed would invite the
    // operator to repeat it.
    const db: SqlExecutor = {
      query: async () => {
        throw new Error('relation "audit_logs" does not exist');
      },
    };

    await expect(
      auditLog('test', undefined, VENUE_A, {}, { db, logger: silent }),
    ).resolves.toBeUndefined();
  });

  it('reports a failed write at error level', async () => {
    const lines: string[] = [];
    const capturing = createLogger({ level: 'error', sink: (line) => lines.push(line) });
    const db: SqlExecutor = {
      query: async () => {
        throw new Error('db down');
      },
    };

    await auditLog('test', undefined, VENUE_A, {}, { db, logger: capturing });

    expect(lines.some((line) => line.includes('failed to write audit log'))).toBe(true);
  });
});

describe('redactSensitive', () => {
  it('shares the logger rule so the two cannot drift', () => {
    const redacted = redactSensitive({
      apiKey: 'secret',
      token: 'secret',
      password: 'secret',
      nickname: 'Chris',
    }) as Record<string, unknown>;

    expect(redacted['apiKey']).toBe('[REDACTED]');
    expect(redacted['token']).toBe('[REDACTED]');
    expect(redacted['password']).toBe('[REDACTED]');
    expect(redacted['nickname']).toBe('Chris');
  });
});

// ---------------------------------------------------------------------------
// Against real PostgreSQL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('admin against real PostgreSQL', () => {
  let db: typeof DbNamespace;
  let admin: typeof AdminNamespace;
  let audit: typeof AuditNamespace;
  let players: typeof PlayersNamespace;
  let venueId: UUID;
  let otherVenueId: UUID;

  const PREFIX = 'admin-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.com';
    db = await import('../src/lib/db');
    admin = await import('../src/services/admin');
    audit = await import('../src/lib/audit');
    players = await import('../src/services/players');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  });

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}`, hashToken(`k-${name}-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  beforeEach(async () => {
    await cleanup();
    venueId = await seedVenue('primary');
    otherVenueId = await seedVenue('other');
  });

  it('defaults a new venue to an empty league list', async () => {
    const config = await admin.getVenueConfig(venueId, { db: db.sql });
    expect(config.enabledLeagues).toEqual([]);
  });

  it('round-trips enabled leagues through jsonb', async () => {
    const saved = await admin.setVenueConfig(venueId, ['NFL', 'NBA'], { db: db.sql });
    expect(saved.enabledLeagues).toEqual(['NFL', 'NBA']);

    const read = await admin.getVenueConfig(venueId, { db: db.sql });
    expect(read.enabledLeagues).toEqual(['NFL', 'NBA']);
  });

  it('replaces rather than merges on a second write', async () => {
    await admin.setVenueConfig(venueId, ['NFL', 'NBA'], { db: db.sql });
    const second = await admin.setVenueConfig(venueId, ['MLB'], { db: db.sql });
    expect(second.enabledLeagues).toEqual(['MLB']);
  });

  it('rejects a non-array written directly to the column', async () => {
    // The CHECK is the last line of defence if a future caller bypasses the
    // validator.
    await expect(
      db.query("UPDATE venues SET enabled_leagues = '{\"nfl\":true}'::jsonb WHERE id = $1", [
        venueId,
      ]),
    ).rejects.toThrow(/venues_enabled_leagues_is_array|violates check constraint/i);
  });

  it('keeps configuration per venue', async () => {
    await admin.setVenueConfig(venueId, ['NFL'], { db: db.sql });
    expect((await admin.getVenueConfig(otherVenueId, { db: db.sql })).enabledLeagues).toEqual([]);
  });

  it('lists players newest-seen first with pick totals', async () => {
    const gameId = await seedGame('lp-1');
    const older = await players.createPlayerSession({ venueId, nickname: 'Older' });
    await players.createPlayerSession({ venueId, nickname: 'Newer' });

    await db.query("UPDATE player_sessions SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
      older.playerId,
    ]);
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at)
       VALUES ($1,$2,$3,'home',TRUE,10,NOW())`,
      [venueId, gameId, older.playerId],
    );

    const listed = await admin.listPlayers(venueId, 50, 0, { db: db.sql });

    expect(listed.map((player) => player.nickname)).toEqual(['Newer', 'Older']);
    expect(listed[1]).toMatchObject({ nickname: 'Older', totalPicks: 1, totalPoints: 10 });
    expect(listed[0]).toMatchObject({ nickname: 'Newer', totalPicks: 0, totalPoints: 0 });
  });

  it('paginates without overlap or gaps', async () => {
    for (let index = 0; index < 5; index += 1) {
      await players.createPlayerSession({ venueId, nickname: `P${index}` });
    }

    const first = await admin.listPlayers(venueId, 2, 0, { db: db.sql });
    const second = await admin.listPlayers(venueId, 2, 2, { db: db.sql });
    const third = await admin.listPlayers(venueId, 2, 4, { db: db.sql });

    const ids = [...first, ...second, ...third].map((player) => player.playerId);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('includes expired sessions, which the app path hides', async () => {
    const session = await players.createPlayerSession({ venueId, nickname: 'Gone' });
    await db.query('UPDATE player_sessions SET expired = TRUE WHERE id = $1', [session.playerId]);

    const listed = await admin.listPlayers(venueId, 50, 0, { db: db.sql });
    expect(listed.map((player) => player.nickname)).toContain('Gone');
  });

  it('never returns another venue\'s players', async () => {
    await players.createPlayerSession({ venueId, nickname: 'Mine' });
    await players.createPlayerSession({ venueId: otherVenueId, nickname: 'Theirs' });

    const listed = await admin.listPlayers(venueId, 50, 0, { db: db.sql });
    expect(listed.map((player) => player.nickname)).toEqual(['Mine']);
  });

  async function seedGame(externalId: string, venue: UUID = venueId): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at)
       VALUES ($1,$2,'NFL','American Football','Bears','Packers', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [venue, externalId],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  it('separates pending, graded and voided picks correctly', async () => {
    const gameId = await seedGame('insp-1');
    const pending = await players.createPlayerSession({ venueId, nickname: 'Pending' });
    const graded = await players.createPlayerSession({ venueId, nickname: 'Graded' });
    const voided = await players.createPlayerSession({ venueId, nickname: 'Voided' });

    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
       VALUES ($1,$2,$3,'home')`,
      [venueId, gameId, pending.playerId],
    );
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at)
       VALUES ($1,$2,$3,'home',TRUE,10,NOW())`,
      [venueId, gameId, graded.playerId],
    );
    // Cancelled game: settled, but neither a win nor a loss.
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at)
       VALUES ($1,$2,$3,'away',NULL,NULL,NOW())`,
      [venueId, gameId, voided.playerId],
    );

    const byStatus = async (status: 'pending' | 'graded' | 'voided' | 'all') =>
      (await admin.listPicks(venueId, { status }, { db: db.sql })).map((pick) => pick.nickname);

    expect(await byStatus('pending')).toEqual(['Pending']);
    expect(await byStatus('graded')).toEqual(['Graded']);
    expect(await byStatus('voided')).toEqual(['Voided']);
    expect((await byStatus('all')).sort()).toEqual(['Graded', 'Pending', 'Voided']);
  });

  it('filters by game and by player', async () => {
    const gameOne = await seedGame('f-1');
    const gameTwo = await seedGame('f-2');
    const alice = await players.createPlayerSession({ venueId, nickname: 'Alice' });
    const bob = await players.createPlayerSession({ venueId, nickname: 'Bob' });

    for (const [game, player] of [
      [gameOne, alice.playerId],
      [gameOne, bob.playerId],
      [gameTwo, alice.playerId],
    ] as const) {
      await db.query(
        `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
         VALUES ($1,$2,$3,'home')`,
        [venueId, game, player],
      );
    }

    const byGame = await admin.listPicks(venueId, { gameId: gameOne }, { db: db.sql });
    expect(byGame.map((pick) => pick.nickname).sort()).toEqual(['Alice', 'Bob']);

    const byPlayer = await admin.listPicks(
      venueId,
      { playerId: trustedUuid(alice.playerId) },
      { db: db.sql },
    );
    expect(byPlayer).toHaveLength(2);

    const both = await admin.listPicks(
      venueId,
      { gameId: gameTwo, playerId: trustedUuid(alice.playerId) },
      { db: db.sql },
    );
    expect(both).toHaveLength(1);
  });

  it('never returns another venue\'s picks', async () => {
    const mine = await seedGame('iso-1');
    const theirs = await seedGame('iso-2', otherVenueId);
    const minePlayer = await players.createPlayerSession({ venueId, nickname: 'Mine' });
    const theirPlayer = await players.createPlayerSession({
      venueId: otherVenueId,
      nickname: 'Theirs',
    });

    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
       VALUES ($1,$2,$3,'home')`,
      [venueId, mine, minePlayer.playerId],
    );
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner)
       VALUES ($1,$2,$3,'home')`,
      [otherVenueId, theirs, theirPlayer.playerId],
    );

    const listed = await admin.listPicks(venueId, {}, { db: db.sql });
    expect(listed.map((pick) => pick.nickname)).toEqual(['Mine']);

    // Even naming the other venue's game explicitly returns nothing.
    expect(await admin.listPicks(venueId, { gameId: theirs }, { db: db.sql })).toEqual([]);
  });

  it('writes and reads an audit trail', async () => {
    await audit.auditLog('venue.config.updated', undefined, venueId, { after: ['NFL'] }, {
      db: db.sql,
    });
    await audit.auditLog('device.paired', 'admin@example.test', venueId, { deviceId: 'd1' }, {
      db: db.sql,
    });

    const entries = await audit.readAuditLog(venueId, 10, { db: db.sql });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.action)).toContain('venue.config.updated');
    const paired = entries.find((entry) => entry.action === 'device.paired');
    expect(paired?.userId).toBe('admin@example.test');
    expect(paired?.details).toEqual({ deviceId: 'd1' });
  });

  it('keeps audit entries scoped per venue', async () => {
    await audit.auditLog('venue.config.updated', undefined, venueId, {}, { db: db.sql });
    expect(await audit.readAuditLog(otherVenueId, 10, { db: db.sql })).toEqual([]);
  });

  it('rejects an audit row whose details are not an object', async () => {
    await expect(
      db.query(
        `INSERT INTO audit_logs (action, venue_id, details) VALUES ('x', $1, '["a"]'::jsonb)`,
        [venueId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it('cascades audit entries when the venue is deleted', async () => {
    await audit.auditLog('venue.config.updated', undefined, venueId, {}, { db: db.sql });
    await db.query('DELETE FROM venues WHERE id = $1', [venueId]);

    const remaining = await db.query('SELECT id FROM audit_logs WHERE venue_id = $1', [venueId]);
    expect(remaining.rowCount).toBe(0);
  });
});
