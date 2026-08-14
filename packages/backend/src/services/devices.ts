import { DEVICE_OFFLINE_AFTER_SECONDS } from '../lib/cache-keys';
import type { SqlExecutor } from '../lib/db';
import { sql as defaultSql } from '../lib/db';
import { ApiError } from '../lib/errors';
import { generateDisplayKey, hashToken } from '../lib/tokens';
import { trustedUuid, type UUID } from '../lib/validators';

export interface PairDeviceInput {
  venueId: UUID;
  displayName: string;
  fireTvDeviceId: string;
}

export interface PairedDevice {
  deviceId: UUID;
  displayName: string;
  /** Raw key. Returned exactly once, at pairing, and never persisted. */
  displayKey: string;
}

export interface DeviceStatus {
  deviceId: UUID;
  displayName: string;
  online: boolean;
  lastHeartbeat: string | null;
  fireTvDeviceId: string | null;
}

export interface DeviceServiceDeps {
  db: SqlExecutor;
  generateKey: () => string;
}

function resolveDeps(deps?: Partial<DeviceServiceDeps>): DeviceServiceDeps {
  return {
    db: deps?.db ?? defaultSql,
    generateKey: deps?.generateKey ?? generateDisplayKey,
  };
}

/**
 * Registers a display against a venue.
 *
 * The venue check and the insert are one statement, so there is no window in
 * which the venue could disappear between "it exists" and "insert". Only the
 * hash of the display key reaches the database; the raw value is returned to
 * the caller once and is unrecoverable afterwards.
 */
const PAIR_DEVICE_SQL = `
INSERT INTO devices (venue_id, display_name, fire_tv_device_id, display_key, last_heartbeat)
SELECT v.id, $2, $3, $4, NOW()
  FROM venues v
 WHERE v.id = $1::uuid
RETURNING id, display_name
`;

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export async function pairDevice(
  input: PairDeviceInput,
  deps?: Partial<DeviceServiceDeps>,
): Promise<PairedDevice> {
  const { db, generateKey } = resolveDeps(deps);
  const displayKey = generateKey();

  let result;
  try {
    result = await db.query<{ id: string; display_name: string }>(PAIR_DEVICE_SQL, [
      input.venueId,
      input.displayName,
      input.fireTvDeviceId,
      hashToken(displayKey),
    ]);
  } catch (error) {
    // idx_devices_venue_fire_tv_device_id: one hardware id per venue. Surfaced
    // as 409 rather than a 500, because re-registering an already-paired stick
    // is an ordinary operator mistake, not a server fault.
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        'device_already_paired',
        'This Fire TV device is already paired to this venue',
      );
    }
    throw error;
  }

  const row = result.rows[0];
  if (row === undefined) {
    throw ApiError.notFound('Venue not found');
  }

  return {
    deviceId: trustedUuid(row.id),
    displayName: row.display_name,
    displayKey,
  };
}

/**
 * Online is computed in SQL against the database clock, for the same reason the
 * game lock is: a status derived from the caller's clock is not a status.
 */
const DEVICE_STATUS_SQL = `
SELECT id,
       display_name,
       fire_tv_device_id,
       last_heartbeat,
       (last_heartbeat IS NOT NULL
        AND last_heartbeat > NOW() - make_interval(secs => $2::int)) AS online
  FROM devices
 WHERE venue_id = $1::uuid
 ORDER BY display_name ASC
`;

export async function listDeviceStatus(
  venueId: UUID,
  deps?: Partial<DeviceServiceDeps>,
): Promise<DeviceStatus[]> {
  const { db } = resolveDeps(deps);

  const result = await db.query<{
    id: string;
    display_name: string;
    fire_tv_device_id: string | null;
    last_heartbeat: Date | null;
    online: boolean;
  }>(DEVICE_STATUS_SQL, [venueId, DEVICE_OFFLINE_AFTER_SECONDS]);

  return result.rows.map((row) => ({
    deviceId: trustedUuid(row.id),
    displayName: row.display_name,
    online: row.online,
    lastHeartbeat: row.last_heartbeat?.toISOString() ?? null,
    fireTvDeviceId: row.fire_tv_device_id,
  }));
}

/**
 * Stamps the device's liveness column.
 *
 * This is the only write a display key can perform, and it touches exactly one
 * column on the device's own row -- scoped by id so a key cannot mark another
 * display alive.
 */
export async function recordHeartbeat(
  deviceId: UUID,
  deps?: Partial<DeviceServiceDeps>,
): Promise<void> {
  const { db } = resolveDeps(deps);
  const result = await db.query<{ id: string }>(
    'UPDATE devices SET last_heartbeat = NOW() WHERE id = $1::uuid RETURNING id',
    [deviceId],
  );
  if (result.rows.length === 0) {
    throw ApiError.notFound('Device not found');
  }
}
