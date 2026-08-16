'use client';

import { PlayerProfile } from '@/components/PlayerProfile';
import { useVenueSession } from '@/components/VenueSessionContext';

export default function ProfilePage() {
  const { venueId, nickname } = useVenueSession();
  return <PlayerProfile venueId={venueId} nickname={nickname} />;
}
