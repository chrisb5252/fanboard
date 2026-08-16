'use client';

import { use } from 'react';
import { PredictionForm } from '@/components/PredictionForm';
import { useVenueSession } from '@/components/VenueSessionContext';

export default function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = use(params);
  const { venueId } = useVenueSession();
  return <PredictionForm venueId={venueId} gameId={gameId} />;
}
