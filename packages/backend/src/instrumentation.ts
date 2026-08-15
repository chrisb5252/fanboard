/**
 * Next.js server-startup hook. `register()` is invoked once per server process,
 * before the first request is handled.
 *
 * This is where background workers belong — NOT in app/layout.tsx. A root
 * layout is a React component: it is evaluated during static prerendering at
 * `next build` (which would start a worker on a CI runner that has no database)
 * and again per request in a running server. `register()` runs exactly once, on
 * a real server, which is the property a scheduler needs.
 */
export async function register(): Promise<void> {
  // Skip the edge runtime: pg, redis and node:crypto are Node-only.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') {
    return;
  }

  // Opt-out for environments that run the app without background work
  // (integration tests, a read-only replica, a one-off container).
  //
  // This used to `return`, which also skipped the block below and silently
  // took realtime down with it. They are unrelated concerns — a web-only
  // instance that runs no workers still serves sockets — and the coupling was
  // invisible, because the symptom is a WebSocket that refuses to upgrade
  // while every log line looks healthy.
  if (process.env['WORKERS_ENABLED'] === 'false') {
    const { logger } = await import('./lib/logger');
    logger.info('workers disabled by WORKERS_ENABLED=false');
  } else {
    // Dynamic import keeps the worker graph — and its Node-only dependencies —
    // out of any bundle that is not the Node server.
    const { startWorkers } = await import('./lib/worker-scheduler');
    startWorkers();
  }

  /*
   * The realtime layer, in the same process as the API. See websocket.ts for
   * why there are two modes and server.mjs for why the attached one exists.
   */
  if (process.env['WS_ENABLED'] !== 'false') {
    const { attachWebSocketServer, startWebSocketServer } = await import('./lib/websocket');

    // Two modes, and the choice follows how the process was started rather
    // than a preference.
    //
    // `npm start` runs server.mjs, which owns one listener on $PORT and
    // forwards upgrades to the handler registered here. Attaching is the only
    // arrangement that works on a platform publishing a single port per
    // service, and it keeps `/ws` same-origin with `/api`, which the httpOnly
    // session cookie depends on.
    //
    // `npm run dev` runs `next dev`, which owns its own listener and offers no
    // way in. There the realtime layer binds WS_PORT (3100) and the Vite dev
    // proxies point at it — which is exactly what their defaults already do.
    // Deriving this from the mode rather than an env var is deliberate: an
    // inline `WS_STANDALONE_PORT=true next dev` in an npm script is a POSIX-ism
    // that fails on Windows, where npm runs scripts through cmd.exe.
    //
    // WS_STANDALONE_PORT forces either mode for a production deployment fronted
    // by a proxy that routes /ws to a second port.
    const forced = process.env['WS_STANDALONE_PORT'];
    const standalone =
      forced === 'true' || (forced !== 'false' && process.env['NODE_ENV'] !== 'production');

    if (standalone) {
      startWebSocketServer();
    } else {
      attachWebSocketServer();
    }
  }
}
