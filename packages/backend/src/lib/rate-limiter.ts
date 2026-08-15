import { logger as rootLogger, type Logger } from './logger';
import { evalScript as defaultEvalScript } from './redis';

/**
 * Fixed-window rate limiting on Redis.
 *
 * The counter and its expiry are set by one Lua script rather than an INCR
 * followed by an EXPIRE. That is not micro-optimisation: with two round trips,
 * a process that dies — or a connection that drops — between them leaves a key
 * with no TTL. The counter then never resets and that client is locked out
 * permanently. Turning a rate limiter into a persistent denial of service
 * against your own users is a worse bug than the one it was added to fix.
 *
 * The script also re-arms a missing TTL on every call, so a key that somehow
 * ends up immortal repairs itself on the next request instead of needing an
 * operator to notice.
 */
const INCREMENT_AND_ARM = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests seen in the current window, including this one. */
  readonly count: number;
  readonly limit: number;
  /** Milliseconds until the window resets. */
  readonly resetInMs: number;
  /** True when Redis was unreachable and the request was let through. */
  readonly degraded: boolean;
}

export interface RateLimiterDeps {
  evalScript: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  logger: Logger;
}

function resolveDeps(deps?: Partial<RateLimiterDeps>): RateLimiterDeps {
  return {
    evalScript: deps?.evalScript ?? defaultEvalScript,
    logger: deps?.logger ?? rootLogger.child({ component: 'rate-limiter' }),
  };
}

function parseReply(reply: unknown): { count: number; ttl: number } | null {
  if (!Array.isArray(reply) || reply.length < 2) {
    return null;
  }
  const count = Number(reply[0]);
  const ttl = Number(reply[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
    return null;
  }
  return { count, ttl };
}

/**
 * Consumes one unit against `key` and reports the decision.
 *
 * On a Redis failure this **fails open**: the request is allowed and `degraded`
 * is set. That is a deliberate availability-over-security trade, and it has a
 * real cost — an attacker who can make Redis unreachable also removes the rate
 * limit. It is the right default here because the alternative is that a Redis
 * blip stops every patron in every venue from joining, but it means Redis
 * availability is now a security control and should be alerted on.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  deps?: Partial<RateLimiterDeps>,
): Promise<RateLimitDecision> {
  const { evalScript, logger } = resolveDeps(deps);

  try {
    const reply = await evalScript(INCREMENT_AND_ARM, [`ratelimit:${key}`], [String(windowMs)]);
    const parsed = parseReply(reply);

    if (parsed === null) {
      logger.error('rate limiter received an unexpected reply; failing open', { key });
      return { allowed: true, count: 0, limit, resetInMs: 0, degraded: true };
    }

    return {
      allowed: parsed.count <= limit,
      count: parsed.count,
      limit,
      resetInMs: Math.max(0, parsed.ttl),
      degraded: false,
    };
  } catch (error) {
    // Availability wins; see the note above. Logged at error level because a
    // silently disabled rate limiter is exactly the thing nobody notices.
    logger.error('rate limit check failed; failing open', { key, error });
    return { allowed: true, count: 0, limit, resetInMs: 0, degraded: true };
  }
}

/**
 * Boolean form, matching the signature the brief specified.
 *
 * Prefer consumeRateLimit where the caller needs Retry-After or wants to know
 * the limiter was degraded — this form cannot express either.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  deps?: Partial<RateLimiterDeps>,
): Promise<boolean> {
  return (await consumeRateLimit(key, limit, windowMs, deps)).allowed;
}
