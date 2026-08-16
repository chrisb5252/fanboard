'use client';

import { LeaderboardView } from '@/components/LeaderboardView';
import { useVenueSession } from '@/components/VenueSessionContext';

export default function LeaderboardPage() {
  const { venueId, nickname } = useVenueSession();
  return <LeaderboardView venueId={venueId} nickname={nickname} />;
}
