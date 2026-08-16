import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchLeaderboard,
  fetchMyPicks,
  type Game,
  type LeaderboardRow,
  type MyPick,
  type PredictedWinner,
} from './lib/api';
import { clearSession, loadSession, saveSession, venueIdFromLocation } from './lib/session';
import { usePolling } from './lib/usePolling';
import { useRealtime } from './lib/realtime';
import { newlyCorrect } from './lib/gamification';
import { BottomNav, type TabId } from './components/BottomNav';
import { Celebration } from './components/Celebration';
import { StatsHeader } from './components/StatsHeader';
import { NicknameModal } from './components/NicknameModal';
import { PickConfirmation } from './components/PickConfirmation';
import { PickForm } from './components/PickForm';
import { VenueEntry } from './components/VenueEntry';
import { GamesList } from './pages/GamesList';
import { Leaderboard } from './pages/Leaderboard';
import { MyPicks } from './pages/MyPicks';

const PICKS_REFRESH_MS = 10_000;
/* Slower than picks: the header's chase line moves less often than a result. */
const BOARD_REFRESH_MS = 30_000;

interface Player {
  playerId: string;
  nickname: string;
}

export function App() {
  const stored = useMemo(() => loadSession(), []);

  const [venueId, setVenueId] = useState<string | null>(() => {
    // A scanned QR code wins over a remembered session: the person is standing
    // in a venue and that is where they mean to play.
    const fromUrl = venueIdFromLocation(window.location);
    return fromUrl ?? stored?.venueId ?? null;
  });

  const [player, setPlayer] = useState<Player | null>(() => {
    const fromUrl = venueIdFromLocation(window.location);
    if (stored === null) {
      return null;
    }
    if (fromUrl !== null && fromUrl !== stored.venueId) {
      return null;
    }
    return { playerId: stored.playerId, nickname: stored.nickname };
  });

  const [tab, setTab] = useState<TabId>('games');
  const [openGame, setOpenGame] = useState<Game | null>(null);
  const [confirmation, setConfirmation] = useState<{ game: Game; winner: PredictedWinner } | null>(
    null,
  );
  const [optimistic, setOptimistic] = useState<Map<string, PredictedWinner>>(new Map());
  const [lockedGames, setLockedGames] = useState<Set<string>>(new Set());
  const [realtimeNonce, setRealtimeNonce] = useState(0);

  const joined = venueId !== null && player !== null;

  /** Drops all local state and returns to venue entry. */
  const endSession = useCallback(() => {
    clearSession();
    setPlayer(null);
    setOpenGame(null);
    setConfirmation(null);
    setOptimistic(new Map());
  }, []);

  const picksFetcher = useCallback(
    (signal: AbortSignal) => fetchMyPicks(venueId ?? '', signal),
    [venueId],
  );

  const picksState = usePolling<MyPick[]>(picksFetcher, PICKS_REFRESH_MS, {
    enabled: joined,
    onError: (friendly) => {
      if (friendly.requiresReauth) {
        endSession();
      }
    },
  });

  /**
   * Server picks, with any not-yet-confirmed choice layered on top.
   *
   * The optimistic entry is dropped as soon as the server reports the same
   * game, so a rejected write cannot leave a phantom pick on screen for longer
   * than one poll.
   */
  const picks = useMemo<MyPick[]>(() => {
    const fromServer = picksState.data ?? [];
    if (optimistic.size === 0) {
      return fromServer;
    }

    const known = new Set(fromServer.map((pick) => pick.gameId));
    const pending: MyPick[] = [];
    for (const [gameId, winner] of optimistic) {
      if (known.has(gameId)) {
        continue;
      }
      pending.push({
        pickId: `optimistic:${gameId}`,
        gameId,
        homeTeam: '',
        awayTeam: '',
        league: '',
        scheduledAt: new Date().toISOString(),
        gameStatus: 'scheduled',
        predictedWinner: winner,
        correct: null,
        points: null,
        submittedAt: new Date().toISOString(),
        gradedAt: null,
      });
    }
    return [...fromServer, ...pending];
  }, [picksState.data, optimistic]);

  /**
   * Realtime events are hints, not state.
   *
   * Each one bumps a nonce that changes the fetchers' identity, so the polling
   * hooks reload from the API rather than trusting a payload that arrived over
   * a socket. The one exception is game_locked, which is applied immediately —
   * a patron tapping a game that just kicked off should be told before they
   * pick, not after the server rejects them.
   */
  useRealtime({
    enabled: joined,
    onReconnect: () => {
      // Everything reloads on connect, so anything missed while away is moot.
      setRealtimeNonce((value) => value + 1);
      picksState.refresh();
    },
    onEvent: (message) => {
      if (message.type === 'game_locked') {
        setLockedGames((previous) => new Set(previous).add(message.gameId));
        setRealtimeNonce((value) => value + 1);
        return;
      }
      if (message.type === 'games_graded' || message.type === 'leaderboard_updated') {
        setRealtimeNonce((value) => value + 1);
        picksState.refresh();
      }
    },
  });

  /**
   * This week's board, for the header's "who am I chasing" line.
   *
   * Fetched here rather than inside StatsHeader so the games tab and the
   * leaderboard tab do not each poll the same endpoint on their own timer.
   */
  const boardFetcher = useCallback(
    (signal: AbortSignal) => fetchLeaderboard(venueId ?? '', 'this_week', signal),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [venueId, realtimeNonce],
  );

  const boardState = usePolling<LeaderboardRow[]>(boardFetcher, BOARD_REFRESH_MS, {
    enabled: joined,
  });

  /**
   * Fires the celebration when a pick flips to correct.
   *
   * Keyed off the transition between two snapshots rather than "is any pick
   * correct", so it goes off once when the result lands and not on every poll
   * afterwards. The ref holds the previous snapshot without causing a render.
   */
  const previousPicks = useRef<MyPick[]>([]);
  const [celebrating, setCelebrating] = useState<string | null>(null);

  useEffect(() => {
    const settled = picksState.data ?? [];
    const wins = newlyCorrect(previousPicks.current, settled);
    previousPicks.current = settled;
    if (wins.length > 0) {
      setCelebrating(wins.join(','));
    }
  }, [picksState.data]);

  const handleSubmitted = useCallback(
    (game: Game, winner: PredictedWinner) => {
      setOptimistic((previous) => new Map(previous).set(game.id, winner));
      setOpenGame(null);
      setConfirmation({ game, winner });
      // Pull the authoritative row promptly rather than waiting out the poll.
      picksState.refresh();
    },
    [picksState],
  );

  if (venueId === null) {
    return <VenueEntry onVenueChosen={setVenueId} />;
  }

  if (player === null) {
    return (
      <NicknameModal
        venueId={venueId}
        onJoined={(joinedPlayer) => {
          setPlayer(joinedPlayer);
          saveSession({ venueId, ...joinedPlayer });
        }}
        onCancel={() => {
          setVenueId(null);
          clearSession();
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="brand brand--small" aria-hidden="true">
          FB
        </span>
        <span className="app__title">FanBoard</span>
        <span className="app__player">{player.nickname}</span>
      </header>

      <main className="app__main">
        {tab === 'games' && (
          <GamesList
            venueId={venueId}
            picks={picks}
            refreshNonce={realtimeNonce}
            lockedGames={lockedGames}
            onSelectGame={setOpenGame}
            onSessionExpired={endSession}
            header={
              <StatsHeader
                nickname={player.nickname}
                picks={picks}
                board={boardState.data ?? []}
              />
            }
          />
        )}
        {tab === 'picks' && (
          <MyPicks picks={picks} loading={picksState.loading} error={picksState.error} />
        )}
        {tab === 'leaderboard' && (
          <Leaderboard
            venueId={venueId}
            nickname={player.nickname}
            refreshNonce={realtimeNonce}
          />
        )}
      </main>

      <BottomNav active={tab} onChange={setTab} />

      <Celebration trigger={celebrating} />

      {openGame !== null && (
        <PickForm
          venueId={venueId}
          game={openGame}
          existingPick={picks.find((pick) => pick.gameId === openGame.id)?.predictedWinner}
          onSubmitted={(winner) => {
            handleSubmitted(openGame, winner);
          }}
          onClose={() => {
            setOpenGame(null);
          }}
          onSessionExpired={endSession}
        />
      )}

      {confirmation !== null && (
        <PickConfirmation
          game={confirmation.game}
          winner={confirmation.winner}
          onBack={() => {
            setConfirmation(null);
          }}
        />
      )}
    </div>
  );
}
