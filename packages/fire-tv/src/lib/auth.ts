/**
 * Display credentials.
 *
 * Two corrections to the obvious approach, both worth understanding before
 * changing anything here.
 *
 * 1. The variable is VITE_DISPLAY_KEY, not REACT_APP_DISPLAY_KEY. This app is
 *    built by Vite, which only exposes variables prefixed `VITE_` and only via
 *    `import.meta.env`. A REACT_APP_* variable is silently undefined — the app
 *    would build cleanly and then fail every request at runtime.
 *
 * 2. A build-time variable is INLINED INTO THE BUNDLE. Vite substitutes the
 *    literal string at build, so the key ends up in dist/assets/*.js in plain
 *    text, readable by anyone who can fetch the bundle, and rotating it needs a
 *    rebuild and redeploy.
 *
 *    For that reason the runtime path is preferred: provision the device once
 *    and the key is kept in localStorage. That keeps it out of the bundle, lets
 *    an operator rotate it by re-pairing, and matches how the pairing endpoint
 *    already works (it returns the key exactly once). The env var remains as a
 *    build-time fallback for a kiosk image where that is simpler.
 */

const DEVICE_STORAGE_KEY = 'fanboard.tv.device';

export interface DisplayCredentials {
  deviceId: string;
  displayKey: string;
}

function readEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readProvisioned(): DisplayCredentials | null {
  try {
    const raw = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const deviceId = candidate['deviceId'];
    const displayKey = candidate['displayKey'];
    if (typeof deviceId !== 'string' || typeof displayKey !== 'string') {
      return null;
    }
    if (deviceId.trim() === '' || displayKey.trim() === '') {
      return null;
    }
    return { deviceId: deviceId.trim(), displayKey: displayKey.trim() };
  } catch {
    return null;
  }
}

/**
 * Resolves credentials, runtime provisioning first.
 *
 * Returns null when the device has not been set up. The caller shows a pairing
 * screen rather than hammering the API with requests that cannot succeed.
 */
export function getCredentials(): DisplayCredentials | null {
  const provisioned = readProvisioned();
  if (provisioned !== null) {
    return provisioned;
  }

  const deviceId = readEnv('VITE_DEVICE_ID');
  const displayKey = readEnv('VITE_DISPLAY_KEY');
  if (deviceId === undefined || displayKey === undefined) {
    return null;
  }
  return { deviceId, displayKey };
}

export function provisionDevice(credentials: DisplayCredentials): void {
  window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(credentials));
}

export function clearProvisioning(): void {
  window.localStorage.removeItem(DEVICE_STORAGE_KEY);
}

/**
 * A redacted form for logs and the setup screen.
 *
 * The full key is never logged and never rendered. This exists so an operator
 * standing at the TV can confirm *which* key is loaded without the key being
 * readable by the room.
 */
export function keyFingerprint(displayKey: string): string {
  if (displayKey.length <= 4) {
    return '••••';
  }
  return `••••${displayKey.slice(-4)}`;
}
