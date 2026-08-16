'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The joined player, shared with every screen under a venue.
 *
 * Context rather than props because the nickname is needed three levels down —
 * to highlight your own row on the board, to title the profile — and threading
 * it through each page component would mean every page taking a prop it does
 * not itself use.
 */
export interface VenueSession {
  venueId: string;
  nickname: string;
  /** Clears the stored session, sending the player back to the join screen. */
  onExpired: () => void;
}

const Context = createContext<VenueSession | null>(null);

export function VenueSessionProvider({
  value,
  children,
}: {
  value: VenueSession;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useVenueSession(): VenueSession {
  const session = useContext(Context);
  if (session === null) {
    // Throwing beats returning a default: a screen rendered outside the venue
    // layout would otherwise silently show an empty nickname and never match
    // the player's own row on the leaderboard.
    throw new Error('useVenueSession must be used inside a venue layout');
  }
  return session;
}
