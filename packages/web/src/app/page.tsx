'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** A venue id is a UUID; anything else never reaches the API. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function VenueEntry() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleJoin(event: React.FormEvent): void {
    event.preventDefault();
    const trimmed = code.trim();

    if (trimmed === '') {
      setError('Enter the venue code to get started');
      return;
    }
    // Checked here so a typo says so immediately, rather than routing to a
    // venue page that fetches, fails, and blames the network.
    if (!UUID.test(trimmed)) {
      setError('That does not look like a venue code. Check the screen and try again.');
      return;
    }

    router.push(`/venue/${trimmed.toLowerCase()}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-5xl font-bold tracking-tight">FanBoard</h1>
          <p className="text-dark-400">Pick games. Compete. Win.</p>
        </div>

        <form onSubmit={handleJoin} className="space-y-6 rounded-xl border border-dark-700 bg-dark-800 p-8" noValidate>
          <div>
            <label htmlFor="venue-code" className="mb-2 block text-sm font-medium">
              Venue code
            </label>
            <input
              id="venue-code"
              type="text"
              value={code}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => {
                setCode(event.target.value);
                setError(null);
              }}
              className="w-full rounded-lg border border-dark-600 bg-dark-700 px-4 py-3 text-[16px] text-slate-100 placeholder-dark-500 focus:border-accent-green focus:outline-none"
            />
            {error !== null && (
              <p role="alert" className="mt-2 text-sm text-accent-red">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-accent-green py-3 font-bold text-dark-900 transition hover:brightness-110"
          >
            Join game
          </button>
        </form>

        <p className="text-center text-sm text-dark-500">
          Scan the QR code on the TV, or ask staff for the venue code.
        </p>
      </div>
    </main>
  );
}
