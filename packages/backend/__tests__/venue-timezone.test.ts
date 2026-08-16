import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import type * as AdminNamespace from '../src/services/admin';
import type * as DbNamespace from '../src/lib/db';
import type * as DisplayNamespace from '../src/services/display';

/**
 * The venue's day, not the server's.
 *
 * "Today's games" and the daily leaderboard used to be truncated in the
 * database's timezone. For an American venue that rolls the day over at 8pm
 * local, so a 20:10 kick-off counted as tomorrow and vanished from the pickable
 * list exactly when the room was watching it — and the next day's fixtures
 * appeared in its place.
 *
 * The fixtures below are pinned to real instants either side of that boundary
 * rather than to "now", so the test asserts the behaviour rather than whatever
 * time it happens to run at.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PREFIX = 'tz-int';

describe.skipIf(TEST_DATABASE_URL === undefined)('venue-local day', () => {
  let db: typeof DbNamespace;
  let admin: typeof AdminNamespace;
  let display: typeof DisplayNamespace;

  let venueId: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    admin = await import('../src/services/admin');
    display = await import('../src/services/display');

    await cleanup();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  }, 30_000);

  beforeEach(async () => {
    await cleanup();
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${Math.random().toString(36).slice(2)}`, hashToken(`k-${Math.random()}`)],
    );
    venueId = trustedUuid(row.rows[0]!.id);
  });

  /** Seeds a game at an exact instant. */
  async function seedGameAt(isoInstant: string, label: string): Promise<void> {
    await db.query(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at)
       VALUES ($1::uuid,$2,'MLB','Baseball',$3,'Away', $4::timestamptz)`,
      [venueId, `${PREFIX}-${label}`, label, isoInstant],
    );
  }

  describe('timezone configuration', () => {
    it('defaults to UTC so existing venues are unaffected', async () => {
      expect((await admin.getVenueConfig(venueId)).timezone).toBe('UTC');
    });

    it('accepts an IANA zone', async () => {
      const updated = await admin.setVenueTimezone(venueId, 'America/New_York');
      expect(updated.timezone).toBe('America/New_York');
    });

    it('rejects a zone the server does not know, with 400', async () => {
      // Rejected on write rather than on read: an unknown zone stored here
      // would make every games query for the venue throw afterwards.
      await expect(admin.setVenueTimezone(venueId, 'Mars/Olympus')).rejects.toMatchObject({
        status: 400,
      });
      expect((await admin.getVenueConfig(venueId)).timezone).toBe('UTC');
    });

    it('leaves the enabled leagues alone', async () => {
      await admin.setVenueConfig(venueId, ['NFL']);
      await admin.setVenueTimezone(venueId, 'America/Chicago');

      const config = await admin.getVenueConfig(venueId);
      expect(config.enabledLeagues).toEqual(['NFL']);
      expect(config.timezone).toBe('America/Chicago');
    });
  });

  describe('the 8pm boundary', () => {
    /*
     * 2026-08-22T00:10Z is 2026-08-21 20:10 in New York.
     *
     * To a patron in the bar that is Friday night's game. To UTC it is Saturday.
     * This is the exact case that was broken.
     */
    const EVENING_GAME = '2026-08-22T00:10:00Z';
    /** 2026-08-21T23:15Z is 19:15 the same evening in New York. */
    const EARLIER_SAME_EVENING = '2026-08-21T23:15:00Z';

    it('keeps a late kick-off on the same local day as the earlier game', async () => {
      await seedGameAt(EARLIER_SAME_EVENING, 'seven-fifteen');
      await seedGameAt(EVENING_GAME, 'eight-ten');
      await admin.setVenueTimezone(venueId, 'America/New_York');

      // Both are Friday evening in New York, so a venue asking on Friday must
      // see both. Asserted through the same query the games endpoint uses.
      const sameDay = await db.query<{ n: string }>(
        `WITH venue_day AS (
           SELECT date_trunc('day', $2::timestamptz AT TIME ZONE v.timezone) AT TIME ZONE v.timezone AS starts_at
             FROM venues v WHERE v.id = $1::uuid
         )
         SELECT count(*)::text AS n FROM games g CROSS JOIN venue_day d
          WHERE g.venue_id = $1::uuid
            AND g.scheduled_at >= d.starts_at
            AND g.scheduled_at < d.starts_at + INTERVAL '1 day'`,
        [venueId, '2026-08-21T22:00:00Z'],
      );
      expect(sameDay.rows[0]?.n).toBe('2');
    });

    it('split them across two days under UTC, which is the bug', async () => {
      await seedGameAt(EARLIER_SAME_EVENING, 'seven-fifteen');
      await seedGameAt(EVENING_GAME, 'eight-ten');
      // Venue left on the UTC default.

      const utcDay = await db.query<{ n: string }>(
        `WITH venue_day AS (
           SELECT date_trunc('day', $2::timestamptz AT TIME ZONE v.timezone) AT TIME ZONE v.timezone AS starts_at
             FROM venues v WHERE v.id = $1::uuid
         )
         SELECT count(*)::text AS n FROM games g CROSS JOIN venue_day d
          WHERE g.venue_id = $1::uuid
            AND g.scheduled_at >= d.starts_at
            AND g.scheduled_at < d.starts_at + INTERVAL '1 day'`,
        [venueId, '2026-08-21T22:00:00Z'],
      );
      // Only the 19:15 game. The 20:10 one fell into the next UTC day — the
      // behaviour this change exists to fix.
      expect(utcDay.rows[0]?.n).toBe('1');
    });

    it('serves the venue-local day through the display payload', async () => {
      await seedGameAt(EARLIER_SAME_EVENING, 'display-early');
      await seedGameAt(EVENING_GAME, 'display-late');
      await admin.setVenueTimezone(venueId, 'America/New_York');

      // buildDisplayPayload uses NOW(), so this only asserts that the query
      // runs and is venue-scoped; the boundary itself is pinned above.
      const payload = await display.buildDisplayPayload(venueId);
      expect(Array.isArray(payload.games)).toBe(true);
    });
  });

  describe('leaderboard windows', () => {
    it("computes 'today' in the venue's zone", async () => {
      await admin.setVenueTimezone(venueId, 'America/New_York');
      const leaderboard = await import('../src/lib/leaderboard');

      // No picks, so the board is empty — the assertion is that the query
      // compiles and runs with the timezone join, which is where a bad
      // AT TIME ZONE would throw.
      const board = await leaderboard.computeLeaderboard(venueId, 'today');
      expect(board).toEqual([]);
    });

    it("computes 'this_week' in the venue's zone", async () => {
      await admin.setVenueTimezone(venueId, 'Australia/Sydney');
      const leaderboard = await import('../src/lib/leaderboard');
      expect(await leaderboard.computeLeaderboard(venueId, 'this_week')).toEqual([]);
    });
  });
});
