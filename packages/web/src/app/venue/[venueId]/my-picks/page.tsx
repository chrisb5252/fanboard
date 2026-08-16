'use client';

import { api } from '@/lib/api';
import { usePolling } from '@/lib/hooks';
import { MyPicksList } from '@/components/MyPicksList';
import { useVenueSession } from '@/components/VenueSessionContext';
import type { MyPick } from '@/lib/types';

export default function MyPicksPage() {
  const { venueId, onExpired } = useVenueSession();
  const picks = usePolling<MyPick[]>((signal) => api.getMyPicks(venueId, signal), 10_000);

  // A reaped or expired session should return the player to the join screen
  // rather than leaving them on a permanently empty list.
  if (picks.needsRejoin) {
    onExpired();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">My Picks</h1>
      {picks.loading ? (
        <p className="p-8 text-center text-dark-400">Loading…</p>
      ) : (
        <MyPicksList picks={picks.data ?? []} />
      )}
    </div>
  );
}
