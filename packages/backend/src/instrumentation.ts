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
  if (process.env['WORKERS_ENABLED'] === 'false') {
    const { logger } = await import('./lib/logger');
    logger.info('workers disabled by WORKERS_ENABLED=false');
    return;
  }

  // Dynamic import keeps the worker graph — and its Node-only dependencies —
  // out of any bundle that is not the Node server.
  const { startWorkers } = await import('./lib/worker-scheduler');
  startWorkers();
}
