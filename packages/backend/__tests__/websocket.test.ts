import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { broadcast, broadcastGamesGraded, broadcastLeaderboard } from '../src/lib/leaderboard-broadcaster';
import { createLogger } from '../src/lib/logger';
import { REALTIME_CHANNEL, isRealtimeEvent } from '../src/lib/realtime';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import { lockGamesOnce } from '../src/workers/lock-games';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';
import type * as WsNamespace from '../src/lib/websocket';

const silent = createLogger({ level: 'silent' });

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Event vocabulary and the broadcaster
// ---------------------------------------------------------------------------

describe('realtime events', () => {
  it('every event names its venue, which is what makes isolation possible', () => {
    expect(isRealtimeEvent({ type: 'game_locked', venueId: 'v1' })).toBe(true);
    expect(isRealtimeEvent({ type: 'game_locked' })).toBe(false);
    expect(isRealtimeEvent({ venueId: 'v1' })).toBe(false);
    expect(isRealtimeEvent(null)).toBe(false);
  });
});

describe('broadcaster', () => {
  it('publishes through Redis rather than to local sockets', async () => {
    // Delivering in-process would work on one instance and silently drop half
    // the venue's clients on two.
    const publish = vi.fn(async () => 1);
    await broadcastGamesGraded('v1', ['g1', 'g2'], { publish, logger: silent });

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0] as unknown as [string, string];
    expect(channel).toBe(REALTIME_CHANNEL);
    expect(JSON.parse(message)).toEqual({
      type: 'games_graded',
      venueId: 'v1',
      gameIds: ['g1', 'g2'],
      leaderboardUpdated: true,
    });
  });

  it('carries the standings inline for leaderboard updates', async () => {
    const publish = vi.fn(async () => 1);
    await broadcastLeaderboard(
      'v1',
      'today',
      [{ rank: 1, playerSessionId: 'p1', nickname: 'Ada', wins: 3, losses: 1, points: 30 }],
      { publish, logger: silent },
    );

    const [, message] = publish.mock.calls[0] as unknown as [string, string];
    const parsed = JSON.parse(message) as { leaderboard: Record<string, unknown>[] };
    expect(parsed.leaderboard[0]).toEqual({
      rank: 1,
      nickname: 'Ada',
      wins: 3,
      losses: 1,
      points: 30,
    });
    // player_session_id is tenant-internal and must not ride along.
    expect(message).not.toContain('playerSessionId');
    expect(message).not.toContain('p1');
  });

  it('never throws when Redis is unavailable', async () => {
    // A broadcast rides on top of an action that already committed; failing the
    // grade because a notification did not send would be strictly worse.
    await expect(
      broadcast({ type: 'game_locked', venueId: 'v1', gameId: 'g1', scheduledAt: 'now' }, {
        publish: async () => {
          throw new Error('redis down');
        },
        logger: silent,
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lock-games
// ---------------------------------------------------------------------------

describe('lockGamesOnce', () => {
  it('announces each newly locked game once', async () => {
    const announce = vi.fn(async () => undefined);
    const db: SqlExecutor = {
      query: async <T,>() =>
        result([
          { id: 'g1', venue_id: 'v1', scheduled_at: new Date('2025-01-19T18:00:00Z') },
          { id: 'g2', venue_id: 'v2', scheduled_at: new Date('2025-01-19T19:00:00Z') },
        ]) as SqlResult<T>,
    };

    const outcome = await lockGamesOnce({
      db,
      announce,
      warmCache: async () => undefined,
      logger: silent,
    });

    expect(outcome.locked).toBe(2);
    expect(outcome.venues).toBe(2);
    expect(announce).toHaveBeenCalledWith('v1', 'g1', '2025-01-19T18:00:00.000Z');
  });

  it('claims each game exactly once, so nobody is told twice', async () => {
    let captured = '';
    const db: SqlExecutor = {
      query: async <T,>(sql: string) => {
        captured = sql;
        return result([]) as SqlResult<T>;
      },
    };

    await lockGamesOnce({ db, announce: async () => undefined, warmCache: async () => undefined, logger: silent });

    // WHERE locked_at IS NULL is what makes a second pass return nothing.
    expect(captured).toContain('locked_at IS NULL');
    expect(captured).toContain('SET locked_at = NOW()');
    expect(captured).toContain('scheduled_at <= NOW()');
  });

  it('warms the pick-path lock cache as it goes', async () => {
    const warmCache = vi.fn(async () => undefined);
    const db: SqlExecutor = {
      query: async <T,>() =>
        result([{ id: 'g1', venue_id: 'v1', scheduled_at: new Date() }]) as SqlResult<T>,
    };

    await lockGamesOnce({ db, announce: async () => undefined, warmCache, logger: silent });
    expect(warmCache).toHaveBeenCalledWith('g1', expect.any(String));
  });

  it('never throws when the announcement fails', async () => {
    const db: SqlExecutor = {
      query: async <T,>() =>
        result([{ id: 'g1', venue_id: 'v1', scheduled_at: new Date() }]) as SqlResult<T>,
    };

    const outcome = await lockGamesOnce({
      db,
      announce: async () => {
        throw new Error('redis down');
      },
      warmCache: async () => undefined,
      logger: silent,
    });

    // The lock is committed regardless of whether anyone heard about it.
    expect(outcome.locked).toBe(1);
  });

  it('never throws when the query fails', async () => {
    const outcome = await lockGamesOnce({
      db: {
        query: async () => {
          throw new Error('pool exhausted');
        },
      },
      announce: async () => undefined,
      warmCache: async () => undefined,
      logger: silent,
    });
    expect(outcome.locked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The server, over real sockets
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const WS_TEST_PORT = 3199;

describe.skipIf(TEST_DATABASE_URL === undefined)('websocket server', () => {
  let db: typeof DbNamespace;
  let players: typeof PlayersNamespace;
  let ws: typeof WsNamespace;
  let venueA: UUID;
  let venueB: UUID;

  const PREFIX = 'ws-int';

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    players = await import('../src/services/players');
    ws = await import('../src/lib/websocket');

    await db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);
    venueA = await seedVenue('a');
    venueB = await seedVenue('b');

    ws.startWebSocketServer({ db: db.sql, logger: silent, port: WS_TEST_PORT });
    await waitFor(() => true, 200);
  }, 60_000);

  afterAll(async () => {
    await ws.stopWebSocketServer();
    await db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);
    await db.closePool();
  }, 30_000);

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}`, hashToken(`k-${name}-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  function waitFor<T>(fn: () => T, ms: number): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(fn()), ms));
  }

  /** Opens a socket authenticated as a player at `venueId`. */
  async function connectPlayer(venueId: UUID, nickname: string): Promise<{
    socket: WebSocket;
    received: unknown[];
  }> {
    const session = await players.createPlayerSession({ venueId, nickname });
    const received: unknown[] = [];

    const socket = new WebSocket(`ws://localhost:${WS_TEST_PORT}/ws`, {
      headers: { cookie: `session_token=${session.sessionToken}` },
    });

    // Attached before awaiting open, not after. The server greets on upgrade,
    // so a listener added once the promise resolves has already missed it —
    // the real client assigns onmessage synchronously for the same reason.
    socket.on('message', (raw: Buffer) => {
      received.push(JSON.parse(raw.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    return { socket, received };
  }

  const open: WebSocket[] = [];
  afterEach(() => {
    for (const socket of open.splice(0)) {
      socket.close();
    }
  });

  it('accepts a valid session cookie and puts the client in its venue room', async () => {
    const client = await connectPlayer(venueA, 'Ada');
    open.push(client.socket);

    await waitFor(() => true, 100);
    expect(ws.roomSize(venueA)).toBe(1);
  }, 20_000);

  it('sends the credential in a cookie, never a query parameter', async () => {
    // A token in a URL is written to every proxy and server access log.
    const client = await connectPlayer(venueA, 'CookieOnly');
    open.push(client.socket);
    expect(client.socket.url).not.toContain('session_token');
  }, 20_000);

  it('refuses an unauthenticated upgrade', async () => {
    const socket = new WebSocket(`ws://localhost:${WS_TEST_PORT}/ws`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  }, 20_000);

  it('refuses a forged display key', async () => {
    const socket = new WebSocket(`ws://localhost:${WS_TEST_PORT}/ws?display_key=not-a-real-key`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  }, 20_000);

  it('delivers an event to every client in the room', async () => {
    const one = await connectPlayer(venueA, 'One');
    const two = await connectPlayer(venueA, 'Two');
    open.push(one.socket, two.socket);
    await waitFor(() => true, 100);

    const delivered = ws.deliver({
      type: 'game_locked',
      venueId: venueA,
      gameId: 'g1',
      scheduledAt: new Date().toISOString(),
    });

    expect(delivered).toBe(2);
    await waitFor(() => true, 150);
    expect(one.received.some((m) => (m as { type: string }).type === 'game_locked')).toBe(true);
    expect(two.received.some((m) => (m as { type: string }).type === 'game_locked')).toBe(true);
  }, 20_000);

  it('carries a broadcast through Redis to the socket well inside 2 seconds', async () => {
    // `deliver` only proves the local room works. In production nothing calls
    // it directly: a worker publishes, Redis fans out, and the subscriber in
    // each instance delivers. This exercises that whole path with no stubs,
    // which is the only version of it that would catch a channel-name or
    // subscriber-wiring mistake.
    const client = await connectPlayer(venueA, 'RoundTrip');
    open.push(client.socket);
    await waitFor(() => true, 100);

    const arrived = new Promise<number>((resolve) => {
      const startedAt = Date.now();
      client.socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === 'games_graded') {
          resolve(Date.now() - startedAt);
        }
      });
    });

    await broadcastGamesGraded(venueA, ['g-round-trip']);

    const latencyMs = await Promise.race([
      arrived,
      waitFor(() => -1, 5_000),
    ]);

    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(2_000);
  }, 20_000);

  it('does not leak a Redis-published event into another venue', async () => {
    const inA = await connectPlayer(venueA, 'PubA');
    const inB = await connectPlayer(venueB, 'PubB');
    open.push(inA.socket, inB.socket);
    await waitFor(() => true, 100);

    await broadcastLeaderboard(venueA, 'today', []);
    await waitFor(() => true, 500);

    expect(inA.received.some((m) => (m as { type: string }).type === 'leaderboard_updated')).toBe(
      true,
    );
    expect(inB.received.some((m) => (m as { type: string }).type === 'leaderboard_updated')).toBe(
      false,
    );
  }, 20_000);

  it('never leaks an event across venues', async () => {
    const inA = await connectPlayer(venueA, 'InA');
    const inB = await connectPlayer(venueB, 'InB');
    open.push(inA.socket, inB.socket);
    await waitFor(() => true, 100);

    ws.deliver({
      type: 'games_graded',
      venueId: venueA,
      gameIds: ['secret-game'],
      leaderboardUpdated: true,
    });

    await waitFor(() => true, 150);
    expect(inA.received.some((m) => (m as { type: string }).type === 'games_graded')).toBe(true);
    expect(inB.received.some((m) => (m as { type: string }).type === 'games_graded')).toBe(false);
    expect(JSON.stringify(inB.received)).not.toContain('secret-game');
  }, 20_000);

  it('removes a client from its room on disconnect', async () => {
    const client = await connectPlayer(venueA, 'Leaver');
    await waitFor(() => true, 100);
    expect(ws.roomSize(venueA)).toBe(1);

    client.socket.close();
    await waitFor(() => true, 300);
    expect(ws.roomSize(venueA)).toBe(0);
  }, 20_000);

  it('accepts a client back after a reconnect', async () => {
    const first = await connectPlayer(venueA, 'Returner');
    await waitFor(() => true, 100);
    first.socket.close();
    await waitFor(() => true, 300);

    const second = await connectPlayer(venueA, 'Returner2');
    open.push(second.socket);
    await waitFor(() => true, 100);

    expect(ws.roomSize(venueA)).toBe(1);
    // Every connection is told to reload, which is the whole no-loss contract.
    expect(second.received.some((m) => (m as { type: string }).type === 'connected')).toBe(true);
  }, 20_000);

  it('holds 100 concurrent connections in one venue', async () => {
    const clients = await Promise.all(
      Array.from({ length: 100 }, (_, i) => connectPlayer(venueA, `Load${i}`)),
    );
    for (const client of clients) {
      open.push(client.socket);
    }
    await waitFor(() => true, 400);

    expect(ws.roomSize(venueA)).toBe(100);

    const started = Date.now();
    const delivered = ws.deliver({
      type: 'leaderboard_updated',
      venueId: venueA,
      period: 'today',
      leaderboard: [],
    });
    const elapsed = Date.now() - started;

    expect(delivered).toBe(100);
    // The 2-second budget is for end-to-end delivery; the fan-out itself
    // should not be a meaningful part of it.
    expect(elapsed).toBeLessThan(2_000);

    await waitFor(() => true, 500);
    const gotIt = clients.filter((client) =>
      client.received.some((m) => (m as { type: string }).type === 'leaderboard_updated'),
    );
    expect(gotIt).toHaveLength(100);
  }, 60_000);
});
