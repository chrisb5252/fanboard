import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid, type UUID } from '../src/lib/validators';
import { SCORING_BANDS, pointsForDelta } from '../src/services/bowling';
import type * as BowlingNamespace from '../src/services/bowling';
import type * as DbNamespace from '../src/lib/db';
import type * as LeaderboardNamespace from '../src/lib/leaderboard';

/**
 * Bowling alleys: lanes, predictions, settlement.
 *
 * The assertions that matter here are the ones that would cost a venue money or
 * trust if they broke — a prediction accepted after the lane locked, a lane
 * scored twice, a player at one alley predicting on another's lane. The happy
 * path is the cheap part.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PREFIX = 'bowl-int';

describe('scoring bands', () => {
  /*
   * The bands live twice: as data here, and inlined in GRADE_PREDICTIONS_SQL so
   * settlement stays one statement. Duplicated rules drift, so this pins them
   * together — the integration tests below grade through the SQL and compare
   * against pointsForDelta, and this checks the table itself is sane.
   */
  it('awards most for an exact call and nothing for a wild one', () => {
    expect(pointsForDelta(0)).toBe(50);
    expect(pointsForDelta(5)).toBe(30);
    expect(pointsForDelta(10)).toBe(15);
    expect(pointsForDelta(20)).toBe(5);
    expect(pointsForDelta(21)).toBe(0);
    expect(pointsForDelta(300)).toBe(0);
  });

  it('never awards more for a worse guess', () => {
    for (let delta = 1; delta <= 300; delta += 1) {
      expect(pointsForDelta(delta)).toBeLessThanOrEqual(pointsForDelta(delta - 1));
    }
  });

  it('is ordered tightest-band-first, which is what makes the lookup correct', () => {
    const widths = SCORING_BANDS.map((band) => band.within);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)('bowling', () => {
  let db: typeof DbNamespace;
  let bowling: typeof BowlingNamespace;
  let leaderboard: typeof LeaderboardNamespace;

  let venueId: UUID;
  let otherVenueId: UUID;
  let sportsBarId: UUID;
  let alice: UUID;
  let bob: UUID;

  const cleanup = (): Promise<unknown> =>
    db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  async function seedVenue(type: 'bowling_alley' | 'sports_bar', lanes: number | null) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO venues (name, api_key, type, num_lanes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        `${PREFIX}-${Math.random().toString(36).slice(2)}`,
        hashToken(`k-${Math.random()}`),
        type,
        lanes,
      ],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  async function seedPlayer(venue: UUID, nickname: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO player_sessions (venue_id, nickname, session_token)
       VALUES ($1, $2, $3) RETURNING id`,
      [venue, nickname, hashToken(`t-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  /** The first lane of the venue, provisioned. */
  async function firstLane(venue: UUID): Promise<UUID> {
    await bowling.provisionLanes(venue);
    const lanes = await bowling.listLanes(venue);
    return lanes[0]!.laneId;
  }

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'http://localhost:3000';

    db = await import('../src/lib/db');
    bowling = await import('../src/services/bowling');
    leaderboard = await import('../src/lib/leaderboard');

    await cleanup();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  }, 30_000);

  beforeEach(async () => {
    await cleanup();
    venueId = await seedVenue('bowling_alley', 8);
    otherVenueId = await seedVenue('bowling_alley', 4);
    sportsBarId = await seedVenue('sports_bar', null);
    alice = await seedPlayer(venueId, 'Alice');
    bob = await seedPlayer(venueId, 'Bob');
  });

  describe('provisioning', () => {
    it('creates one lane per lane number', async () => {
      expect(await bowling.provisionLanes(venueId)).toEqual({ created: 8, total: 8 });
      expect((await bowling.listLanes(venueId)).map((lane) => lane.laneNumber)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('is idempotent, so a second call adds nothing', async () => {
      await bowling.provisionLanes(venueId);
      expect(await bowling.provisionLanes(venueId)).toEqual({ created: 0, total: 8 });
    });

    it('adds only the missing lanes after an expansion', async () => {
      await bowling.provisionLanes(venueId);
      await db.query('UPDATE venues SET num_lanes = 12 WHERE id = $1::uuid', [venueId]);

      expect(await bowling.provisionLanes(venueId)).toEqual({ created: 4, total: 12 });
    });

    it('refuses a sports bar', async () => {
      await expect(bowling.provisionLanes(sportsBarId)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('venue type', () => {
    it('answers 404 for lanes at a sports bar, revealing nothing else', async () => {
      await expect(bowling.listLanes(sportsBarId)).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a bowling alley the games route, the mirror of the rule above', async () => {
      const venueType = await import('../src/lib/venue-type');
      await expect(venueType.assertSportsBarVenue(venueId)).rejects.toMatchObject({ status: 404 });
      await expect(venueType.assertSportsBarVenue(sportsBarId)).resolves.toBeUndefined();
    });

    it('answers 404 for a venue that does not exist', async () => {
      await expect(
        bowling.listLanes(trustedUuid('00000000-0000-4000-8000-000000000000')),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('predictions', () => {
    it('records a prediction on an open lane', async () => {
      const laneId = await firstLane(venueId);

      const result = await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });

      expect(result.created).toBe(true);
      expect(result.predictedScore).toBe(180);
    });

    it('lets a patron change their mind while the lane is open', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });

      const changed = await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 210,
      });

      // Changed, not duplicated: one prediction per player per lane.
      expect(changed.created).toBe(false);
      const mine = await bowling.listMyPredictions(venueId, alice);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.predictedScore).toBe(210);
    });

    it('rejects a prediction once the lane is locked', async () => {
      const laneId = await firstLane(venueId);
      await db.query('UPDATE bowling_lanes SET locked_at = NOW() WHERE id = $1::uuid', [laneId]);

      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: alice, predictedScore: 150 }),
      ).rejects.toMatchObject({ status: 423 });
    });

    it('rejects a change once the lane is locked', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 150,
      });
      await db.query('UPDATE bowling_lanes SET locked_at = NOW() WHERE id = $1::uuid', [laneId]);

      // The ON CONFLICT arm is reached only through the same open-lane
      // predicate, so an existing prediction cannot be edited after the lock
      // either. This is the case a naive upsert would let through.
      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: alice, predictedScore: 300 }),
      ).rejects.toMatchObject({ status: 423 });
    });

    it('rejects a prediction on a closed lane', async () => {
      const laneId = await firstLane(venueId);
      await bowling.updateLane(venueId, laneId, { status: 'closed' });

      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: alice, predictedScore: 150 }),
      ).rejects.toMatchObject({ status: 423 });
    });

    it('rejects predictions while the venue is suspended', async () => {
      const laneId = await firstLane(venueId);
      await db.query(
        "UPDATE venues SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = $1::uuid",
        [venueId],
      );

      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: alice, predictedScore: 150 }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects scores outside 0-300', async () => {
      const laneId = await firstLane(venueId);

      for (const score of [-1, 301, 1.5, Number.NaN]) {
        await expect(
          bowling.submitPrediction({
            venueId,
            laneId,
            playerSessionId: alice,
            predictedScore: score,
          }),
        ).rejects.toMatchObject({ status: 400 });
      }
    });

    it('accepts both ends of the range', async () => {
      const laneId = await firstLane(venueId);

      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: alice, predictedScore: 0 }),
      ).resolves.toMatchObject({ predictedScore: 0 });
      await expect(
        bowling.submitPrediction({ venueId, laneId, playerSessionId: bob, predictedScore: 300 }),
      ).resolves.toMatchObject({ predictedScore: 300 });
    });

    it('cannot predict on another venue lane', async () => {
      const ourLane = await firstLane(venueId);
      const theirLane = await firstLane(otherVenueId);

      // Right lane, wrong venue in the request: 404, not a silent write.
      await expect(
        bowling.submitPrediction({
          venueId: otherVenueId,
          laneId: ourLane,
          playerSessionId: alice,
          predictedScore: 150,
        }),
      ).rejects.toMatchObject({ status: 404 });

      // And the player belongs to our venue, so their lane is not reachable
      // under our venue id either.
      await expect(
        bowling.submitPrediction({
          venueId,
          laneId: theirLane,
          playerSessionId: alice,
          predictedScore: 150,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('lists only the caller predictions', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 150,
      });
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: bob,
        predictedScore: 200,
      });

      const mine = await bowling.listMyPredictions(venueId, alice);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.predictedScore).toBe(150);
    });
  });

  describe('lane updates', () => {
    it('changes only the fields the body names', async () => {
      const laneId = await firstLane(venueId);
      await bowling.updateLane(venueId, laneId, {
        status: 'in_use',
        currentBowlerName: 'Dude',
        currentFrame: 3,
        currentScore: 55,
      });

      const lane = await bowling.updateLane(venueId, laneId, { currentFrame: 4 });

      // The bowler survived a frame update. Merging in Node would have dropped
      // them, and would also be a lost-update race between two operators.
      expect(lane.currentBowlerName).toBe('Dude');
      expect(lane.currentFrame).toBe(4);
      expect(lane.currentScore).toBe(55);
      expect(lane.status).toBe('in_use');
    });

    it('clears the bowler when told to explicitly', async () => {
      const laneId = await firstLane(venueId);
      await bowling.updateLane(venueId, laneId, { currentBowlerName: 'Dude' });

      const lane = await bowling.updateLane(venueId, laneId, { currentBowlerName: null });
      expect(lane.currentBowlerName).toBeNull();
    });

    it('refuses to move a graded lane', async () => {
      const laneId = await firstLane(venueId);
      await bowling.gradeLane(venueId, laneId, 200);

      await expect(bowling.updateLane(venueId, laneId, { currentScore: 10 })).rejects.toMatchObject({
        status: 409,
      });
    });

    it('cannot update another venue lane', async () => {
      const theirLane = await firstLane(otherVenueId);
      await expect(
        bowling.updateLane(venueId, theirLane, { currentFrame: 2 }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('grading', () => {
    it('scores every prediction by how close it was', async () => {
      const laneId = await firstLane(venueId);
      const carol = await seedPlayer(venueId, 'Carol');
      const dave = await seedPlayer(venueId, 'Dave');

      // exact, 4 off, 15 off, 80 off
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: bob,
        predictedScore: 176,
      });
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: carol,
        predictedScore: 195,
      });
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: dave,
        predictedScore: 100,
      });

      const result = await bowling.gradeLane(venueId, laneId, 180);
      expect(result).toMatchObject({ predictionsGraded: 4, alreadyGraded: false, finalScore: 180 });

      const scored = await db.query<{
        predicted_score: number;
        accuracy_delta: number;
        points: number;
      }>(
        `SELECT predicted_score, accuracy_delta, points
           FROM bowling_predictions WHERE lane_id = $1::uuid ORDER BY predicted_score`,
        [laneId],
      );

      // Every row must agree with the TypeScript band table. The rule is
      // inlined in SQL to keep settlement one statement, and this is what
      // stops the two definitions drifting apart.
      for (const row of scored.rows) {
        expect(row.accuracy_delta).toBe(Math.abs(row.predicted_score - 180));
        expect(row.points).toBe(pointsForDelta(row.accuracy_delta));
      }
      // Ordered by predicted score: 100 (80 off), 176 (4 off), 180 (exact),
      // 195 (15 off, which is the 20-pin band and 5 points, not the 10-pin one).
      expect(scored.rows.map((row) => row.points)).toEqual([0, 30, 50, 5]);
    });

    it('locks the lane and records the final score', async () => {
      const laneId = await firstLane(venueId);
      await bowling.gradeLane(venueId, laneId, 143);

      const lanes = await bowling.listLanes(venueId);
      const lane = lanes.find((candidate) => candidate.laneId === laneId)!;
      expect(lane.finalScore).toBe(143);
      expect(lane.lockedAt).not.toBeNull();
      expect(lane.gradedAt).not.toBeNull();
    });

    it('is idempotent, so a double tap does not score twice', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });

      const first = await bowling.gradeLane(venueId, laneId, 180);
      const second = await bowling.gradeLane(venueId, laneId, 180);

      expect(first.predictionsGraded).toBe(1);
      expect(second).toMatchObject({ predictionsGraded: 0, alreadyGraded: true });

      const points = await db.query<{ points: number }>(
        'SELECT points FROM bowling_predictions WHERE lane_id = $1::uuid',
        [laneId],
      );
      expect(points.rows[0]!.points).toBe(50);
    });

    it('scores once when two operators grade at the same moment', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });

      // The guard is `graded_at IS NULL` inside the settling UPDATE, so of two
      // concurrent callers exactly one can win regardless of interleaving.
      const results = await Promise.all([
        bowling.gradeLane(venueId, laneId, 180),
        bowling.gradeLane(venueId, laneId, 180),
      ]);

      expect(results.filter((result) => !result.alreadyGraded)).toHaveLength(1);
      expect(results.reduce((sum, result) => sum + result.predictionsGraded, 0)).toBe(1);
    });

    it('rejects a final score outside 0-300', async () => {
      const laneId = await firstLane(venueId);
      await expect(bowling.gradeLane(venueId, laneId, 301)).rejects.toMatchObject({ status: 400 });
      await expect(bowling.gradeLane(venueId, laneId, -1)).rejects.toMatchObject({ status: 400 });
    });

    it('cannot grade another venue lane', async () => {
      const theirLane = await firstLane(otherVenueId);
      await expect(bowling.gradeLane(venueId, theirLane, 180)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('leaderboard', () => {
    it('ranks bowling predictions on the same board as picks', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: bob,
        predictedScore: 120,
      });
      await bowling.gradeLane(venueId, laneId, 180);

      const board = await leaderboard.computeLeaderboard(venueId, 'all_time');

      expect(board.map((entry) => [entry.nickname, entry.points])).toEqual([
        ['Alice', 50],
        ['Bob', 0],
      ]);
      // A prediction that scored nothing is a loss, not an absent player.
      expect(board[1]).toMatchObject({ wins: 0, losses: 1 });
      expect(board[0]).toMatchObject({ wins: 1, losses: 0 });
    });

    it('leaves ungraded predictions off the board', async () => {
      const laneId = await firstLane(venueId);
      await bowling.submitPrediction({
        venueId,
        laneId,
        playerSessionId: alice,
        predictedScore: 180,
      });

      expect(await leaderboard.computeLeaderboard(venueId, 'all_time')).toEqual([]);
    });

    it('does not leak one venue scores into another board', async () => {
      const ourLane = await firstLane(venueId);
      const theirLane = await firstLane(otherVenueId);
      const stranger = await seedPlayer(otherVenueId, 'Mallory');

      await bowling.submitPrediction({
        venueId,
        laneId: ourLane,
        playerSessionId: alice,
        predictedScore: 180,
      });
      await bowling.submitPrediction({
        venueId: otherVenueId,
        laneId: theirLane,
        playerSessionId: stranger,
        predictedScore: 180,
      });
      await bowling.gradeLane(venueId, ourLane, 180);
      await bowling.gradeLane(otherVenueId, theirLane, 180);

      const board = await leaderboard.computeLeaderboard(venueId, 'all_time');
      expect(board.map((entry) => entry.nickname)).toEqual(['Alice']);
    });

    it('still works for a sports bar with no bowling rows at all', async () => {
      // The union arm must not turn an empty bowling table into a broken board
      // for the venue type that will never have one.
      expect(await leaderboard.computeLeaderboard(sportsBarId, 'all_time')).toEqual([]);
    });
  });
});
