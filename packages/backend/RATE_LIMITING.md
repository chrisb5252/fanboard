# Rate Limiting

`POST /api/venues/:venueId/players` is the only unauthenticated write in
FanBoard. It carries two independent hourly limits.

| Layer | Limit | Bucket | Constant |
| --- | --- | --- | --- |
| Per IP, per venue | 5 / hour | `ratelimit:player_session:<venueId>:<ip>` | `PLAYER_SESSIONS_PER_IP` |
| Per venue | 500 / hour | `ratelimit:player_session_venue:<venueId>` | `PLAYER_SESSIONS_PER_VENUE` |

Both constants live in `src/lib/cache-keys.ts`, along with
`RATE_LIMIT_WINDOW_MS` (3,600,000). The `ratelimit:` prefix is added by
`consumeRateLimit`, not by the key builders — use the full key above when
inspecting Redis by hand.

---

## Why two layers

**Per IP** stops one host bulk-creating sessions. It is not sufficient alone: an
attacker with a botnet, or simply an IPv6 allocation, has as many "distinct
clients" as they need.

**Per venue** bounds that case to a number a real bar never reaches — a busy
venue sees low hundreds of patrons in an evening, not thousands per hour. It is
also the *only* limit that applies when no client address can be trusted (see
[TRUSTED_PROXY_HOPS](#trusted_proxy_hops)).

### Ordering: rejected requests do not spend venue budget

The IP check runs first and returns immediately on rejection. The venue counter
is only incremented for requests that passed the IP check.

If it were the other way round, one attacker could drain the 500 ceiling and
lock out every real patron at that venue for an hour — the rate limiter causing
the outage it exists to prevent. There is a test asserting the venue counter
does not move while an IP is being rejected.

Consequence worth knowing: **the venue counter counts allowed-by-IP attempts,
not total attempts.** It is not a request counter and should not be read as one.

| Scenario | Outcome |
| --- | --- |
| One IP hammers | Rejected at 5. Venue budget untouched. |
| 100 IPs × 5 each | All 500 allowed; venue ceiling now full. |
| 101st IP arrives | Passes its own IP check (fresh bucket), rejected at the venue ceiling. |
| No trustworthy IP | Per-IP skipped entirely; venue ceiling carries the whole load. |

### Round trips

| Outcome | Redis calls |
| --- | --- |
| Allowed | 2 (IP, then venue) |
| Rejected by IP limit | 1 |
| Rejected by venue ceiling | 2 |
| No trustworthy IP (allowed or rejected) | 1 (venue only) |

`node-redis` uses a single multiplexed connection, not a pool, so this is
pipelining pressure rather than connection-count pressure.

---

## The Lua script

`src/lib/rate-limiter.ts`

```lua
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
```

`KEYS[1]` is the prefixed key, `ARGV[1]` the window in milliseconds. Returns
`{count, ttlMs}` — the count drives the decision, the TTL drives `Retry-After`,
in one round trip.

**Why Lua.** Redis executes a script atomically, so no other client interleaves
between the INCR and the expiry being set.

**Why `if ttl < 0` and not `if count == 1`.** `PTTL` returns `-1` when a key
exists with no expiry and `-2` when it does not exist. The `count == 1` pattern
arms the TTL only on the first request of a window — precisely the moment a
crash or dropped connection would skip it, leaving an immortal key that locks
that client out forever. Checking the TTL on *every* call means any key that
somehow loses its expiry is re-armed on the next request, with no operator
involvement.

---

## Client IP resolution

`src/lib/ip-extractor.ts`

`X-Forwarded-For` is a request header. Anyone can send one. Reading its leftmost
value — the usual "get the real client IP" recipe — lets a caller send a fresh
forged address per request, so the limiter counts to one and never fires.

A proxy **appends** the address it saw. So the trustworthy entry is positional,
counted from the right:

```ts
const index = Math.max(0, parts.length - hops);
```

Everything to the left of that index is caller-supplied and ignored.

`x-real-ip` is consulted as a fallback (nginx overwrites rather than appends, so
it carries no attacker-controlled prefix), but only once `hops >= 1` has
established that a proxy exists.

When nothing can be trusted, `getClientIpDetailed` returns
`{ ip: null, source: 'none' }` — it never invents an address.

### Bucketing

**IPv4** — one address, one bucket. `203.0.113.9` → `203.0.113.9`.

**IPv6** — bucketed by /64. `2001:db8::1` → `2001:db8:0:0::/64`.

A single subscriber is allocated a /64 or larger. Limiting per full address
would hand one attacker 2^64 buckets without leaving their own subnet.

`expandIpv6` normalises to eight groups (handling `::` compression, rejecting
two `::`, wrong group counts, or non-hex groups); `normaliseIp` then takes the
first four.

Special cases handled first:

| Input | Bucket | Note |
| --- | --- | --- |
| `[2001:db8::1]:443` | `2001:db8:0:0::/64` | brackets and port stripped |
| `203.0.113.9:44321` | `203.0.113.9` | port stripped |
| `::ffff:203.0.113.9` | `203.0.113.9` | IPv4-mapped, folded back to v4 |
| `localhost`, `999.999.999.999`, `../../etc/passwd` | `null` | never becomes a Redis key |

The IPv4-mapped case was a bug in the first implementation — the parser only
spoke hex and rejected the embedded dotted quad. The tests caught it.

---

## TRUSTED_PROXY_HOPS

**This setting decides whether per-IP limiting works at all.** Read per request
from `process.env`, defaulting to `1` when unset, blank, non-integer, or
negative.

Set it to the number of proxies that append to `X-Forwarded-For` between the
client and this app.

| Topology | Value |
| --- | --- |
| Direct, no proxy | `0` |
| One reverse proxy (nginx, HAProxy, ALB, Caddy) | `1` |
| Cloudflare → your nginx | `2` |
| Longer chain | one per appending proxy |

With `X-Forwarded-For: A, B, C`:

| hops | index | reads |
| --- | --- | --- |
| 0 | — | nothing; returns `{ip: null}` before any header is read |
| 1 | 2 | `C` (rightmost — what your proxy appended) |
| 2 | 1 | `B` |
| 3 | 0 | `A` |

### Misconfiguration — measured, not assumed

These were verified against the real function.

**Too high — this is a genuine bypass.** With `hops=3` and one real proxy, the
attacker controls the entry at the read index:

```
X-Forwarded-For: 9.9.9.1, 8.8.8.1, 7.7.7.1, 203.0.113.9   → reads 8.8.8.1
X-Forwarded-For: 9.9.9.2, 8.8.8.2, 7.7.7.2, 203.0.113.9   → reads 8.8.8.2
```

A new bucket per request. Per-IP limiting is defeated. (If the forged entries
are not valid IPs, `normaliseIp` rejects them and the result is `null` — per-IP
limiting is *disabled* rather than bypassed. Do not rely on that; an attacker
will send well-formed addresses.)

Note this is **not** caused by the `Math.max(0, …)` clamp. The clamp only
applies when the chain is *shorter* than `hops`.

**Too low but non-zero — collective lockout.** With `hops=1` behind two proxies:

```
X-Forwarded-For: 203.0.113.9, 10.0.0.5   → reads 10.0.0.5
```

That is the inner proxy's address, so *every* client shares one bucket and the
whole venue collectively gets 5 sessions per hour. This is the "everyone looks
like the proxy" failure — it happens at `hops` too low but ≥ 1, **not** at
`hops=0`.

**Zero** — no header is read, `{ip: null}`, per-IP limiting off, venue ceiling
still enforced. Degraded but safe.

### Verifying your setting

The success path does **not** log the client IP. Trip the limit deliberately and
read the rejection, which logs `clientIp` and `source`:

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'content-type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.42' \
    -d '{"nickname":"ProbeUser"}' \
    https://your-host/api/venues/<VENUE_ID>/players
done
```

Expect `201` ×5 then `429`. Then find the rejection line in the logs:

```json
{"level":"warn","message":"player session rejected by per-IP rate limit",
 "clientIp":"203.0.113.42","source":"x-forwarded-for", ...}
```

- `clientIp` is your test address → correct.
- `clientIp` is an internal/proxy address (`10.x`, `172.16.x`, `192.168.x`) →
  **hops too low**.
- Six `201`s and no rejection at all → either `hops=0`, or the value at the read
  index is not a valid IP. Look for
  `no trustworthy client IP; per-IP rate limiting is inactive`.

Remember to remove the probe sessions afterwards.

---

## Failure modes

### Redis unreachable — fails open

Both limits fail open together. `consumeRateLimit` catches, returns
`{allowed: true, degraded: true}`, and the request proceeds.

This is availability over security, and the cost is real: **an attacker who can
make Redis unreachable also removes the rate limit.** It is the right default
here because failing closed means one Redis blip stops every patron in every
venue from joining. Redis availability is therefore a security control.

Verified by stopping the container: 8/8 requests served, 24 degraded log lines.

**Log strings to alert on — exact, lower-case:**

| String | Source |
| --- | --- |
| `rate limit check failed; failing open` | `rate-limiter.ts` |
| `rate limiter received an unexpected reply; failing open` | `rate-limiter.ts` |
| `rate limiting degraded: Redis unavailable, requests are unthrottled` | players route |
| `no trustworthy client IP; per-IP rate limiting is inactive` | players route |

Logs are JSON lines; match on the `message` field. A case-sensitive search for
`Rate limit check failed` will **not** match.

### Redis slow or hung — NOT covered

> **Known gap.** No connect or command timeout is configured — the client is
> created with `createClient({ url })` only. Fail-open triggers on an *error*,
> not on a hang. If Redis accepts connections but stops responding, the request
> waits on it rather than degrading. Configuring `socket.connectTimeout` and a
> command timeout is the fix; it is not implemented today.

### Immortal key

Prevented by the `ttl < 0` branch. Self-heals on the next request.

### Fixed-window burst

Fixed windows allow up to 2× the limit across a boundary (5 at 10:59, 5 more at
11:00). Accepted for this threat model — the venue ceiling still bounds the
total.

---

## Testing

`__tests__/player-sessions-rate-limit.test.ts` — three layers.

1. **Pure unit** — IP parsing, hop counting, spoofing, IPv6 /64, hostile inputs;
   limiter logic with an injected `evalScript`.
2. **Real Redis** — actual TTL expiry. Fake timers cannot move Redis's clock, so
   the expiry test uses a short window and waits.
3. **Route level** — the handler imported and called as a function. No server,
   no `fetch`.

```ts
route = await import('../src/app/api/venues/[venueId]/players/route');

const response = await route.POST(
  new Request(`https://fanboard.test/api/venues/${venueId}/players`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ nickname }),
  }),
  { params: Promise.resolve({ venueId }) },   // Next 16: params is a Promise
);
expect(response.status).toBe(201);
```

The dynamic import happens in `beforeAll` **after** `process.env` is set,
because `getEnv()` memoises. `describe.skipIf(TEST_DATABASE_URL === undefined)`
gates the DB-backed blocks so CI's no-database job skips rather than fails.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fanboard npm run test
```

Covered: per-IP enforcement; independent buckets per IP and per venue; venue
ceiling; rejected IP requests not spending venue budget; forged `X-Forwarded-For`
defeated; limiting ahead of body parsing and any DB write; no row written on
rejection; TTL always armed; real expiry and recovery; fail-open on Redis error;
429 body leaking nothing.

---

## What is and is not rate-limited

**Rate-limited per request**

- `POST /api/venues/:venueId/players` — 5/hour/IP, 500/hour/venue.

**Session-limited, not rate-limited**

- `POST /api/venues/:venueId/picks` — requires a valid session cookie, and
  `UNIQUE (game_id, player_session_id)` caps a player at one row per game,
  updated in place. The row ceiling is players × games, not requests. **A valid
  session can call it as fast as it likes**, and each call still costs a database
  round trip. There is no request-rate limit on it.

**Read-only and cached**

- `GET /api/venues/:venueId/leaderboard` — Redis, 60s TTL.
- `GET /api/devices/:deviceId/display` — Redis, 10s TTL, per device.

**Authenticated** (access control, not rate limiting)

- `GET·POST /api/admin/venues/:venueId/*` — venue API key.
- `GET /api/devices/:deviceId/*`, `POST .../heartbeat` — display key.

---

## Operations

### Alerting

| Condition | Severity | Action |
| --- | --- | --- |
| Any `; failing open` or `rate limiting degraded` message | **High** — control offline | Check Redis; see the runbook in DEPLOYMENT.md |
| `no trustworthy client IP` | **High** — per-IP layer inert | Check `TRUSTED_PROXY_HOPS` and that the proxy sets `X-Forwarded-For` |
| Sustained `rejected by per-venue rate limit` | Medium | Likely distributed abuse, or a venue genuinely outgrowing 500/hour |
| Occasional `rejected by per-IP rate limit` | None | The limit doing its job |
| Same `clientIp` rejected across many `venueId`s | Medium | Coordinated abuse; the log line carries both fields |

### Metrics

> Not implemented. There is no metrics exporter in the backend today — the JSON
> logs are the only signal. If one is added, the useful counters are per-IP
> rejections, per-venue rejections, fail-open events, and Redis latency.

### Tuning

Both limits are constants in `src/lib/cache-keys.ts`, not environment variables.
Changing them requires a deploy. `PLAYER_SESSIONS_PER_VENUE = 500` is a
deliberate over-estimate of a busy venue; raise it if a real venue legitimately
approaches it, and check whether the rejections are genuine abuse first.
