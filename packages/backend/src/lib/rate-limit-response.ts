import { NextResponse } from 'next/server';
import type { RateLimitDecision } from './rate-limiter';

/**
 * The shared 429 shape.
 *
 * Retry-After reflects the time actually left in the window rather than a fixed
 * number. Telling someone to wait an hour when ninety seconds remain trains
 * clients — and people — to ignore the header entirely.
 */
export function tooManyRequests(
  decision: RateLimitDecision,
  scope: string,
  message: string,
): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.resetInMs / 1000));

  return NextResponse.json(
    {
      error: {
        code: 'rate_limited',
        message,
        details: { scope, retryAfterSeconds },
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'cache-control': 'no-store',
      },
    },
  );
}
