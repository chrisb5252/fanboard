import { createClient } from 'redis';
import { getEnv } from './env';
import { probe, type HealthStatus } from './health';
import { logger } from './logger';

function createRedisClient() {
  const client = createClient({ url: getEnv().REDIS_URL });

  // node-redis emits 'error' on every reconnect attempt; unhandled it would
  // take the process down.
  client.on('error', (error) => {
    logger.error('redis client error', { component: 'redis', error });
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

/** Sets `key`, optionally expiring after `ttlSeconds`. */
export async function set(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const client = await getConnectedRedis();
  if (ttlSeconds !== undefined && ttlSeconds > 0) {
    await client.set(key, value, { EX: ttlSeconds });
    return;
  }
  await client.set(key, value);
}

/** Returns the value at `key`, or null when absent. */
export async function get(key: string): Promise<string | null> {
  const client = await getConnectedRedis();
  return client.get(key);
}

/** Deletes `key`, returning the number of keys removed (0 or 1). */
export async function del(key: string): Promise<number> {
  const client = await getConnectedRedis();
  return client.del(key);
}

/**
 * Publishes to a channel, returning the number of subscribers that received it.
 *
 * Fire-and-forget by design: with no subscriber connected the message is
 * dropped, which is the correct behaviour for a live-update nudge. Anything
 * that must not be missed belongs in the database, not here.
 */
export async function publish(channel: string, message: string): Promise<number> {
  const client = await getConnectedRedis();
  return client.publish(channel, message);
}

/** Liveness probe used by health checks and infrastructure smoke tests. */
export async function pingRedis(): Promise<boolean> {
  const client = await getConnectedRedis();
  return (await client.ping()) === 'PONG';
}

export function checkRedisHealth(): Promise<HealthStatus> {
  return probe('redis', pingRedis);
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
