import { useEffect } from 'react';
import { clearApiKey, fetchSession, readApiKey } from './lib/api';
import { useAdminStore } from './lib/store';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';

export function App() {
  const session = useAdminStore((state) => state.session);
  const restoring = useAdminStore((state) => state.restoring);
  const setSession = useAdminStore((state) => state.setSession);
  const setRestoring = useAdminStore((state) => state.setRestoring);
  const signOut = useAdminStore((state) => state.signOut);

  /**
   * Re-validate a stored key on boot.
   *
   * A reload should not force a re-login, but the key in sessionStorage is not
   * proof of anything — it may have been rotated or revoked since. The console
   * only renders once the server confirms it.
   */
  useEffect(() => {
    if (session !== null || readApiKey() === null) {
      setRestoring(false);
      return;
    }

    let cancelled = false;
    const restore = async (): Promise<void> => {
      try {
        const next = await fetchSession();
        if (!cancelled) {
          setSession(next);
        }
      } catch {
        if (!cancelled) {
          clearApiKey();
          signOut();
        }
      } finally {
        if (!cancelled) {
          setRestoring(false);
        }
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [session, setSession, setRestoring, signOut]);

  if (restoring) {
    return (
      <main className="login">
        <p className="state" role="status">
          Signing in…
        </p>
      </main>
    );
  }

  return session === null ? <LoginPage /> : <Dashboard />;
}
