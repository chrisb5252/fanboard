import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseCookieHeader, SESSION_COOKIE_NAME } from './auth';
import type { SqlExecutor } from './db';
import { sql as defaultSql } from './db';
import { logger as rootLogger, type Logger } from './logger';
import { getRedis } from './redis';
import { REALTIME_CHANNEL, isRealtimeEvent, type RealtimeEvent } from './realtime';
import { hashToken } from './tokens';

/**
 * Realtime fan-out.
 *
 * ## Two ways to run
 *
 * Next's App Router does not expose its HTTP server, so there is no hook to
 * attach an upgrade handler to the listener `next start` owns. Hence two modes:
 *
 *  - `attachWebSocketServer()` — no port of its own. `server.mjs` owns one HTTP
 *    server on $PORT and forwards upgrades here. This is production.
 *  - `startWebSocketServer()` — binds its own port. Used by tests, and by
 *    deployments fronted by a proxy that can route `/ws` to a second port.
 *
 * The separate-port mode came first and turned out to be unshippable on the
 * platforms this actually runs on: Railway, Cloud Run and Heroku each publish
 * exactly one port per service, so the second listener was simply unreachable
 * and realtime silently degraded to polling. The custom server exists to fix
 * that, and it dodges the TypeScript problem — a plain-JS server cannot import
 * this module, so `instrumentation.ts` (which Next compiles) registers the
 * handler on globalThis and the server reads it from there.
 *
 * Sharing the API's origin is also what keeps the patron's httpOnly session
 * cookie working: it rides the handshake only because it is same-origin.
 *
 * ## Why Redis, not just an in-memory map
 *
 * Rooms held only in this process work until there are two processes. A worker
 * tick on instance A would broadcast to A's clients and silently skip B's. So
 * publishers write to Redis and every instance fans out to its own local
 * sockets. One instance or ten, a venue sees the same events.
 */

export const DEFAULT_WS_PORT = 3100;

/** How often to ping. A socket that misses two rounds is dropped. */
const HEARTBEAT_MS = 30_000;

export interface ClientContext {
  venueId: string;
  kind: 'player' | 'device';
  /** Player session id or device id — logged, never broadcast. */
  subjectId: string;
}

interface TrackedClient extends ClientContext {
  socket: WebSocket;
  alive: boolean;
}

export interface WebSocketDeps {
  db: SqlExecutor;
  logger: Logger;
  port: number;
}

interface ServerState {
  wss: WebSocketServer;
  /** null when attached to someone else's HTTP server rather than owning one. */
  http: Server | null;
  rooms: Map<string, Set<TrackedClient>>;
  heartbeat: ReturnType<typeof setInterval>;
  subscriber: ReturnType<typeof getRedis> | null;
}

/**
 * `fanboardWsUpgrade` is read by `server.mjs`, which is plain JavaScript and
 * cannot import this module. Publishing the handler on globalThis is what lets
 * a custom server share one port with the API without a second build step:
 * Next compiles `instrumentation.ts`, that registers the handler here, and the
 * custom server just forwards `upgrade` events to whatever it finds.
 */
const globalForWs = globalThis as unknown as {
  fanboardWs?: ServerState;
  fanboardWsUpgrade?: UpgradeHandler;
};

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

function resolvePort(): number {
  const raw = process.env['WS_PORT'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WS_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WS_PORT;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Resolves a connection to a venue, or null to refuse the upgrade.
 *
 * Two credentials, deliberately handled differently:
 *
 *  - **Patrons** authenticate with the session cookie, which the browser sends
 *    on the WebSocket handshake automatically. No query parameter is involved,
 *    so the token never reaches a URL.
 *
 *  - **Displays** have no cookie, so the display key arrives as a query
 *    parameter. That is a real downgrade: query strings are written to proxy
 *    and server access logs, unlike the header the Fire TV uses over HTTP. The
 *    browser WebSocket API cannot set headers, so the alternatives are a
 *    handshake-then-authenticate dance or this. It is flagged in the README;
 *    treat display keys in WS URLs as logged.
 */
export async function authenticateUpgrade(
  request: IncomingMessage,
  db: SqlExecutor,
): Promise<ClientContext | null> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  const cookieToken = parseCookieHeader(request.headers.cookie ?? null).get(SESSION_COOKIE_NAME);
  if (cookieToken !== undefined && cookieToken !== '') {
    const result = await db.query<{ id: string; venue_id: string }>(
      `SELECT id, venue_id
         FROM player_sessions
        WHERE session_token = $1
          AND expired = FALSE
          AND expires_at > NOW()`,
      [hashToken(cookieToken)],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return { venueId: row.venue_id, kind: 'player', subjectId: row.id };
    }
    return null;
  }

  const displayKey = url.searchParams.get('display_key');
  if (displayKey !== null && displayKey.trim() !== '') {
    const result = await db.query<{ id: string; venue_id: string }>(
      'SELECT id, venue_id FROM devices WHERE display_key = $1',
      [hashToken(displayKey.trim())],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return { venueId: row.venue_id, kind: 'device', subjectId: row.id };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function join(state: ServerState, client: TrackedClient): void {
  const room = state.rooms.get(client.venueId) ?? new Set<TrackedClient>();
  room.add(client);
  state.rooms.set(client.venueId, room);
}

function leave(state: ServerState, client: TrackedClient): void {
  const room = state.rooms.get(client.venueId);
  if (room === undefined) {
    return;
  }
  room.delete(client);
  if (room.size === 0) {
    // Drop the empty set rather than leaving a key per venue ever seen.
    state.rooms.delete(client.venueId);
  }
}

/**
 * Delivers to one venue's sockets and no others.
 *
 * Venue isolation is enforced here by construction: a socket is only ever in
 * the room its credential resolved to, and this is the only path that writes to
 * a socket. There is no broadcast-to-all.
 */
export function deliver(event: RealtimeEvent, state?: ServerState): number {
  const active = state ?? globalForWs.fanboardWs;
  if (active === undefined) {
    return 0;
  }

  const room = active.rooms.get(event.venueId);
  if (room === undefined || room.size === 0) {
    return 0;
  }

  const payload = JSON.stringify(event);
  let delivered = 0;
  for (const client of room) {
    // 1 === OPEN. Writing to a closing socket throws.
    if (client.socket.readyState === 1) {
      client.socket.send(payload);
      delivered += 1;
    }
  }
  return delivered;
}

export function roomSize(venueId: string): number {
  return globalForWs.fanboardWs?.rooms.get(venueId)?.size ?? 0;
}

export function connectionCount(): number {
  const state = globalForWs.fanboardWs;
  if (state === undefined) {
    return 0;
  }
  let total = 0;
  for (const room of state.rooms.values()) {
    total += room.size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Brings up the realtime layer without binding a port, and returns the upgrade
 * handler for an HTTP server someone else owns.
 *
 * This is the path used in production. `server.mjs` creates one HTTP server on
 * $PORT, hands ordinary requests to Next and upgrades to this — so `/ws` and
 * `/api` share an origin and a port. That matters beyond tidiness: platforms
 * like Railway, Cloud Run and Heroku publish exactly one port per service, so
 * a second listener is simply unreachable there. It also keeps the patron's
 * httpOnly cookie working, since it only rides the handshake same-origin.
 */
export function attachWebSocketServer(deps?: Partial<WebSocketDeps>): UpgradeHandler | null {
  if (globalForWs.fanboardWs !== undefined) {
    return globalForWs.fanboardWsUpgrade ?? null;
  }

  const handler = createServerState({ ...deps, http: null });
  globalForWs.fanboardWsUpgrade = handler;
  return handler;
}

/**
 * Forwards an upgrade to the attached server. Safe to call before the realtime
 * layer is up: the socket is closed rather than left hanging.
 */
export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const handler = globalForWs.fanboardWsUpgrade;
  if (handler === undefined) {
    socket.destroy();
    return;
  }
  handler(request, socket, head);
}

/**
 * Brings up the realtime layer on its own port.
 *
 * Retained for tests, which want an isolated listener, and for deployments that
 * genuinely front the app with a reverse proxy that can route `/ws` to a second
 * port. Prefer `attachWebSocketServer` anywhere a platform publishes one port.
 */
export function startWebSocketServer(deps?: Partial<WebSocketDeps>): boolean {
  if (globalForWs.fanboardWs !== undefined) {
    return false;
  }

  const log = deps?.logger ?? rootLogger.child({ component: 'websocket' });
  const port = deps?.port ?? resolvePort();

  const http = createServer((_request, response) => {
    // The listener exists for upgrades; anything else is a misdirected request.
    response.writeHead(426, { 'Content-Type': 'text/plain' });
    response.end('Upgrade required');
  });

  const handler = createServerState({ ...deps, http });
  http.on('upgrade', handler);

  http.listen(port, () => {
    log.info('websocket server listening', { port, path: '/ws' });
  });

  return true;
}

/**
 * Shared construction for both modes. Returns the upgrade handler; the caller
 * decides whether to bind it to its own listener or hand it upward.
 */
function createServerState(
  deps: Partial<WebSocketDeps> & { http: Server | null },
): UpgradeHandler {
  const db = deps.db ?? defaultSql;
  const log = deps.logger ?? rootLogger.child({ component: 'websocket' });
  const http = deps.http;

  const wss = new WebSocketServer({ noServer: true });

  const state: ServerState = {
    wss,
    http,
    rooms: new Map(),
    heartbeat: setInterval(() => {
      for (const room of state.rooms.values()) {
        for (const client of room) {
          if (!client.alive) {
            // Missed a full round; the peer is gone even if TCP has not noticed.
            client.socket.terminate();
            continue;
          }
          client.alive = false;
          client.socket.ping();
        }
      }
    }, HEARTBEAT_MS),
    subscriber: null,
  };

  const upgrade: UpgradeHandler = (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    void (async () => {
      let context: ClientContext | null = null;
      try {
        context = await authenticateUpgrade(request, db);
      } catch (error) {
        log.error('upgrade authentication failed', { error });
      }

      if (context === null) {
        // Refuse before the handshake completes: an unauthenticated socket is
        // never in a room, so it can never be delivered to.
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const resolved = context;
      wss.handleUpgrade(request, socket, head, (websocket) => {
        const client: TrackedClient = { ...resolved, socket: websocket, alive: true };
        join(state, client);

        log.info('client connected', {
          venueId: client.venueId,
          kind: client.kind,
          roomSize: state.rooms.get(client.venueId)?.size ?? 0,
        });

        websocket.on('pong', () => {
          client.alive = true;
        });

        websocket.on('close', () => {
          leave(state, client);
          log.debug('client disconnected', {
            venueId: client.venueId,
            roomSize: state.rooms.get(client.venueId)?.size ?? 0,
          });
        });

        websocket.on('error', (error) => {
          log.warn('socket error', { venueId: client.venueId, error });
          leave(state, client);
        });

        // Tells the client which venue it landed in and, more importantly, that
        // it should load its state now. This is the reconnect contract.
        websocket.send(
          JSON.stringify({ type: 'connected', venueId: client.venueId, kind: client.kind }),
        );
      });
    })();
  };

  globalForWs.fanboardWs = state;
  if (http === null) {
    log.info('websocket attached to the API server', { path: '/ws' });
  }

  // Subscribing needs its own connection: a Redis client in subscribe mode
  // cannot run ordinary commands, so reusing the shared client would break
  // every cache read in the process.
  void (async () => {
    try {
      const subscriber = getRedis().duplicate();
      subscriber.on('error', (error) => {
        log.error('realtime subscriber error', { error });
      });
      await subscriber.connect();
      await subscriber.subscribe(REALTIME_CHANNEL, (message: string) => {
        try {
          const parsed: unknown = JSON.parse(message);
          if (isRealtimeEvent(parsed)) {
            deliver(parsed, state);
          }
        } catch (error) {
          log.warn('unparseable realtime message', { error });
        }
      });
      state.subscriber = subscriber;
      log.info('subscribed to realtime channel', { channel: REALTIME_CHANNEL });
    } catch (error) {
      // Without this the server still accepts connections and still delivers
      // anything published in-process; it just loses cross-instance events.
      log.error('could not subscribe to realtime channel', { error });
    }
  })();

  return upgrade;
}

export async function stopWebSocketServer(): Promise<void> {
  const state = globalForWs.fanboardWs;
  if (state === undefined) {
    return;
  }
  globalForWs.fanboardWs = undefined;
  globalForWs.fanboardWsUpgrade = undefined;

  clearInterval(state.heartbeat);

  for (const room of state.rooms.values()) {
    for (const client of room) {
      client.socket.close(1001, 'server shutting down');
    }
  }
  state.rooms.clear();

  if (state.subscriber !== null) {
    try {
      await state.subscriber.quit();
    } catch {
      // Already gone.
    }
  }

  await new Promise<void>((resolve) => {
    state.wss.close(() => {
      // Nothing to close when attached to a server this module does not own —
      // the custom server closes its own listener.
      if (state.http === null) {
        resolve();
        return;
      }
      state.http.close(() => {
        resolve();
      });
    });
  });
}
