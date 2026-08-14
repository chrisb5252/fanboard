import { Pool } from 'pg';
import { getEnv } from './env';

/**
 * Single shared connection pool.
 *
 * Cached on globalThis rather than in module scope so Next.js hot reloading in
 * development replaces the module without leaking a pool per edit.
 */
const globalForDb = globalThis as unknown as { fanboardPool?: Pool };

export function getPool(): Pool {
  const existing = globalForDb.fanboardPool;
  if (existing !== undefined) {
    return existing;
  }

  const pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'fanboard-backend',
  });

  // An idle client erroring out (network blip, server restart) is emitted on
  // the pool. Without a listener this would crash the process.
  pool.on('error', (error) => {
    console.error('[db] idle client error', error);
  });

  globalForDb.fanboardPool = pool;
  return pool;
}

/** Liveness probe used by health checks and infrastructure smoke tests. */
export async function pingDatabase(): Promise<boolean> {
  const result = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

/** Closes the pool. Intended for job/script teardown, not for request handlers. */
export async function closePool(): Promise<void> {
  const pool = globalForDb.fanboardPool;
  if (pool !== undefined) {
    globalForDb.fanboardPool = undefined;
    await pool.end();
  }
}
