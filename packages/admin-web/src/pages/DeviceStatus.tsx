import { useCallback, useEffect, useState } from 'react';
import {
  fetchDeviceStatus,
  fetchGames,
  fetchLeaderboard,
  type DeviceStatus,
  type Game,
  type LeaderboardRow,
} from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { DeviceList } from '../components/DeviceList';

const REFRESH_MS = 15_000;

export function DeviceStatusPage({ venueId }: { venueId: string }) {
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeviceStatus | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const list = await fetchDeviceStatus(venueId, signal);
        setDevices(list);
        setError(null);
      } catch (caught) {
        setError(toAdminError(caught).message);
      } finally {
        setLoading(false);
      }
    },
    [venueId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const online = devices.filter((device) => device.online).length;

  return (
    <section className="page">
      <h1 className="page__title">Device status</h1>
      <p className="page__lede">
        {online} of {devices.length} {devices.length === 1 ? 'display' : 'displays'} online. A
        display counts as offline after two minutes without a heartbeat.
      </p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="card">
        {loading ? (
          <p className="state" role="status">Loading displays…</p>
        ) : (
          <DeviceList devices={devices} onPreview={setPreview} />
        )}
      </div>

      {preview !== null && (
        <DisplayPreview venueId={venueId} device={preview} onClose={() => { setPreview(null); }} />
      )}
    </section>
  );
}

/**
 * Reconstructs what the display is showing.
 *
 * Not the device's own cached payload — that would need the display key, which
 * is shown once at pairing and stored only as a hash, so no admin route can
 * fetch it. Instead this rebuilds the payload from the same two venue-scoped
 * sources the display service itself composes, so it matches what is on the TV
 * without inventing a way to read a credential back.
 */
function DisplayPreview({
  venueId,
  device,
  onClose,
}: {
  venueId: string;
  device: DeviceStatus;
  onClose: () => void;
}) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [board, setBoard] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [nextGames, nextBoard] = await Promise.all([
          fetchGames(venueId),
          fetchLeaderboard(venueId),
        ]);
        if (!cancelled) {
          setGames(nextGames);
          setBoard(nextBoard);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(toAdminError(caught).message);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <div className="modal">
        <h2 className="card__title" id="preview-title">
          {device.displayName}
        </h2>
        <p className="hint">
          Rebuilt from this venue&rsquo;s games and today&rsquo;s leaderboard — the same sources the
          display uses. The device&rsquo;s own cached copy cannot be read back.
        </p>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {games === null || board === null ? (
          <p className="state" role="status">Loading preview…</p>
        ) : (
          <div className="preview">
            <div>
              <h3 className="preview__heading">Games ({games.length})</h3>
              <ul className="preview__list">
                {games.slice(0, 6).map((game) => (
                  <li key={game.id}>
                    <span className={`badge badge--${game.status}`}>{game.status}</span>{' '}
                    {game.homeTeam} {game.homeScore ?? ''} v {game.awayTeam} {game.awayScore ?? ''}
                  </li>
                ))}
                {games.length === 0 && <li className="muted">No games today</li>}
              </ul>
            </div>
            <div>
              <h3 className="preview__heading">Leaderboard ({board.length})</h3>
              <ul className="preview__list">
                {board.slice(0, 10).map((row) => (
                  <li key={`${row.rank}-${row.nickname}`}>
                    {row.rank}. {row.nickname} — {row.points} pts
                  </li>
                ))}
                {board.length === 0 && <li className="muted">Nobody has scored yet</li>}
              </ul>
            </div>
          </div>
        )}

        <button className="button button--ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
