import { useEffect, useRef, useState } from 'react';
import type { DisplayPayload } from './api';
import { log } from './log';

/**
 * Realtime stream for the display.
 *
 * The display key travels as a query parameter because the browser WebSocket
 * API cannot set headers, unlike the HTTP path which puts it in `x-display-key`.
 * That is a genuine downgrade — query strings are written to proxy and server
 * access logs — and it is called out in the README rather than glossed over.
 *
 * Polling is NOT replaced. The socket makes updates immediate; the poll is what
 * makes the screen correct when the socket is down, which on a stick behind a
 * bar's wifi is not a rare case. The hook reports `streaming` so the caller can
 * back its polling off rather than switch it off.
 */

export const RECONNECT_SCHEDULE_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

export function reconnectDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1) - 1, RECONNECT_SCHEDULE_MS.length - 1);
  return RECONNECT_SCHEDULE_MS[index] ?? 30_000;
}

export function websocketUrl(displayKey: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?display_key=${encodeURIComponent(displayKey)}`;
}

export interface StreamState {
  /** Latest pushed payload, or null if nothing has arrived. */
  pushed: DisplayPayload | null;
  /** True while the socket is open. */
  streaming: boolean;
}

export interface StreamOptions {
  onDisplayData?: (payload: DisplayPayload) => void;
  /** Fires on every connect, so the caller can reload rather than replay. */
  onConnected?: () => void;
}

export function useDisplayStream(
  displayKey: string | null,
  options: StreamOptions = {},
): StreamState {
  const [pushed, setPushed] = useState<DisplayPayload | null>(null);
  const [streaming, setStreaming] = useState(false);

  const onDisplayDataRef = useRef(options.onDisplayData);
  const onConnectedRef = useRef(options.onConnected);
  onDisplayDataRef.current = options.onDisplayData;
  onConnectedRef.current = options.onConnected;

  useEffect(() => {
    if (displayKey === null || typeof WebSocket === 'undefined') {
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = (): void => {
      if (cancelled) {
        return;
      }

      socket = new WebSocket(websocketUrl(displayKey));

      socket.onopen = () => {
        if (cancelled) {
          return;
        }
        attempt = 0;
        setStreaming(true);
        log.info('realtime stream open');
        onConnectedRef.current?.();
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (parsed === null || typeof parsed !== 'object') {
            return;
          }
          const message = parsed as { type?: string } & Partial<DisplayPayload>;

          if (
            message.type === 'display_data' &&
            Array.isArray(message.games) &&
            Array.isArray(message.leaderboard)
          ) {
            const payload: DisplayPayload = {
              qrCode: message.qrCode ?? '',
              games: message.games,
              leaderboard: message.leaderboard,
              refreshedAt: message.refreshedAt ?? new Date().toISOString(),
            };
            setPushed(payload);
            onDisplayDataRef.current?.(payload);
            return;
          }

          // Anything else is a hint that the payload changed; the caller
          // refetches rather than trying to patch state from a partial event.
          if (
            message.type === 'games_graded' ||
            message.type === 'game_locked' ||
            message.type === 'leaderboard_updated'
          ) {
            onConnectedRef.current?.();
          }
        } catch {
          // A malformed frame is not worth dropping the connection for.
        }
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }
        setStreaming(false);
        attempt += 1;
        const delay = reconnectDelay(attempt);
        log.warn('realtime stream closed; reconnecting', { attempt, delay });
        timer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      socket?.close();
    };
  }, [displayKey]);

  return { pushed, streaming };
}
