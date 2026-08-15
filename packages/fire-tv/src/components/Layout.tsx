import type { DisplayPayload } from '../lib/api';
import { useRotation, type Zone } from '../lib/rotation';
import { LeaderboardZone } from './LeaderboardZone';
import { QrPanel } from './QrPanel';
import { Scoreboard } from './Scoreboard';

/**
 * Three zones, one screen.
 *
 * The brief describes the QR both as a persistent bottom zone and as a 5-second
 * rotation slot. Those conflict, so it is both: a permanent footer strip that is
 * never absent, plus a full-screen takeover in its rotation slot.
 *
 * The reason to keep it permanent is the product's whole funnel. At 5 seconds
 * out of a 35-second cycle the code is off screen 86% of the time, so most of
 * the room would never see it — and a patron who cannot join is worth nothing
 * to the venue.
 */
export interface LayoutProps {
  payload: DisplayPayload;
  degraded: boolean;
  lastSuccessAt: Date | null;
}

function stalenessLabel(lastSuccessAt: Date | null): string | null {
  if (lastSuccessAt === null) {
    return null;
  }
  const minutes = Math.floor((Date.now() - lastSuccessAt.getTime()) / 60_000);
  // Under two minutes is just the poll cadence, not worth mentioning.
  return minutes < 2 ? null : `Updated ${minutes}m ago`;
}

export function Layout({ payload, degraded, lastSuccessAt }: LayoutProps) {
  const available: Record<Zone, boolean> = {
    scoreboard: payload.games.length > 0,
    leaderboard: payload.leaderboard.length > 0,
    qr: payload.qrCode !== '',
  };

  const zone = useRotation(available);
  const staleness = degraded ? stalenessLabel(lastSuccessAt) : null;

  return (
    <div className="tv">
      <main className="tv__main">
        {zone === 'scoreboard' && <Scoreboard games={payload.games} />}
        {zone === 'leaderboard' && <LeaderboardZone entries={payload.leaderboard} />}
        {zone === 'qr' && <QrPanel url={payload.qrCode} variant="full" />}
      </main>

      <footer className="tv__footer">
        <QrPanel url={payload.qrCode} variant="strip" />
        {/*
          Not an error message. A muted timestamp so staff can tell at a glance
          that the board is stale; a patron reads it as nothing at all.
        */}
        {staleness !== null && <span className="tv__stale">{staleness}</span>}
      </footer>
    </div>
  );
}
