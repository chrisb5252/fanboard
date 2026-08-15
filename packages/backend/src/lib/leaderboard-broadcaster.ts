import { logger as rootLogger, type Logger } from './logger';
import { publish as redisPublish } from './redis';
import { REALTIME_CHANNEL, type RealtimeEvent } from './realtime';
import type { LeaderboardEntry, LeaderboardPeriod } from './leaderboard';

/**
 * Publishes realtime events.
 *
 * Everything goes through Redis rather than straight to the local socket map,
 * including events raised in this very process. Publishing locally would work
 * on one instance and silently drop half the venue's clients on two, and that
 * is exactly the bug nobody finds until the first scale-out.
 *
 * Never throws. A broadcast is a nicety on top of an action that has already
 * committed — failing the grade because a notification did not send would be
 * strictly worse than a client refreshing a few seconds later on its own.
 */

export interface BroadcasterDeps {
  publish: (channel: string, message: string) => Promise<number>;
  logger: Logger;
}

function resolveDeps(deps?: Partial<BroadcasterDeps>): BroadcasterDeps {
  return {
    publish: deps?.publish ?? redisPublish,
    logger: deps?.logger ?? rootLogger.child({ component: 'broadcaster' }),
  };
}

export async function broadcast(
  event: RealtimeEvent,
  deps?: Partial<BroadcasterDeps>,
): Promise<void> {
  const { publish, logger } = resolveDeps(deps);
  try {
    await publish(REALTIME_CHANNEL, JSON.stringify(event));
    logger.debug('published realtime event', { type: event.type, venueId: event.venueId });
  } catch (error) {
    logger.warn('failed to publish realtime event', { type: event.type, error });
  }
}

export function broadcastGameLocked(
  venueId: string,
  gameId: string,
  scheduledAt: string,
  deps?: Partial<BroadcasterDeps>,
): Promise<void> {
  return broadcast({ type: 'game_locked', venueId, gameId, scheduledAt }, deps);
}

export function broadcastGamesGraded(
  venueId: string,
  gameIds: readonly string[],
  deps?: Partial<BroadcasterDeps>,
): Promise<void> {
  return broadcast(
    { type: 'games_graded', venueId, gameIds: [...gameIds], leaderboardUpdated: true },
    deps,
  );
}

/**
 * Carries the standings inline.
 *
 * The one event that ships state rather than a bare hint, because a leaderboard
 * is small, bounded, and the whole point is that a wall of TVs updates at the
 * same instant instead of staggering across a poll window. A client that misses
 * it still refetches on reconnect.
 */
export function broadcastLeaderboard(
  venueId: string,
  period: LeaderboardPeriod,
  leaderboard: readonly LeaderboardEntry[],
  deps?: Partial<BroadcasterDeps>,
): Promise<void> {
  return broadcast(
    {
      type: 'leaderboard_updated',
      venueId,
      period,
      leaderboard: leaderboard.map((entry) => ({
        rank: entry.rank,
        nickname: entry.nickname,
        wins: entry.wins,
        losses: entry.losses,
        points: entry.points,
      })),
    },
    deps,
  );
}

export function broadcastDisplayData(
  venueId: string,
  games: unknown[],
  leaderboard: unknown[],
  refreshedAt: string,
  deps?: Partial<BroadcasterDeps>,
): Promise<void> {
  return broadcast(
    { type: 'display_data', venueId, games, leaderboard, refreshedAt },
    deps,
  );
}
