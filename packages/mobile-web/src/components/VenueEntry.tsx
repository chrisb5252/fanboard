import { useState, type FormEvent } from 'react';
import { isUuid } from '../lib/session';

export interface VenueEntryProps {
  /** Prefilled when the QR code carried a venue id. */
  initialVenueId?: string;
  onVenueChosen: (venueId: string) => void;
}

export function VenueEntry({ initialVenueId = '', onVenueChosen }: VenueEntryProps) {
  const [venueId, setVenueId] = useState(initialVenueId);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = venueId.trim();

    if (trimmed === '') {
      setError('Enter the venue code from your table or the TV.');
      return;
    }
    if (!isUuid(trimmed)) {
      setError('That code does not look right. Check it and try again.');
      return;
    }

    setError(null);
    onVenueChosen(trimmed.toLowerCase());
  }

  return (
    <main className="screen screen--center">
      <div className="brand" aria-hidden="true">
        FB
      </div>
      <h1 className="title">FanBoard</h1>
      <p className="lede">Scan the QR code on the TV, or enter the venue code below.</p>

      <form className="stack" onSubmit={handleSubmit} noValidate>
        <label className="label" htmlFor="venue-id">
          Venue code
        </label>
        <input
          id="venue-id"
          className="input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="00000000-0000-0000-0000-000000000000"
          value={venueId}
          onChange={(event) => {
            setVenueId(event.target.value);
            setError(null);
          }}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'venue-error'}
        />
        {error !== null && (
          <p className="error" id="venue-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button--primary" type="submit">
          Enter
        </button>
      </form>
    </main>
  );
}
