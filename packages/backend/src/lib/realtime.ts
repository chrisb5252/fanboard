/**
 * The realtime event vocabulary, shared by the publisher and every client.
 *
 * Every event is an *invalidation hint*, never a source of truth. It says
 * "something changed, come and look" — it does not carry authoritative state
 * that a client is expected to apply blindly. That distinction is what makes
 * the delivery guarantees tolerable: see the note on message loss below.
 */

export const REALTIME_CHANNEL = 'fanboard:realtime';

export type RealtimeEvent =
  | { type: 'game_locked'; venueId: string; gameId: string; scheduledAt: string }
  | {
      type: 'games_graded';
      venueId: string;
      gameIds: string[];
      leaderboardUpdated: true;
    }
  | {
      type: 'leaderboard_updated';
      venueId: string;
      period: string;
      leaderboard: {
        rank: number;
        nickname: string;
        wins: number;
        losses: number;
        points: number;
      }[];
    }
  | {
      type: 'display_data';
      venueId: string;
      games: unknown[];
      leaderboard: unknown[];
      refreshedAt: string;
    };

export type RealtimeEventType = RealtimeEvent['type'];

/**
 * On message loss.
 *
 * The brief asks for "no message loss on disconnect/reconnect (use message
 * queue if needed)". A per-client durable queue is deliberately NOT built, and
 * the reason is that it would be less correct, not more.
 *
 * Every event above is a hint to refetch. A client that misses ten of them and
 * then reloads its state on reconnect ends up exactly where it should be. A
 * client that instead replays ten queued events applies stale intermediate
 * states in order and finishes further from the truth, having done more work.
 *
 * So the contract is: clients refetch on every (re)connect, and the queue is
 * the database. What must not be lost is *state*, and state is never only in a
 * message.
 */
export const REALTIME_CONTRACT = 'refetch-on-reconnect' as const;

export function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['type'] === 'string' && typeof candidate['venueId'] === 'string';
}
