/**
 * Non-secret session context, persisted so a refresh does not eject the player.
 *
 * The session TOKEN is not here and must never be. It lives in an HttpOnly
 * cookie the browser manages; copying it into localStorage would expose it to
 * any XSS on the page and defeat the flag entirely. What is stored is only what
 * is already visible on screen: which venue, which player, what nickname.
 *
 * The cookie and this record can therefore fall out of step — the cookie can
 * expire while this remains. That is handled where it should be: an API call
 * returns 401, and the app clears this and sends the player back to entry.
 */

const STORAGE_KEY = 'fanboard.session';

export interface StoredSession {
  venueId: string;
  playerId: string;
  nickname: string;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['venueId'] === 'string' &&
    typeof candidate['playerId'] === 'string' &&
    typeof candidate['nickname'] === 'string'
  );
}

export function loadSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    // Private browsing, disabled storage, or a corrupted entry. None of these
    // should stop the app booting.
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable; the app still works for this page view.
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/**
 * Reads the venue from the QR code's URL.
 *
 * Accepts both `?venue=<id>` and the `/v/<id>` path the TV renders, so one
 * scanned code works whichever shape the display was built with.
 */
export function venueIdFromLocation(location: { search: string; pathname: string }): string | null {
  const fromQuery = new URLSearchParams(location.search).get('venue');
  if (fromQuery !== null && isUuid(fromQuery)) {
    return fromQuery.trim().toLowerCase();
  }

  const fromPath = /\/v\/([0-9a-f-]{36})/i.exec(location.pathname);
  const candidate = fromPath?.[1];
  if (candidate !== undefined && isUuid(candidate)) {
    return candidate.toLowerCase();
  }

  return null;
}
