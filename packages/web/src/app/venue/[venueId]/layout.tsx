'use client';

import { use } from 'react';
import { JoinGate } from '@/components/JoinGate';
import { VenueNav } from '@/components/VenueNav';
import { VenueSessionProvider } from '@/components/VenueSessionContext';

/**
 * Everything under a venue needs a session, so the gate lives once here rather
 * than in each of the four screens. The nav renders inside the gate: there is
 * nothing to navigate to until you have joined.
 *
 * `params` is a Promise in Next 16 — `use()` unwraps it in a client component.
 */
export default function VenueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ venueId: string }>;
}) {
  const { venueId } = use(params);

  return (
    <JoinGate venueId={venueId}>
      {(session, onExpired) => (
        <VenueSessionProvider value={{ venueId, nickname: session.nickname, onExpired }}>
          <VenueNav venueId={venueId} nickname={session.nickname} />
          <main>{children}</main>
        </VenueSessionProvider>
      )}
    </JoinGate>
  );
}
