'use client';

import { GamesList } from '@/components/GamesList';
import { useVenueSession } from '@/components/VenueSessionContext';

export default function GamesPage() {
  const { venueId, nickname } = useVenueSession();
  return <GamesList venueId={venueId} nickname={nickname} />;
}
