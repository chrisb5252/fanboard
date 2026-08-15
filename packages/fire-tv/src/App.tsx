import { useMemo } from 'react';
import { getCredentials, keyFingerprint } from './lib/auth';
import { useAutoRefresh } from './lib/reconnect';
import { Layout } from './components/Layout';

/**
 * The whole app: resolve credentials, poll, render.
 *
 * No routing, no state library, no interactivity. A Fire TV stick has no
 * pointer and this screen is never touched — it is a display, and every
 * abstraction it does not carry is CPU it does not spend.
 */
export function App() {
  const credentials = useMemo(() => getCredentials(), []);

  const { data, degraded, lastSuccessAt } = useAutoRefresh(
    credentials?.deviceId ?? null,
    credentials?.displayKey ?? null,
  );

  if (credentials === null) {
    return (
      <div className="tv tv--setup">
        <div className="setup">
          <div className="setup__brand">FanBoard</div>
          <h1 className="setup__title">This display is not paired</h1>
          <p className="setup__body">
            Pair it from the venue admin, then set VITE_DEVICE_ID and VITE_DISPLAY_KEY,
            or provision the device at runtime.
          </p>
        </div>
      </div>
    );
  }

  if (data === null) {
    // First load, nothing cached. A holding screen, never an error: the room
    // should see the brand, not a failure they cannot act on.
    return (
      <div className="tv tv--setup">
        <div className="setup">
          <div className="setup__brand">FanBoard</div>
          <p className="setup__body">Connecting…</p>
          <p className="setup__fingerprint">Display {keyFingerprint(credentials.displayKey)}</p>
        </div>
      </div>
    );
  }

  return <Layout payload={data} degraded={degraded} lastSuccessAt={lastSuccessAt} />;
}
