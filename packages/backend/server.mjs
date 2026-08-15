/**
 * FanBoard API server.
 *
 * Replaces `next start` so that the HTTP API and the WebSocket endpoint share
 * one port. Next's App Router does not hand out its HTTP server, so the only
 * way to accept an upgrade on the same listener is to own the listener.
 *
 * Why that matters: Railway, Cloud Run and Heroku publish exactly one port per
 * service. A WebSocket on a second port is unreachable there, and the failure
 * is quiet — clients retry, fall back to polling, and everything looks fine
 * while realtime is dead. It also keeps `/ws` same-origin with `/api`, which
 * the patron session cookie depends on: httpOnly cookies ride a handshake only
 * when the origin matches.
 *
 * This file is plain JavaScript on purpose. A custom server runs before any
 * TypeScript is compiled, so it cannot import `src/lib/websocket.ts`. Instead
 * `instrumentation.ts` — which Next *does* compile — publishes its upgrade
 * handler on globalThis during startup, and this forwards to it. No second
 * build step, no duplicated logic.
 */
import { createServer } from 'node:http';
import next from 'next';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const dev = process.env.NODE_ENV !== 'production';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

// Next has upgrades of its own — Fast Refresh talks over /_next/webpack-hmr.
// Without handing those back, this server would destroy them and break HMR.
// Resolved after prepare(): asking earlier throws.
const handleUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    // Next normally answers its own errors; reaching here means the handler
    // itself rejected. Answer something rather than leaving the socket open.
    console.error('[server] request handler failed', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  // Anything that is not ours belongs to Next. In development that is Fast
  // Refresh; swallowing it here would leave the editor silently disconnected.
  if (pathname !== '/ws') {
    handleUpgrade(req, socket, head).catch((error) => {
      console.error('[server] next upgrade failed', error);
      socket.destroy();
    });
    return;
  }

  // Registered by instrumentation.ts once the realtime layer is up. Absent
  // means either WS_ENABLED=false or startup has not finished; closing the
  // socket lets the client's backoff handle it, which is what it is already
  // written for.
  const upgrade = globalThis.fanboardWsUpgrade;

  if (typeof upgrade !== 'function') {
    socket.destroy();
    return;
  }

  try {
    upgrade(req, socket, head);
  } catch (error) {
    console.error('[server] websocket upgrade failed', error);
    socket.destroy();
  }
});

server.listen(port, hostname, () => {
  console.log(`[server] listening on http://${hostname}:${port} (ws on /ws)`);
});

/**
 * Shutdown.
 *
 * The worker scheduler installs its own SIGTERM handling and needs to drain an
 * in-flight grading transaction, so this closes the listener and leaves the
 * process exit to that path. Stops accepting new connections immediately while
 * letting current work finish.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received; closing listener`);
    server.close();
  });
}
