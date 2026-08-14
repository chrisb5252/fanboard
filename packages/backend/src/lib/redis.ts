import { createClient } from 'redis';
import { getEnv } from './env';

function createRedisClient() {
  const client = createClient({ url: getEnv().REDIS_URL });

  // node-redis emits 'error' on every reconnect attempt; unhandled it would
  // take the process down.
  client.on('error', (error) => {
    console.error('[redis] client error', error);
  });

  return client;
}

// Inferred from the factory rather than written out: createClient() resolves
// its five generic parameters from the options object, and the defaults on the
// exported RedisClientType alias do not match what we actually construct.
type RedisClient = ReturnType<typeof createRedisClient>;

/**
 * Single shared Redis client, cached on globalThis for the same hot-reload
 * reason as the Postgres pool. Redis backs the live-score cache and the
 * leaderboard read path; nothing here is a source of truth.
 */
const globalForRedis = globalThis as unknown as { fanboardRedis?: RedisClient };

export function getRedis(): RedisClient {
  const existing = globalForRedis.fanboardRedis;
  if (existing !== undefined) {
    return existing;
  }

  const client = createRedisClient();
  globalForRedis.fanboardRedis = client;
  return client;
}

/** Returns a connected client, connecting on first use. */
export async function getConnectedRedis(): Promise<RedisClient> {
  const client = getRedis();
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

/** Liveness probe used by health checks and infrastructure smoke tests. */
export async function pingRedis(): Promise<boolean> {
  const client = await getConnectedRedis();
  return (await client.ping()) === 'PONG';
}

/** Closes the client. Intended for job/script teardown, not for request handlers. */
export async function closeRedis(): Promise<void> {
  const client = globalForRedis.fanboardRedis;
  if (client !== undefined) {
    globalForRedis.fanboardRedis = undefined;
    if (client.isOpen) {
      await client.quit();
    }
  }
}
