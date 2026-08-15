import { useCallback, useEffect, useRef, useState } from 'react';
import { toFriendlyError, type FriendlyError } from './error-handler';

export interface PollingState<T> {
  data: T | null;
  error: FriendlyError | null;
  /** True only on the first load, so a refresh does not blank the screen. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetches on mount and on an interval.
 *
 * Three details that matter on a phone in a bar:
 *
 *  - `loading` is true only for the very first load. A poll that flipped it back
 *    on would blank the list every few seconds.
 *  - The previous data survives a failed refresh. A momentary drop in signal
 *    should not erase the scoreboard someone is reading.
 *  - Polling pauses while the tab is hidden. A phone in a pocket has no reason
 *    to keep the radio busy, and it resumes with an immediate fetch so the
 *    screen is current the instant it is looked at again.
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  options: { enabled?: boolean; onError?: (error: FriendlyError) => void } = {},
): PollingState<T> {
  const { enabled = true, onError } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(true);

  // onError is held in a ref so an inline callback does not restart the
  // interval on every render. `fetcher` deliberately is NOT: it closes over the
  // query being made, so a changed fetcher must refetch immediately. Holding it
  // in a ref made the leaderboard period tabs look dead for up to ten seconds —
  // the ref updated, but nothing asked it for new data until the next tick.
  // Call sites therefore have to memoise their fetcher, which they do.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const next = await fetcher(controller.signal);
        if (cancelled) {
          return;
        }
        setData(next);
        setError(null);
      } catch (caught) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        const friendly = toFriendlyError(caught);
        setError(friendly);
        onErrorRef.current?.(friendly);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void run();
      }
    }, intervalMs);

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, tick, fetcher]);

  return { data, error, loading, refresh };
}
