import type { Metadata, Viewport } from 'next';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'FanBoard — Pick Games, Compete, Win',
  description: 'Join friends, pick game winners, earn points, climb the leaderboard.',
};

export const viewport: Viewport = {
  // The app is used one-handed on a phone; zoom stays enabled because
  // disabling it is an accessibility failure, not a polish detail.
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-dark-900 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
