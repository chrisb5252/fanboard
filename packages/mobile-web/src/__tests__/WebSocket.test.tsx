import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  RECONNECT_SCHEDULE_MS,
  reconnectDelay,
  useRealtime,
  websocketUrl,
  type RealtimeMessage,
} from '../lib/realtime';

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  emit(message: RealtimeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

function installFakeSocket(): void {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
}

function Probe({ onEvent, onReconnect }: { onEvent?: (m: RealtimeMessage) => void; onReconnect?: () => void }) {
  const { connected } = useRealtime({ onEvent, onReconnect });
  return <span data-testid="status">{connected ? 'connected' : 'disconnected'}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('websocketUrl', () => {
  it('matches the page origin so the cookie is in scope', () => {
    // The session cookie is HttpOnly; it rides the handshake only because the
    // socket is same-origin. A different host would silently lose auth.
    expect(websocketUrl()).toBe(`ws://${window.location.host}/ws`);
  });

  it('carries no credential in the URL', () => {
    expect(websocketUrl()).not.toMatch(/token|key=/i);
  });
});

describe('reconnect backoff', () => {
  it('climbs and then holds', () => {
    expect(reconnectDelay(1)).toBe(1_000);
    expect(reconnectDelay(2)).toBe(2_000);
    expect(reconnectDelay(3)).toBe(4_000);
    expect(reconnectDelay(99)).toBe(30_000);
    expect(Math.max(...RECONNECT_SCHEDULE_MS)).toBe(30_000);
  });
});

describe('useRealtime', () => {
  it('establishes a connection', async () => {
    installFakeSocket();
    render(<Probe />);

    expect(FakeSocket.instances).toHaveLength(1);
    act(() => {
      FakeSocket.instances[0]!.open();
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('connected');
    });
  });

  it('reloads state on every connection, which is the no-loss contract', async () => {
    installFakeSocket();
    const onReconnect = vi.fn();
    render(<Probe onReconnect={onReconnect} />);

    act(() => {
      FakeSocket.instances[0]!.open();
    });
    await waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces a game_locked event', async () => {
    installFakeSocket();
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);

    act(() => {
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.emit({
        type: 'game_locked',
        venueId: 'v1',
        gameId: 'g1',
        scheduledAt: '2025-01-19T18:00:00Z',
      });
    });

    await waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'game_locked', gameId: 'g1' }),
      );
    });
  });

  it('surfaces leaderboard_updated so the caller can refresh', async () => {
    installFakeSocket();
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);

    act(() => {
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.emit({
        type: 'leaderboard_updated',
        venueId: 'v1',
        period: 'today',
        leaderboard: [],
      });
    });

    await waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'leaderboard_updated' }),
      );
    });
  });

  it('ignores a malformed frame rather than dropping the connection', async () => {
    installFakeSocket();
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);

    act(() => {
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.emitRaw('{not json');
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('connected');
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reconnects after a drop, with backoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFakeSocket();
    render(<Probe />);

    act(() => {
      FakeSocket.instances[0]!.open();
    });
    act(() => {
      FakeSocket.instances[0]!.close();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('disconnected');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('closes the socket on unmount rather than leaking it', () => {
    installFakeSocket();
    const view = render(<Probe />);
    act(() => {
      FakeSocket.instances[0]!.open();
    });
    view.unmount();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });
});
