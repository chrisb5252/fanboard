/**
 * Resolving the client IP for rate limiting.
 *
 * This is the security-critical half of an IP rate limiter, and the obvious
 * implementation is worthless. `X-Forwarded-For` is a request header: anyone can
 * send one. Taking its leftmost value — the usual "get the real client IP"
 * recipe — means an attacker sets a different value on every request and the
 * limiter counts to one, forever.
 *
 * The only defensible reading is positional. A reverse proxy *appends* the
 * address it saw to XFF, so with exactly one trusted proxy in front, the
 * rightmost entry is the one our own infrastructure wrote and everything to its
 * left is attacker-supplied noise. TRUSTED_PROXY_HOPS says how many proxies
 * append, and we count in from the right by that many.
 *
 * Set TRUSTED_PROXY_HOPS to match the deployment. Too high and an attacker's
 * forged entries start counting; too low and every client behind the last proxy
 * shares a bucket.
 */

/** Number of proxies that append to X-Forwarded-For before we see it. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

export function trustedProxyHops(): number {
  const raw = process.env['TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return parsed;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_CHARS = /^[0-9a-f:]+$/i;

function isIpv4(value: string): boolean {
  const match = IPV4.exec(value);
  if (match === null) {
    return false;
  }
  return match.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === String(Number(octet));
  });
}

/**
 * Expands an IPv6 address to its eight groups.
 *
 * Returns null for anything malformed, so a hostile header value can never
 * become part of a Redis key.
 */
function expandIpv6(input: string): string[] | null {
  if (input.length > 45) {
    return null;
  }

  // "::ffff:203.0.113.7" embeds a dotted quad in the last 32 bits. Fold it into
  // two hex groups before the rest of the parser, which only speaks hex.
  let value = input;
  const embedded = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(input);
  if (embedded !== null) {
    const [, prefix = '', quad = ''] = embedded;
    if (!isIpv4(quad)) {
      return null;
    }
    const [a = '0', b = '0', c = '0', d = '0'] = quad.split('.');
    const high = (Number(a) << 8) | Number(b);
    const low = (Number(c) << 8) | Number(d);
    value = `${prefix}${high.toString(16)}:${low.toString(16)}`;
  }

  if (!IPV6_CHARS.test(value)) {
    return null;
  }

  const doubleColons = value.split('::').length - 1;
  if (doubleColons > 1) {
    return null;
  }

  let groups: string[];
  if (doubleColons === 1) {
    const [head = '', tail = ''] = value.split('::');
    const headGroups = head === '' ? [] : head.split(':');
    const tailGroups = tail === '' ? [] : tail.split(':');
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) {
      return null;
    }
    groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  } else {
    groups = value.split(':');
  }

  if (groups.length !== 8) {
    return null;
  }
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  return groups.map((group) => group.toLowerCase());
}

/**
 * Normalises an address into a rate-limit bucket.
 *
 * IPv6 collapses to its /64 prefix. A single residential IPv6 allocation is a
 * /64 or larger, so limiting per full address would let one attacker walk
 * through 18 quintillion "distinct clients" without leaving their own subnet.
 * The /64 is the smallest unit that actually corresponds to one subscriber.
 */
export function normaliseIp(value: string): string | null {
  let candidate = value.trim();
  if (candidate === '') {
    return null;
  }

  // "[2001:db8::1]:443" and "1.2.3.4:443" both appear in the wild.
  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close === -1) {
      return null;
    }
    candidate = candidate.slice(1, close);
  } else if ((candidate.match(/:/gu) ?? []).length === 1) {
    const [host] = candidate.split(':');
    candidate = host ?? candidate;
  }

  if (isIpv4(candidate)) {
    return candidate;
  }

  const groups = expandIpv6(candidate);
  if (groups === null) {
    return null;
  }

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) arrives already expanded; treat the
  // low 32 bits as the v4 address it is.
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6] ?? '0', 16);
    const low = Number.parseInt(groups[7] ?? '0', 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  return `${groups.slice(0, 4).join(':')}::/64`;
}

export interface ClientIpResult {
  /** The rate-limit bucket, or null when no address could be trusted. */
  readonly ip: string | null;
  /** Why, for logging. */
  readonly source: 'x-forwarded-for' | 'cf-connecting-ip' | 'x-real-ip' | 'none';
}

/**
 * Resolves the client IP, or null when it cannot be trusted.
 *
 * Null is not "allow everything" — it is a signal the caller must decide about.
 * See the players route for what it does with it.
 */
export function getClientIpDetailed(request: Request): ClientIpResult {
  const hops = trustedProxyHops();

  // No proxy in front means no header can be believed: the client is speaking
  // to us directly and controls everything it sends.
  if (hops === 0) {
    return { ip: null, source: 'none' };
  }

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');

    if (parts.length > 0) {
      // Count in from the right by the number of appending proxies. Clamped,
      // so a chain shorter than configured falls back to its leftmost entry
      // rather than reading off the end.
      const index = Math.max(0, parts.length - hops);
      const candidate = parts[index];
      const normalised = candidate === undefined ? null : normaliseIp(candidate);
      if (normalised !== null) {
        return { ip: normalised, source: 'x-forwarded-for' };
      }
    }
  }

  // Single-value headers, consulted only after X-Forwarded-For and only once
  // the hops check above has established that a proxy is in front. Both are set
  // by overwriting rather than appending, so they carry no attacker-controlled
  // prefix — but that is only true of the proxy that actually sets them.
  //
  // A deployment NOT behind Cloudflare must not reach cf-connecting-ip with an
  // attacker-supplied value. In practice it does not: any real proxy sets
  // X-Forwarded-For, which is preferred above, so this is reached only when the
  // fronting proxy sets neither — a topology where nothing is trustworthy
  // anyway. Ordering is what makes it safe, not the header itself.
  for (const header of ['cf-connecting-ip', 'x-real-ip'] as const) {
    const value = request.headers.get(header);
    if (value !== null && value.trim() !== '') {
      const normalised = normaliseIp(value);
      if (normalised !== null) {
        return { ip: normalised, source: header };
      }
    }
  }

  return { ip: null, source: 'none' };
}

/** Convenience wrapper. Returns null when no address could be trusted. */
export function getClientIP(request: Request): string | null {
  return getClientIpDetailed(request).ip;
}
