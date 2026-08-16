'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * Polling fetch with the sharp edges filed off.
 *
 * The brief's version has three problems that only appear once it is running,
 * so they are worth naming:
 *
 *  1. `fetcher` in the dependency array re-runs the effect on every render
 *     unless the caller wrapped it in useCallback — which is easy to forget and
 *     produces an infinite request loop rather than a visible error.
 *  2. `setLoading(true)` on every tick blanks the screen every ten seconds. It
 *     is only true for the first load here; a refresh leaves the old data up.
 *  3. No abort. A slow response arriving after the component unmounted sets
 *     state on a dead component, and switching venues can leave the previous
 *     venue's data on screen.
 *
 * It also pauses while the tab is hidden. A phone in a pocket has no reason to
 * poll, and a bar full of them adds up.
 */
export interface PollingState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True when the session expired; the caller should send them back to join. */
  needsRejoin: boolean;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs = 10_000,
  options: { enabled?: boolean } = {},
): PollingState<T> {
  const { enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsRejoin, setNeedsRejoin] = useState(false);
  const [tick, setTick] = useState(0);

  // Held in a ref so a caller who did not memoise their fetcher does not cause
  // the effect to re-run on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const next = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(next);
        setError(null);
        setNeedsRejoin(false);
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        if (caught instanceof ApiError) {
          setError(caught.message);
          setNeedsRejoin(caught.requiresRejoin);
        } else {
          setError('Something went wrong. Please try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, intervalMs);

    // Catch up immediately when the player comes back, rather than making them
    // wait out the rest of the interval.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, tick]);

  return { data, loading, error, needsRejoin, refresh };
}

const STORAGE_KEY = 'fanboard.session';

export interface StoredSession {
  venueId: string;
  playerId: string;
  nickname: string;
}

/**
 * Remembers who this browser is, so a reload does not force a rejoin.
 *
 * The real credential is the httpOnly cookie — this is only the display name
 * and venue, which the UI needs and cannot read from the cookie. Losing it
 * costs a rejoin, nothing more.
 */
export function useSession(venueId: string): {
  session: StoredSession | null;
  save: (session: StoredSession) => void;
  clear: () => void;
  ready: boolean;
} {
  const [session, setSession] = useState<StoredSession | null>(null);
  // localStorage is unavailable during the server render, so the first client
  // pass reads it and flips `ready`. Without this the join screen flashes for
  // players who are already in.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw === null ? null : (JSON.parse(raw) as StoredSession);
      setSession(parsed !== null && parsed.venueId === venueId ? parsed : null);
    } catch {
      setSession(null);
    } finally {
      setReady(true);
    }
  }, [venueId]);

  const save = useCallback((next: StoredSession) => {
    setSession(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing can refuse writes. The session still works for this
      // tab; it just will not survive a reload.
    }
  }, []);

  const clear = useCallback(() => {
    setSession(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do.
    }
  }, []);

  return { session, save, clear, ready };
}

/** Ticks once a second, for countdowns. */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
