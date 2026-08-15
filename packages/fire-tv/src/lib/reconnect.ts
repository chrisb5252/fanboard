import { useEffect, useRef, useState } from 'react';
import { fetchDisplay, getCachedDisplay, type DisplayPayload } from './api';
import { log } from './log';

export const NORMAL_INTERVAL_MS = 10_000;

/**
 * Backoff after a failure: 5s, 10s, 20s, 40s, then held at 60s.
 *
 * Doubling from 5 with a ceiling. The ceiling matters more than the curve — an
 * unattended TV can be disconnected for hours, and without a cap the retry
 * interval grows until the display takes most of an evening to notice the
 * network came back.
 */
export const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export function backoffFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return NORMAL_INTERVAL_MS;
  }
  const index = Math.min(consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index] ?? 60_000;
}

export interface DisplayState {
  data: DisplayPayload | null;
  /** True while the connection is failing, whatever is on screen. */
  degraded: boolean;
  /** When the payload on screen was actually fetched. */
  lastSuccessAt: Date | null;
}

/**
 * Polls the display endpoint, backing off on failure.
 *
 * On recovery it returns immediately to the normal cadence rather than easing
 * back, because the first success proves the link is up.
 *
 * There is no user-facing error anywhere in here. Failures change the polling
 * rate and set `degraded` for a subtle staleness marker; they never replace
 * what is on the screen.
 */
export function useAutoRefresh(
  deviceId: string | null,
  displayKey: string | null,
  intervalMs: number = NORMAL_INTERVAL_MS,
): DisplayState {
  const [data, setData] = useState<DisplayPayload | null>(() => getCachedDisplay());
  const [degraded, setDegraded] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);

  const failuresRef = useRef(0);

  useEffect(() => {
    if (deviceId === null || displayKey === null) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const schedule = (delayMs: number): void => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(() => {
        void run();
      }, delayMs);
    };

    const run = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      log.info('display fetch attempt', { attemptAfterFailures: failuresRef.current });

      try {
        const { payload, live } = await fetchDisplay(deviceId, displayKey, controller.signal);
        if (cancelled) {
          return;
        }

        // Always render what we have, live or cached.
        setData(payload);

        if (!live) {
          // Resolved from cache: the link is still down. Treating this as a
          // success is what previously pinned the poll at 10s through an
          // outage, because every failure arrived looking like a win.
          failuresRef.current += 1;
          setDegraded(true);
          const delay = backoffFor(failuresRef.current);
          log.warn('serving cached display; backing off', {
            consecutiveFailures: failuresRef.current,
            retryInMs: delay,
          });
          schedule(delay);
          return;
        }

        if (failuresRef.current > 0) {
          log.info('display connection recovered', { afterFailures: failuresRef.current });
        }
        failuresRef.current = 0;
        setDegraded(false);
        setLastSuccessAt(new Date());
        schedule(intervalMs);
      } catch {
        if (cancelled) {
          return;
        }
        failuresRef.current += 1;
        setDegraded(true);
        const delay = backoffFor(failuresRef.current);
        log.warn('display fetch failed; backing off', {
          consecutiveFailures: failuresRef.current,
          retryInMs: delay,
        });
        schedule(delay);
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [deviceId, displayKey, intervalMs]);

  return { data, degraded, lastSuccessAt };
}
