import { DEVICE_VENUE_TTL_SECONDS, deviceVenueKey } from './cache-keys';
import type { SqlExecutor } from './db';
import { sql as defaultSql } from './db';
import { ApiError } from './errors';
import { logger as rootLogger, type Logger } from './logger';
import { get as redisGet, set as redisSet } from './redis';
import { trustedUuid, type UUID } from './validators';

export interface DeviceLookupDeps {
  db: SqlExecutor;
  cacheGet: (key: string) => Promise<string | null>;
  cacheSet: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  logger: Logger;
}

function resolveDeps(deps?: Partial<DeviceLookupDeps>): DeviceLookupDeps {
  return {
    db: deps?.db ?? defaultSql,
    cacheGet: deps?.cacheGet ?? redisGet,
    cacheSet: deps?.cacheSet ?? redisSet,
    logger: deps?.logger ?? rootLogger.child({ component: 'device-lookup' }),
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a device to its venue, cached for an hour.
 *
 * IMPORTANT: this is a convenience lookup, not an authorisation primitive. The
 * authenticated routes deliberately use the venue id that deviceMiddleware
 * returns instead, because that value is read in the same statement that
 * verifies the display key and therefore cannot be stale. Driving an access
 * decision from an hour-old cached mapping would mean a device re-paired to a
 * different venue could keep reading its old venue's data for up to an hour.
 *
 * Use this only where the caller has already been authorised by other means.
 */
export async function getVenueIdFromDevice(
  deviceId: UUID,
  deps?: Partial<DeviceLookupDeps>,
): Promise<UUID> {
  const { db, cacheGet, cacheSet, logger } = resolveDeps(deps);
  const key = deviceVenueKey(deviceId);

  try {
    const cached = await cacheGet(key);
    // Shape-check before trusting it: a poisoned or truncated entry must not
    // become a venue id that gets interpolated into a query parameter.
    if (cached !== null && UUID_SHAPE.test(cached)) {
      return trustedUuid(cached.toLowerCase());
    }
  } catch (error) {
    logger.warn('device venue cache read failed; falling through', { deviceId, error });
  }

  const result = await db.query<{ venue_id: string }>(
    'SELECT venue_id FROM devices WHERE id = $1::uuid',
    [deviceId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Device not found');
  }

  const venueId = trustedUuid(row.venue_id);

  try {
    await cacheSet(key, venueId, DEVICE_VENUE_TTL_SECONDS);
  } catch (error) {
    logger.warn('device venue cache write failed', { deviceId, error });
  }

  return venueId;
}
