import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../src/lib/logger';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';
import type * as WsNamespace from '../src/lib/websocket';

/**
 * The attached mode — realtime sharing a port with the API.
 *
 * This is what production runs, and until now only the standalone-port mode had
 * coverage. That asymmetry is exactly how `/ws` came to be unreachable on
 * Railway without a single test noticing: the tested path bound its own port,
 * and the deployed path did too, on a platform that publishes only one.
 *
 * The HTTP server built here stands in for `server.mjs`. It does the same two
 * things: serve ordinary requests, and forward `upgrade` events to the handler
 * the websocket module registers.
 */

const silent = createLogger({ level: 'silent' });
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PORT = 3197;
const PREFIX = 'attached-int';

describe.skipIf(TEST_DATABASE_URL === undefined)('websocket attached to a shared server', () => {
  let db: typeof DbNamespace;
  let players: typeof PlayersNamespace;
  let ws: typeof WsNamespace;
  let server: Server;
  let venueA: UUID;
  let venueB: UUID;

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
    venueA = await seedVenue('a');
    venueB = await seedVenue('b');

    // Attach first, then build the server around it — the same order
    // instrumentation.ts and server.mjs use.
    ws.attachWebSocketServer({ db: db.sql, logger: silent });

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });

    // Precisely what server.mjs does.
    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(request, socket, head);
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

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  async function connect(venueId: UUID, nickname: string): Promise<{
    socket: WebSocket;
    received: unknown[];
  }> {
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

    return { socket, received };
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('binds no port of its own', () => {
    // The whole point. A second listener is unreachable on a platform that
    // publishes one port per service.
    expect(ws.DEFAULT_WS_PORT).toBe(3100);
    return new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error('something is listening on 3100')));
      probe.listen(ws.DEFAULT_WS_PORT, () => probe.close(() => resolve()));
    });
  }, 20_000);

  it('serves ordinary HTTP on the same port', async () => {
    const response = await fetch(`http://localhost:${PORT}/anything`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  }, 20_000);

  it('upgrades /ws on that same port', async () => {
    const client = await connect(venueA, 'Attached');
    await sleep(200);

    expect((client.received[0] as { type: string }).type).toBe('connected');
    expect(ws.roomSize(venueA)).toBe(1);
    client.socket.close();
  }, 20_000);

  it('still refuses an unauthenticated upgrade', async () => {
    const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  }, 20_000);

  it('delivers a Redis-published event, and only to its own venue', async () => {
    const inA = await connect(venueA, 'SharedA');
    const inB = await connect(venueB, 'SharedB');
    await sleep(200);

    const { broadcastGamesGraded } = await import('../src/lib/leaderboard-broadcaster');
    await broadcastGamesGraded(venueA, ['g-attached']);
    await sleep(600);

    const types = (received: unknown[]): string[] =>
      received.map((m) => (m as { type: string }).type);

    expect(types(inA.received)).toContain('games_graded');
    expect(types(inB.received)).not.toContain('games_graded');

    inA.socket.close();
    inB.socket.close();
  }, 20_000);

  it('closes a non-/ws upgrade rather than hanging it', async () => {
    // server.mjs hands these to Next (Fast Refresh lives on one). The stand-in
    // here has no Next, so it destroys them — either way the socket must not
    // be left open and unattended.
    const socket = new WebSocket(`ws://localhost:${PORT}/not-ws`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', () => resolve('closed'));
    });
    expect(outcome).toBe('closed');
  }, 20_000);
});
