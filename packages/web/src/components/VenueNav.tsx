'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { slug: '', label: 'Games' },
  { slug: '/leaderboard', label: 'Board' },
  { slug: '/my-picks', label: 'My Picks' },
  { slug: '/profile', label: 'Profile' },
] as const;

/**
 * Venue navigation.
 *
 * Scrolls horizontally rather than wrapping on a narrow phone, and marks the
 * active link with aria-current so it is not signalled by colour alone.
 */
export function VenueNav({ venueId, nickname }: { venueId: string; nickname?: string }) {
  const pathname = usePathname();
  const base = `/venue/${venueId}`;

  return (
    <nav className="sticky top-0 z-10 border-b border-dark-700 bg-dark-800/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <Link href={base} className="shrink-0 text-lg font-bold">
          FanBoard
        </Link>
        {nickname !== undefined && (
          <span className="ml-auto max-w-[35%] truncate text-sm text-dark-400">{nickname}</span>
        )}
      </div>
      <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 pb-2">
        {LINKS.map((link) => {
          const href = `${base}${link.slug}`;
          const active = pathname === href;
          return (
            <Link
              key={link.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition ${
                active
                  ? 'bg-accent-green text-dark-900'
                  : 'text-dark-400 hover:bg-dark-700 hover:text-slate-100'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
