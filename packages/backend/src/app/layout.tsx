import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Root layout. Deliberately free of side effects.
 *
 * Background workers are started from `src/instrumentation.ts`, not from here:
 * this component is evaluated during static prerendering at build time and
 * again on every request, neither of which is "server startup".
 */

export const metadata: Metadata = {
  title: 'FanBoard API',
  description: 'FanBoard backend — venue-hosted live sports prediction game',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
