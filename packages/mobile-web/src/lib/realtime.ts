import { useEffect, useRef, useState } from 'react';

/**
 * Realtime connection for the patron app.
 *
 * The session cookie is HttpOnly and the browser attaches it to the WebSocket
 * handshake automatically, so no credential appears in the URL. That is not
 * incidental — a token in a query string is written to every proxy and server
 * access log on the way.
 *
 * Events are treated as invalidation hints, never as state to apply. `onEvent`
 * is expected to trigger a refetch, and `onReconnect` fires on every successful
 * connection so a client that was away reloads rather than replaying whatever
 * it missed. That is the whole "no message loss" story: the queue is the
 * database.
 */

export type RealtimeMessage =
  | { type: 'connected'; venueId: string; kind: string }
  | { type: 'game_locked'; venueId: string; gameId: string; scheduledAt: string }
  | { type: 'games_graded'; venueId: string; gameIds: string[] }
  | { type: 'leaderboard_updated'; venueId: string; period: string; leaderboard: unknown[] }
  | { type: 'display_data'; venueId: string; games: unknown[]; leaderboard: unknown[] };

export const RECONNECT_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export function reconnectDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1) - 1, RECONNECT_SCHEDULE_MS.length - 1);
  return RECONNECT_SCHEDULE_MS[index] ?? 30_000;
}

export function websocketUrl(path = '/ws'): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export interface RealtimeOptions {
  enabled?: boolean;
  onEvent?: (message: RealtimeMessage) => void;
  /** Called on every successful connection, including reconnections. */
  onReconnect?: () => void;
}

export interface RealtimeState {
  connected: boolean;
}

export function useRealtime(options: RealtimeOptions = {}): RealtimeState {
  const { enabled = true, onEvent, onReconnect } = options;
  const [connected, setConnected] = useState(false);

  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') {
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

      socket = new WebSocket(websocketUrl());

      socket.onopen = () => {
        if (cancelled) {
          return;
        }
        attempt = 0;
        setConnected(true);
        // Reload state now rather than trusting that nothing happened while
        // this client was away.
        onReconnectRef.current?.();
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
            onEventRef.current?.(parsed as RealtimeMessage);
          }
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }
        setConnected(false);
        attempt += 1;
        timer = setTimeout(connect, reconnectDelay(attempt));
      };

      socket.onerror = () => {
        // onclose always follows, which is where reconnection is handled.
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
  }, [enabled]);

  return { connected };
}
