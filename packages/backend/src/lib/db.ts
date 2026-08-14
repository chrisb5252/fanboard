import { Pool } from 'pg';
import { getEnv } from './env';
import { probe, type HealthStatus } from './health';
import { logger } from './logger';

export type SqlRow = Record<string, unknown>;

export interface SqlResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
}

/**
 * Narrow query surface shared by the pool and by a transaction client.
 *
 * Callers (workers in particular) depend on this rather than on `Pool` or
 * `PoolClient`, which keeps pg out of their test setup entirely.
 */
export interface SqlExecutor {
  query<T = SqlRow>(text: string, params?: readonly unknown[]): Promise<SqlResult<T>>;
}

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
    logger.error('postgres idle client error', { component: 'db', error });
  });

  globalForDb.fanboardPool = pool;
  return pool;
}

/**
 * Runs a single statement on the pool. The generic names the row shape; it is
 * an assertion about the SQL, not something TypeScript can verify.
 */
export async function query<T = SqlRow>(
  text: string,
  params?: readonly unknown[],
): Promise<SqlResult<T>> {
  const result = await getPool().query(text, params as unknown[]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * Runs `work` inside BEGIN/COMMIT on a dedicated client, rolling back on any
 * throw. The client is always released, including when the rollback itself
 * fails — a leaked client would silently shrink the pool until it deadlocks.
 */
export async function withTransaction<T>(
  work: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  const tx: SqlExecutor = {
    query: async <R = SqlRow>(text: string, params?: readonly unknown[]) => {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
    },
  };

  try {
    await client.query('BEGIN');
    const value = await work(tx);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('postgres rollback failed', { component: 'db', error: rollbackError });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Liveness probe used by health checks and infrastructure smoke tests. */
export async function pingDatabase(): Promise<boolean> {
  const result = await query<{ ok: number }>('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

export function checkDatabaseHealth(): Promise<HealthStatus> {
  return probe('postgres', pingDatabase);
}

/** Closes the pool. Intended for job/script teardown, not for request handlers. */
export async function closePool(): Promise<void> {
  const pool = globalForDb.fanboardPool;
  if (pool !== undefined) {
    globalForDb.fanboardPool = undefined;
    await pool.end();
  }
}
