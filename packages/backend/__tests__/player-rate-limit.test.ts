/**
 * Hardening added on top of the rate limiter that shipped in 5f4d2b8:
 * stricter nickname rules, per-venue nickname holds, session expiry, and the
 * repeat-offender monitor. The limiter itself is covered by
 * player-sessions-rate-limit.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientIpDetailed } from '../src/lib/ip-extractor';
import { createLogger } from '../src/lib/logger';
import {
  ABUSE_ALERT_MESSAGE,
  ABUSE_ALERT_THRESHOLD,
  abuseCounterKey,
  recordRateLimitRejection,
} from '../src/lib/rate-limit-monitor';
import { hashToken } from '../src/lib/tokens';
import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  trustedUuid,
  validateNickname,
  type UUID,
} from '../src/lib/validators';
import { ApiError } from '../src/lib/errors';
import type * as DbNamespace from '../src/lib/db';
import type * as PlayersNamespace from '../src/services/players';
import type * as AuthNamespace from '../src/lib/auth';

const silent = createLogger({ level: 'silent' });

function rejects(value: unknown): ApiError {
  try {
    validateNickname(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

// ---------------------------------------------------------------------------
// Nickname hardening
// ---------------------------------------------------------------------------

describe('nickname rules', () => {
  it('enforces the 2..30 band', () => {
    expect(NICKNAME_MIN_LENGTH).toBe(2);
    expect(NICKNAME_MAX_LENGTH).toBe(30);
    expect(rejects('J').status).toBe(400);
    expect(validateNickname('Jo')).toBe('Jo');
    expect(rejects('x'.repeat(31)).status).toBe(400);
  });

  it('rejects all-numeric and long digit runs', () => {
    expect(rejects('123456').status).toBe(400);
    expect(rejects('42').status).toBe(400);
    expect(rejects('Player12345').status).toBe(400);
    // Four digits is a plausible year or shirt number.
    expect(validateNickname('Dave1987')).toBe('Dave1987');
  });

  it('rejects six or more repeated characters', () => {
    // The supplied pattern used \\1, a literal backslash rather than a
    // backreference, so it never matched anything.
    expect(rejects('aaaaaaaa').status).toBe(400);
    expect(rejects('Loooooool').status).toBe(400);
    expect(validateNickname('Loool')).toBe('Loool');
  });

  it('rejects reserved words used as words', () => {
    for (const value of ['admin', 'Admin', 'ADMIN', 'the moderator', 'system', 'Staff', 'root']) {
      expect(rejects(value).status).toBe(400);
    }
  });

  it('does not reject ordinary words that merely contain a reserved word', () => {
    // Substring matching rejects "Badminton", which contains "admin". A
    // validator that refuses real names trains people to fight it.
    expect(validateNickname('Badminton')).toBe('Badminton');
    expect(validateNickname('Systematic')).toBe('Systematic');
    expect(validateNickname('Rooting')).toBe('Rooting');
  });

  it('still normalises before judging', () => {
    expect(validateNickname('  Big   Dave  ')).toBe('Big Dave');
    // Whitespace collapse happens first, so this is 'a d m i n' -- not reserved.
    expect(validateNickname('a d m i n')).toBe('a d m i n');
  });
});

// ---------------------------------------------------------------------------
// cf-connecting-ip
// ---------------------------------------------------------------------------

describe('cf-connecting-ip', () => {
  const original = process.env['TRUSTED_PROXY_HOPS'];
  afterAll(() => {
    if (original === undefined) {
      delete process.env['TRUSTED_PROXY_HOPS'];
    } else {
      process.env['TRUSTED_PROXY_HOPS'] = original;
    }
  });

  const req = (headers: Record<string, string>) =>
    new Request('https://x.test/', { method: 'POST', headers });

  it('is used when no X-Forwarded-For is present', () => {
    process.env['TRUSTED_PROXY_HOPS'] = '1';
    expect(getClientIpDetailed(req({ 'cf-connecting-ip': '203.0.113.7' }))).toEqual({
      ip: '203.0.113.7',
      source: 'cf-connecting-ip',
    });
  });

  it('never outranks X-Forwarded-For', async () => {
    // Ordering is what makes it safe: any real proxy sets XFF, so a forged
    // cf-connecting-ip cannot displace the positionally-trusted value.
    process.env['TRUSTED_PROXY_HOPS'] = '1';
    const resolved = getClientIpDetailed(
      req({ 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '10.0.0.1' }),
    );
    expect(resolved).toEqual({ ip: '203.0.113.7', source: 'x-forwarded-for' });
  });

  it('is ignored entirely when no proxy is trusted', () => {
    process.env['TRUSTED_PROXY_HOPS'] = '0';
    expect(getClientIpDetailed(req({ 'cf-connecting-ip': '203.0.113.7' })).ip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Repeat-offender monitor
// ---------------------------------------------------------------------------

describe('rate limit monitor', () => {
  function capture() {
    const lines: string[] = [];
    return { lines, logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) };
  }

  function counter(counts: number[]) {
    let call = 0;
    return vi.fn(async () => {
      const value = counts[call] ?? counts[counts.length - 1] ?? 1;
      call += 1;
      return [value, 3_600_000];
    });
  }

  it('logs every rejection', async () => {
    const { lines, logger } = capture();
    await recordRateLimitRejection(
      { venueId: 'v1', clientIp: '203.0.113.7', scope: 'ip', count: 6, limit: 5 },
      { logger, evalScript: counter([1]) },
    );
    expect(lines.some((l) => l.includes('rate limit rejection'))).toBe(true);
  });

  it('alerts once when one address crosses the threshold', async () => {
    const { lines, logger } = capture();
    const evalScript = counter([ABUSE_ALERT_THRESHOLD + 1]);

    await recordRateLimitRejection(
      { venueId: 'v1', clientIp: '203.0.113.7', scope: 'ip', count: 6, limit: 5 },
      { logger, evalScript },
    );

    expect(lines.filter((l) => l.includes(ABUSE_ALERT_MESSAGE))).toHaveLength(1);
  });

  it('does not alert below the threshold', async () => {
    const { lines, logger } = capture();
    await recordRateLimitRejection(
      { venueId: 'v1', clientIp: '203.0.113.7', scope: 'ip', count: 6, limit: 5 },
      { logger, evalScript: counter([ABUSE_ALERT_THRESHOLD]) },
    );
    expect(lines.some((l) => l.includes(ABUSE_ALERT_MESSAGE))).toBe(false);
  });

  it('does not re-alert past the crossing', async () => {
    // One attacker must not become an unbounded page storm.
    const { lines, logger } = capture();
    for (const count of [ABUSE_ALERT_THRESHOLD + 2, ABUSE_ALERT_THRESHOLD + 3]) {
      await recordRateLimitRejection(
        { venueId: 'v1', clientIp: '203.0.113.7', scope: 'ip', count: 6, limit: 5 },
        { logger, evalScript: counter([count]) },
      );
    }
    expect(lines.some((l) => l.includes(ABUSE_ALERT_MESSAGE))).toBe(false);
  });

  it('counts per address', () => {
    expect(abuseCounterKey('203.0.113.7')).not.toBe(abuseCounterKey('203.0.113.8'));
  });

  it('skips the offender counter when there is no address to attribute', async () => {
    const evalScript = vi.fn(async () => [1, 1000]);
    await recordRateLimitRejection(
      { venueId: 'v1', clientIp: null, scope: 'venue', count: 501, limit: 500 },
      { logger: silent, evalScript },
    );
    expect(evalScript).not.toHaveBeenCalled();
  });

  it('never throws, so monitoring cannot fail a request', async () => {
    await expect(
      recordRateLimitRejection(
        { venueId: 'v1', clientIp: '203.0.113.7', scope: 'ip', count: 6, limit: 5 },
        {
          logger: silent,
          evalScript: async () => {
            throw new Error('redis down');
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Against real PostgreSQL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(TEST_DATABASE_URL === undefined)('nickname holds and session expiry', () => {
  let db: typeof DbNamespace;
  let players: typeof PlayersNamespace;
  let auth: typeof AuthNamespace;
  let venueId: UUID;
  let otherVenueId: UUID;

  const PREFIX = 'nick-int';
  const cleanup = () => db.query('DELETE FROM venues WHERE name LIKE $1', [`${PREFIX}-%`]);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DATABASE_URL;
    process.env['REDIS_URL'] ??= 'redis://localhost:6379';
    process.env['THESPORTSDB_API_KEY'] ??= 'x';
    process.env['NEXT_PUBLIC_API_URL'] ??= 'https://fanboard.com';
    db = await import('../src/lib/db');
    players = await import('../src/services/players');
    auth = await import('../src/lib/auth');
  });

  afterAll(async () => {
    await cleanup();
    await db.closePool();
  });

  async function seedVenue(name: string): Promise<UUID> {
    const row = await db.query<{ id: string }>(
      'INSERT INTO venues (name, api_key) VALUES ($1,$2) RETURNING id',
      [`${PREFIX}-${name}`, hashToken(`k-${name}-${Math.random()}`)],
    );
    return trustedUuid(row.rows[0]!.id);
  }

  beforeEach(async () => {
    await cleanup();
    venueId = await seedVenue(`a-${Math.random().toString(36).slice(2)}`);
    otherVenueId = await seedVenue(`b-${Math.random().toString(36).slice(2)}`);
  });

  it('holds a nickname against a second claimant', async () => {
    await players.createPlayerSession({ venueId, nickname: 'Mike' });
    await expect(
      players.createPlayerSession({ venueId, nickname: 'Mike' }),
    ).rejects.toMatchObject({ status: 409, code: 'nickname_taken' });
  });

  it('holds case-insensitively', async () => {
    await players.createPlayerSession({ venueId, nickname: 'Mike' });
    await expect(
      players.createPlayerSession({ venueId, nickname: 'mIkE' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('holds per venue, not globally', async () => {
    await players.createPlayerSession({ venueId, nickname: 'Mike' });
    await expect(
      players.createPlayerSession({ venueId: otherVenueId, nickname: 'Mike' }),
    ).resolves.toMatchObject({ nickname: 'Mike' });
  });

  it('still reports a missing venue as 404, not 409', async () => {
    await expect(
      players.createPlayerSession({
        venueId: trustedUuid('99999999-9999-9999-9999-999999999999'),
        nickname: 'Ghost',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('releases the nickname once the hold window passes', async () => {
    const first = await players.createPlayerSession({ venueId, nickname: 'Mike' });
    await db.query(
      "UPDATE player_sessions SET created_at = NOW() - INTERVAL '61 minutes' WHERE id = $1",
      [first.playerId],
    );
    await expect(
      players.createPlayerSession({ venueId, nickname: 'Mike' }),
    ).resolves.toMatchObject({ nickname: 'Mike' });
  });

  it('releases the nickname once the holder is expired', async () => {
    const first = await players.createPlayerSession({ venueId, nickname: 'Mike' });
    await db.query('UPDATE player_sessions SET expired = TRUE WHERE id = $1', [first.playerId]);
    await expect(
      players.createPlayerSession({ venueId, nickname: 'Mike' }),
    ).resolves.toMatchObject({ nickname: 'Mike' });
  });

  it('decides the hold inside the insert, not before it', async () => {
    // Check-then-insert would let two simultaneous claims both succeed.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => players.createPlayerSession({ venueId, nickname: 'Mike' })),
    );
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);

    const stored = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM player_sessions WHERE venue_id = $1 AND lower(nickname) = 'mike'",
      [venueId],
    );
    expect(stored.rows[0]?.count).toBe('1');
  });

  it('defaults expires_at to 24 hours out', async () => {
    const session = await players.createPlayerSession({ venueId, nickname: 'Timed' });
    const row = await db.query<{ hours: string }>(
      "SELECT round(EXTRACT(EPOCH FROM (expires_at - NOW())) / 3600)::text AS hours FROM player_sessions WHERE id = $1",
      [session.playerId],
    );
    expect(row.rows[0]?.hours).toBe('24');
  });

  it('refuses to authenticate a session past expires_at', async () => {
    const session = await players.createPlayerSession({ venueId, nickname: 'Lapsed' });
    const guard = auth.sessionMiddleware({ db: db.sql });
    const request = () =>
      new Request('https://fanboard.test/x', {
        method: 'POST',
        headers: { cookie: `session_token=${session.sessionToken}` },
      });

    await expect(guard(request())).resolves.toMatchObject({ nickname: 'Lapsed' });

    await db.query("UPDATE player_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [
      session.playerId,
    ]);

    await expect(guard(request())).rejects.toMatchObject({ status: 401 });
  });

  it('keeps an expired player on the leaderboard', async () => {
    // Standings are historical fact. Filtering the leaderboard by session
    // expiry would empty the all-time board every 24 hours.
    const leaderboard = await import('../src/lib/leaderboard');
    const session = await players.createPlayerSession({ venueId, nickname: 'Winner' });

    const game = await db.query<{ id: string }>(
      `INSERT INTO games (venue_id, external_id, league, sport, home_team, away_team, scheduled_at, status, winner, graded_at)
       VALUES ($1,'exp-1','NFL','American Football','A','B', NOW() - INTERVAL '2 hours','final','home',NOW())
       RETURNING id`,
      [venueId],
    );
    await db.query(
      `INSERT INTO picks (venue_id, game_id, player_session_id, predicted_winner, correct, points, graded_at)
       VALUES ($1,$2,$3,'home',TRUE,10,NOW())`,
      [venueId, game.rows[0]!.id, session.playerId],
    );

    await db.query(
      "UPDATE player_sessions SET expires_at = NOW() - INTERVAL '1 day', expired = TRUE WHERE id = $1",
      [session.playerId],
    );

    const board = await leaderboard.computeLeaderboard(venueId, 'all_time', { db: db.sql });
    expect(board.map((e) => e.nickname)).toEqual(['Winner']);
    expect(board[0]?.points).toBe(10);
  });
});
