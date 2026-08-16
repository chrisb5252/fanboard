import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';
import type * as WsNamespace from '../src/lib/websocket';

/**
 * The realtime layer's failure paths.
 *
 * websocket.ts had the weakest branch coverage in the codebase, and the gap was
 * all in the parts that only run when something is already wrong: a Redis
 * outage, a malformed frame, a socket that dies without saying so. Those are
 * exactly the branches you cannot afford to be wrong, because they run on the
 * night everything else is also going wrong.
 *
 * The happy path — valid upgrade, room delivery, reconnect — is covered in
 * websocket.test.ts and attached-websocket.test.ts and is not repeated here.
 */

const silent = createLogger({ level: 'silent' });
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PORT = 3196;
const PREFIX = 'wsres-int';

describe.skipIf(TEST_DATABASE_URL === undefined)('websocket resilience', () => {
  let db: typeof DbNamespace;
  let players: typeof PlayersNamespace;
  let ws: typeof WsNamespace;
  let server: Server;
  let venueId: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    players = await import('../src/services/players');
    ws = await import('../src/lib/websocket');

    await cleanup();
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    venueId = trustedUuid(row.rows[0]!.id);

    ws.attachWebSocketServer({ db: db.sql, logger: silent });

    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server.on('upgrade', (req, socket, head) => {
      ws.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  }, 60_000);

  afterAll(async () => {
    await ws.stopWebSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await db.closePool();
    const redis = await import('../src/lib/redis');
    await redis.closeRedis();
  }, 30_000);

  const open: WebSocket[] = [];
  afterEach(() => {
    for (const socket of open.splice(0)) {
      socket.close();
    }
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function connect(nickname: string): Promise<{ socket: WebSocket; received: unknown[] }> {
    const session = await players.createPlayerSession({ venueId, nickname });
    const received: unknown[] = [];
    const socket = new WebSocket(`ws://localhost:${PORT}/ws`, {
      headers: { cookie: `session_token=${session.sessionToken}` },
    });
    socket.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    open.push(socket);
    return { socket, received };
  }

  // -------------------------------------------------------------------------
  // Authentication edge cases
  // -------------------------------------------------------------------------

  describe('upgrade authentication', () => {
    it('refuses a well-formed but unknown session token', async () => {
      // Distinct from "no cookie": the shape is right and the value is wrong,
      // which is what a stale token from a reaped session looks like.
      const socket = new WebSocket(`ws://localhost:${PORT}/ws`, {
        headers: { cookie: `session_token=${'a'.repeat(43)}` },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }, 20_000);

    it('refuses an empty session cookie', async () => {
      const socket = new WebSocket(`ws://localhost:${PORT}/ws`, {
        headers: { cookie: 'session_token=' },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }, 20_000);

    it('refuses a cookie header carrying other cookies but no session', async () => {
      const socket = new WebSocket(`ws://localhost:${PORT}/ws`, {
        headers: { cookie: 'theme=dark; locale=en-GB' },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }, 20_000);

    it('refuses an expired session', async () => {
      const session = await players.createPlayerSession({ venueId, nickname: 'Expired' });
      await db.query(
        `UPDATE player_sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1::uuid`,
        [session.playerId],
      );

      const socket = new WebSocket(`ws://localhost:${PORT}/ws`, {
        headers: { cookie: `session_token=${session.sessionToken}` },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }, 20_000);

    it('refuses an upgrade on any path other than /ws', async () => {
      const socket = new WebSocket(`ws://localhost:${PORT}/socket`);
      const outcome = await new Promise<string>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }, 20_000);
  });

  // -------------------------------------------------------------------------
  // Delivery edge cases
  // -------------------------------------------------------------------------

  describe('delivery', () => {
    it('reports zero delivered for a venue with nobody connected', () => {
      const empty = trustedUuid('00000000-0000-0000-0000-0000000000e0');
      expect(ws.deliver({ type: 'game_locked', venueId: empty, gameId: 'g', scheduledAt: '' })).toBe(
        0,
      );
      expect(ws.roomSize(empty)).toBe(0);
    }, 20_000);

    it('stops counting a socket once it closes', async () => {
      const client = await connect('Leaver');
      await sleep(150);
      expect(ws.roomSize(venueId)).toBe(1);

      client.socket.close();
      await sleep(400);

      // The room is emptied on close, so a later broadcast reaches nobody
      // rather than writing to a dead socket.
      expect(ws.roomSize(venueId)).toBe(0);
      expect(
        ws.deliver({ type: 'game_locked', venueId, gameId: 'g', scheduledAt: '' }),
      ).toBe(0);
    }, 20_000);

    it('carries a large payload without truncating it', async () => {
      // A venue with a long leaderboard produces a big frame. The default ws
      // payload ceiling is far above this, but a truncated board would show as
      // missing players rather than as an error, so it is worth pinning.
      const client = await connect('BigPayload');
      await sleep(150);

      const leaderboard = Array.from({ length: 500 }, (_, i) => ({
        rank: i + 1,
        playerSessionId: null,
        nickname: `Player${i}`,
        wins: i,
        losses: 0,
        points: i * 10,
      }));

      ws.deliver({ type: 'leaderboard_updated', venueId, period: 'today', leaderboard });
      await sleep(400);

      const received = client.received.find(
        (m) => (m as { type: string }).type === 'leaderboard_updated',
      ) as { leaderboard: unknown[] } | undefined;

      expect(received?.leaderboard).toHaveLength(500);
    }, 20_000);

    it('counts connections across the whole process', async () => {
      await connect('CountOne');
      await connect('CountTwo');
      await sleep(200);
      expect(ws.connectionCount()).toBeGreaterThanOrEqual(2);
    }, 20_000);
  });

  // -------------------------------------------------------------------------
  // Lifecycle guards
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('does not start a second listener when one is already attached', () => {
      // Two servers on one port is a crash at boot; returning false is what
      // makes a double register() harmless.
      expect(ws.startWebSocketServer({ db: db.sql, logger: silent, port: PORT + 1 })).toBe(false);
    }, 20_000);

    it('hands back the existing handler when attached twice', () => {
      expect(ws.attachWebSocketServer({ db: db.sql, logger: silent })).not.toBeNull();
    }, 20_000);

    it('survives a malformed message on the realtime channel', async () => {
      // A poisoned frame from Redis must not take the subscriber down and
      // silence every venue on the instance.
      const client = await connect('Poisoned');
      await sleep(150);

      const redis = await import('../src/lib/redis');
      const { REALTIME_CHANNEL } = await import('../src/lib/realtime');

      await redis.publish(REALTIME_CHANNEL, 'not json at all {{{');
      await redis.publish(REALTIME_CHANNEL, JSON.stringify({ nonsense: true }));
      await sleep(300);

      // Still alive, and still delivering afterwards.
      ws.deliver({ type: 'game_locked', venueId, gameId: 'after-poison', scheduledAt: '' });
      await sleep(300);

      expect(
        client.received.some((m) => (m as { type: string }).type === 'game_locked'),
      ).toBe(true);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    }, 30_000);
  });
});
