import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  adminMiddleware,
  assertVenueScope,
  deviceMiddleware,
  parseBearer,
  parseCookieHeader,
  sessionMiddleware,
} from '../src/lib/auth';
import type { SqlExecutor, SqlResult } from '../src/lib/db';
import { ApiError } from '../src/lib/errors';
import { hashToken } from '../src/lib/tokens';
import { trustedUuid } from '../src/lib/validators';

const VENUE_A = trustedUuid('11111111-1111-1111-1111-111111111111');
const VENUE_B = trustedUuid('22222222-2222-2222-2222-222222222222');
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

const RAW_SESSION_TOKEN = 'lC8hVQ2n_raw-session-token-value-abcdefgh';
const RAW_API_KEY = 'venue-api-key-abcdefghijklmnop';
const RAW_DISPLAY_KEY = 'DISPLAY-42XZ';

function result<T>(rows: T[]): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

/** A fake that answers only when the presented hash matches, like the index would. */
function fakeDb(rowsByHash: Map<string, Record<string, unknown>[]>): {
  db: SqlExecutor;
  calls: { sql: string; params: readonly unknown[] }[];
} {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db: SqlExecutor = {
    query: async <T,>(sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const key = String(params?.[0] ?? '');
      return result((rowsByHash.get(key) ?? []) as T[]);
    },
  };
  return { db, calls };
}

function requestWithCookie(cookie: string): Request {
  return new Request('https://fanboard.test/api/venues/x/picks', {
    method: 'POST',
    headers: { cookie },
  });
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(status);
    return apiError;
  }
  throw new Error(`expected the call to reject with ${status}, but it resolved`);
}

describe('parseCookieHeader', () => {
  it('reads a single cookie', () => {
    expect(parseCookieHeader('session_token=abc').get('session_token')).toBe('abc');
  });

  it('reads one cookie out of many', () => {
    const jar = parseCookieHeader('theme=dark; session_token=abc; other=1');
    expect(jar.get('session_token')).toBe('abc');
    expect(jar.get('theme')).toBe('dark');
  });

  it('handles quoted and percent-encoded values', () => {
    expect(parseCookieHeader('a="quoted"').get('a')).toBe('quoted');
    expect(parseCookieHeader('a=one%20two').get('a')).toBe('one two');
  });

  it('survives malformed input without throwing', () => {
    expect(parseCookieHeader(null).size).toBe(0);
    expect(parseCookieHeader('').size).toBe(0);
    expect(parseCookieHeader('=novalue; ;;; x').size).toBe(0);
    // A broken percent-escape must not 500 the request.
    expect(parseCookieHeader('a=%E0%A4%A').get('a')).toBe('%E0%A4%A');
  });

  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookieHeader('a=first; a=second').get('a')).toBe('first');
  });
});

describe('parseBearer', () => {
  it('extracts the credential', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
    expect(parseBearer('bearer abc123')).toBe('abc123');
  });

  it('rejects anything that is not a bearer credential', () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer   ')).toBeNull();
    expect(parseBearer('Basic abc123')).toBeNull();
  });
});

describe('sessionMiddleware', () => {
  function withSession() {
    return fakeDb(
      new Map([
        [
          hashToken(RAW_SESSION_TOKEN),
          [{ id: SESSION_ID, venue_id: VENUE_A, nickname: 'Chris' }],
        ],
      ]),
    );
  }

  it('accepts a valid session_token cookie', async () => {
    const { db } = withSession();
    const context = await sessionMiddleware({ db })(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${RAW_SESSION_TOKEN}`),
    );

    expect(context).toEqual({
      playerSessionId: SESSION_ID,
      venueId: VENUE_A,
      nickname: 'Chris',
    });
  });

  it('looks the session up by hash, never by the raw token', async () => {
    const { db, calls } = withSession();
    await sessionMiddleware({ db })(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${RAW_SESSION_TOKEN}`),
    );

    const params = calls[0]?.params ?? [];
    expect(params[0]).toBe(hashToken(RAW_SESSION_TOKEN));
    expect(params).not.toContain(RAW_SESSION_TOKEN);
  });

  it('refreshes last_seen_at in the same statement that authenticates', async () => {
    const { db, calls } = withSession();
    await sessionMiddleware({ db })(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${RAW_SESSION_TOKEN}`),
    );

    // One statement, so there is no window between "still valid" and "touched".
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('UPDATE player_sessions');
    expect(calls[0]?.sql).toContain('last_seen_at = NOW()');
  });

  it('enforces expiry and the idle timeout in SQL, not in JavaScript', async () => {
    const { db, calls } = withSession();
    await sessionMiddleware({ db })(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${RAW_SESSION_TOKEN}`),
    );

    expect(calls[0]?.sql).toContain('expired = FALSE');
    expect(calls[0]?.sql).toContain('last_seen_at > NOW()');
  });

  it('rejects an unknown token with 401', async () => {
    const { db } = withSession();
    await expectApiError(
      sessionMiddleware({ db })(requestWithCookie(`${SESSION_COOKIE_NAME}=not-a-real-token`)),
      401,
    );
  });

  it('rejects a request with no cookie at all', async () => {
    const { db } = withSession();
    const request = new Request('https://fanboard.test/x', { method: 'POST' });
    await expectApiError(sessionMiddleware({ db })(request), 401);
  });

  it('rejects an empty cookie value', async () => {
    const { db } = withSession();
    await expectApiError(
      sessionMiddleware({ db })(requestWithCookie(`${SESSION_COOKIE_NAME}=`)),
      401,
    );
  });

  it('gives the same message whether the token is unknown or expired', async () => {
    // Distinguishable errors would let a caller probe which tokens exist.
    const { db } = withSession();
    const unknown = await expectApiError(
      sessionMiddleware({ db })(requestWithCookie(`${SESSION_COOKIE_NAME}=unknown`)),
      401,
    );
    const expired = await expectApiError(
      sessionMiddleware({ db })(requestWithCookie(`${SESSION_COOKIE_NAME}=expired`)),
      401,
    );
    expect(unknown.message).toBe(expired.message);
  });
});

describe('adminMiddleware', () => {
  function withVenue() {
    return fakeDb(new Map([[hashToken(RAW_API_KEY), [{ id: VENUE_A }]]]));
  }

  it('accepts a valid api_key', async () => {
    const { db } = withVenue();
    const request = new Request('https://fanboard.test/admin', {
      headers: { authorization: `Bearer ${RAW_API_KEY}` },
    });

    await expect(adminMiddleware({ db })(request)).resolves.toEqual({ venueId: VENUE_A });
  });

  it('matches on the hash, never the raw key', async () => {
    const { db, calls } = withVenue();
    await adminMiddleware({ db })(
      new Request('https://fanboard.test/admin', {
        headers: { authorization: `Bearer ${RAW_API_KEY}` },
      }),
    );

    expect(calls[0]?.params[0]).toBe(hashToken(RAW_API_KEY));
    expect(calls[0]?.params).not.toContain(RAW_API_KEY);
  });

  it('rejects an invalid api_key with 401', async () => {
    const { db } = withVenue();
    const request = new Request('https://fanboard.test/admin', {
      headers: { authorization: 'Bearer wrong-key' },
    });

    await expectApiError(adminMiddleware({ db })(request), 401);
  });

  it('rejects a missing or non-bearer Authorization header', async () => {
    const { db } = withVenue();
    await expectApiError(
      adminMiddleware({ db })(new Request('https://fanboard.test/admin')),
      401,
    );
    await expectApiError(
      adminMiddleware({ db })(
        new Request('https://fanboard.test/admin', {
          headers: { authorization: `Basic ${RAW_API_KEY}` },
        }),
      ),
      401,
    );
  });
});

describe('deviceMiddleware', () => {
  function withDevice() {
    return fakeDb(
      new Map([[hashToken(RAW_DISPLAY_KEY), [{ id: DEVICE_ID, venue_id: VENUE_A }]]]),
    );
  }

  it('accepts a valid display_key', async () => {
    const { db } = withDevice();
    const request = new Request('https://fanboard.test/tv', {
      headers: { 'x-display-key': RAW_DISPLAY_KEY },
    });

    await expect(deviceMiddleware({ db })(request)).resolves.toEqual({
      deviceId: DEVICE_ID,
      venueId: VENUE_A,
    });
  });

  it('rejects an unknown display_key with 401', async () => {
    const { db } = withDevice();
    const request = new Request('https://fanboard.test/tv', {
      headers: { 'x-display-key': 'NOPE-0000' },
    });

    await expectApiError(deviceMiddleware({ db })(request), 401);
  });

  it('rejects a missing header', async () => {
    const { db } = withDevice();
    await expectApiError(deviceMiddleware({ db })(new Request('https://fanboard.test/tv')), 401);
  });
});

describe('assertVenueScope', () => {
  it('allows a session acting on its own venue', () => {
    expect(() => assertVenueScope({ venueId: VENUE_A }, VENUE_A)).not.toThrow();
  });

  it('blocks a valid session acting on another venue', () => {
    // Without this, changing the venue id in the URL would be enough.
    try {
      assertVenueScope({ venueId: VENUE_A }, VENUE_B);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
    }
  });
});

describe('credential handling', () => {
  it('produces a stable hash and never returns the input', () => {
    const hashed = hashToken(RAW_SESSION_TOKEN);
    expect(hashed).toBe(hashToken(RAW_SESSION_TOKEN));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(RAW_SESSION_TOKEN);
  });

  it('parameterises every credential query rather than interpolating', async () => {
    const { db, calls } = fakeDb(new Map());
    const injection = "' OR '1'='1";

    await expectApiError(
      sessionMiddleware({ db })(requestWithCookie(`${SESSION_COOKIE_NAME}=${injection}`)),
      401,
    );

    // The value reaches the driver as a bound parameter, hashed, and the SQL
    // text is unchanged by it.
    expect(calls[0]?.sql).not.toContain(injection);
    expect(calls[0]?.params[0]).toBe(hashToken(injection));
  });

  it('does not query at all when no credential is presented', async () => {
    const query = vi.fn();
    await expectApiError(
      sessionMiddleware({ db: { query } })(new Request('https://fanboard.test/x')),
      401,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
