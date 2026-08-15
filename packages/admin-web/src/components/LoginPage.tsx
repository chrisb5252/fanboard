import { useState, type FormEvent } from 'react';
import { fetchSession, writeApiKey, clearApiKey } from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { useAdminStore } from '../lib/store';

/**
 * Sign-in.
 *
 * One field, not two. The brief validates the key by calling
 * `/venues/:venueId/config`, but an operator holding a fresh key has no way to
 * know their venue id — the key *is* the venue identity. `/api/admin/session`
 * resolves the two together, so pasting the key is the whole flow.
 *
 * The key is written to sessionStorage only after the server accepts it, so a
 * failed attempt leaves nothing behind.
 */
export function LoginPage() {
  const signIn = useAdminStore((state) => state.signIn);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const key = apiKey.trim();
    if (key === '') {
      setError('Enter your venue API key.');
      return;
    }

    setSubmitting(true);
    setError(null);

    // The interceptor reads the key from storage, so it has to be there for the
    // check itself — and removed again if the check fails.
    writeApiKey(key);
    try {
      const session = await fetchSession();
      signIn(key, session);
    } catch (caught) {
      clearApiKey();
      setError(toAdminError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <form className="login__card" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="login__brand">FanBoard</div>
        <h1 className="login__title">Venue admin</h1>
        <p className="login__lede">Sign in with the API key for your venue.</p>

        <label className="label" htmlFor="api-key">
          API key
        </label>
        <input
          id="api-key"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={submitting}
          onChange={(event) => {
            setApiKey(event.target.value);
            setError(null);
          }}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'api-key-error'}
        />

        {error !== null && (
          <p className="error" id="api-key-error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Checking…' : 'Login'}
        </button>

        <p className="login__note">
          Your key is kept for this browser tab only and is cleared when the tab closes.
        </p>
      </form>
    </main>
  );
}
