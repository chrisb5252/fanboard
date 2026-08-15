import { consumeRateLimit, type RateLimiterDeps } from './rate-limiter';
import { logger as rootLogger, type Logger } from './logger';

/**
 * Turns individual rate-limit rejections into an abuse signal.
 *
 * One rejection is the limiter working and is not interesting. The same address
 * being rejected repeatedly, across an hour, is someone probing — that is what
 * deserves a page.
 *
 * The counter reuses the rate limiter itself: a rejection "consumes" against a
 * separate bucket, and crossing that bucket's limit is the alert condition. It
 * therefore inherits the same atomicity and the same fail-open behaviour.
 */

/** Rejections from one address, per hour, before it is treated as an attack. */
export const ABUSE_ALERT_THRESHOLD = 10;

export const ABUSE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Emitted exactly once per address per window, when the threshold is crossed.
 * This is the string to alert on; the per-rejection lines are too noisy.
 */
export const ABUSE_ALERT_MESSAGE = 'possible attack: repeated rate limit rejections from one client';

export function abuseCounterKey(clientIp: string): string {
  return `ratelimit_hits:${clientIp}`;
}

export interface RateLimitHit {
  readonly venueId: string;
  readonly clientIp: string | null;
  /** Which limit rejected: 'ip' or 'venue'. */
  readonly scope: string;
  readonly count: number;
  readonly limit: number;
}

export interface MonitorDeps extends RateLimiterDeps {
  logger: Logger;
}

/**
 * Records a rejection and raises one alert per address per window.
 *
 * Never throws and never blocks the response: monitoring that can fail a
 * request is worse than no monitoring. A null clientIp is counted only as a
 * plain rejection — there is no address to attribute repeat offences to.
 */
export async function recordRateLimitRejection(
  hit: RateLimitHit,
  deps?: Partial<MonitorDeps>,
): Promise<void> {
  const log = deps?.logger ?? rootLogger.child({ component: 'rate-limit-monitor' });

  try {
    log.warn('rate limit rejection', {
      venueId: hit.venueId,
      clientIp: hit.clientIp,
      scope: hit.scope,
      count: hit.count,
      limit: hit.limit,
    });

    if (hit.clientIp === null) {
      return;
    }

    const abuse = await consumeRateLimit(
      abuseCounterKey(hit.clientIp),
      ABUSE_ALERT_THRESHOLD,
      ABUSE_WINDOW_MS,
      deps,
    );

    // Fire on the crossing only. Alerting on every rejection past the threshold
    // would turn one attacker into an unbounded page storm.
    if (!abuse.allowed && abuse.count === ABUSE_ALERT_THRESHOLD + 1) {
      log.error(ABUSE_ALERT_MESSAGE, {
        clientIp: hit.clientIp,
        venueId: hit.venueId,
        rejections: abuse.count,
        windowMs: ABUSE_WINDOW_MS,
      });
    }
  } catch (error) {
    log.error('rate limit monitoring failed', { error });
  }
}
