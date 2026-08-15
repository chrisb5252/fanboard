# FanBoard security checklist

Status of every control, as verified against the code on 2026-08-15 — not as
intended. Where the shipped behaviour differs from what was specified, the
difference is stated rather than smoothed over.

Every ✓ below was checked by reading the code or running a test, and the file
and test that back it are named. Items that are **not** done are marked ✗ and
listed again under [Known gaps](#known-gaps).

---

## ✓ API key rotation

- `POST /api/admin/venues/{venueId}/rotate-key` issues a new key.
- `DELETE` on the same path ends the grace window immediately.
- Authenticated with the key being replaced: possession of the current
  credential is the authority to roll it.

The superseded key keeps working for **24 hours**
(`API_KEY_GRACE_PERIOD_HOURS`). That is the difference between a rotation
mechanism and a rotation mechanism people use. A single-column key swap breaks
every live client the instant it is written — the dashboard, any integration,
the operator's own scripts — so in practice the key never gets rotated and the
credential lives forever. Revocation is the separate, deliberate action for a
suspected leak.

The raw key is returned exactly once, by the call that mints it. Only the
SHA-256 hash is stored; it is never logged and never written to the audit
trail.

`src/services/api-keys.ts`, `src/lib/auth.ts` · `__tests__/security.test.ts`

## ✓ CORS configuration

- Dev allows `localhost` and `127.0.0.1` on **3000, 3001, 3002, 3003**.
- Production allows exactly what `CORS_ALLOWED_ORIGINS` lists, and nothing else.
- Credentials mode on; the origin is echoed, never `*`; `Vary: Origin` is set.
- Preflight from an unlisted origin is refused with 403.

> The brief listed `localhost:3000, localhost:3001`. That covers the backend and
> admin-web only. mobile-web is 3002 and fire-tv is 3003, and omitting them
> breaks the phone and the TV the first time either is pointed at the API
> directly rather than through the Vite dev proxy.

Production has **no built-in origin**. A deployment that forgets to set
`CORS_ALLOWED_ORIGINS` refuses every cross-origin browser call instead of
falling back to something permissive; `docker-compose.prod.yml` makes the
variable required so the stack will not start without it.

`src/middleware.ts` · `__tests__/security.test.ts`

## ✓ Rate limiting

| Endpoint | Limit | Keyed by |
| --- | --- | --- |
| `POST /api/venues/{id}/players` | 5 / hour | IP, per venue |
| `POST /api/venues/{id}/players` | 500 / hour | venue |
| `POST /api/venues/{id}/picks` | 60 / minute | session |
| `GET /api/devices/{id}/display` | 100 / minute | device |
| Admin routes | unlimited | — (trusted, API-key authenticated) |

> **The brief described this as already implemented in an earlier pass. It was
> not.** Only `POST /players` had any limit; picks and display had none. Both
> were added here.
>
> **The stated numbers also differ from the brief in two places, deliberately:**
>
> - *Players: 5/hour per IP, not 100/minute.* This is the pre-existing limit and
>   it is tuned for the actual threat — one person rejoining a few times is
>   fine, a script minting sessions is not. The per-venue ceiling of 500/hour is
>   what bounds an attacker with many addresses, since a per-IP limit is only as
>   good as the attacker's IP budget.
> - *Picks: 60/minute per session, not 10/minute.* 10/min is below legitimate
>   use. A patron tapping through a 14-game slate submits faster than one pick
>   every six seconds without trying, and would be rejected mid-way through
>   picking. A limit that fires on ordinary behaviour gets disabled in a panic
>   on the first busy night. 60/min stops a looping client and a script while
>   leaving real use untouched.

Picks are keyed by **session, not IP**: every patron in a bar shares one NAT
address, so an IP bucket would throttle the whole room the moment it got busy.

Redis is a **security control** here — if it is unreachable, limits fail open
and log at error level. See `DEPLOYMENT.md` and `RATE_LIMITING.md`.

`src/lib/rate-limiter.ts`, `src/lib/cache-keys.ts` ·
`__tests__/player-sessions-rate-limit.test.ts`

## ✓ SQL injection prevention

Audited: **zero** interpolated values in any production query. Every statement
in `src/` uses numbered placeholders (`$1::uuid`), including the dynamic-looking
ones — the pick-inspector filters build a fixed statement and pass filters as
parameters.

Inputs are validated before they reach a query (`src/lib/validators.ts`), and
UUIDs carry a branded type so an unvalidated string cannot be passed where an
id is expected without an explicit `trustedUuid` call.

One interpolation exists in test code: `__tests__/e2e.test.ts` builds a game's
`scheduled_at` from a constant SQL interval expression written in the test
itself. It never touches request data. Noted rather than omitted.

## ✓ XSS prevention

- `dangerouslySetInnerHTML`: **zero occurrences** across all four packages.
- Direct `innerHTML` assignment: **zero**.
- `eval` / `new Function`: **zero**. (`client.eval` in `src/lib/redis.ts` is
  Redis `EVAL` running a Lua script server-side, not JavaScript evaluation.)

React escapes interpolated text by default, and nothing opts out of it.

## ✓ CSRF

No token, by design. The mitigations actually in place:

- Session cookie is `SameSite=Lax`, so it is **not** sent on a cross-site POST —
  which is the CSRF case. Lax rather than Strict because the patron arrives by
  scanning a QR code, and Strict withholds the cookie on that first cross-site
  navigation, breaking the entry path.
- Admin and device routes authenticate with a **header** (`Authorization`,
  `x-display-key`), which a cross-site form cannot set.
- CORS refuses credentialed requests from unlisted origins.

## ✓ Secrets management

- Git history audited: only `.env.example` files have ever been committed. No
  real `.env` has been, at any point.
- `.dockerignore` excludes `.env` and `.env.*` (allowing `.env.example`), so a
  local database URL cannot be baked into an image layer.
- Credentials are never logged: `redactSensitive` is applied to both log output
  and audit-log details, so passing a whole request body cannot persist an
  api_key into an append-only table.
- Grepped for credential names inside log calls: **zero**.

`src/lib/logger.ts`, `src/lib/audit.ts`

## ✓ TLS / HTTPS

- Production sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- Plain HTTP is redirected with **308**, which preserves method and body — a 302
  would silently turn a POST into a GET on the retry.
- HSTS is production-only. A dev server sending it pins localhost to HTTPS in
  the developer's browser for a year, a breakage that outlives the process.

**`/api/health` is exempt from the redirect.** This was found by running the
built image, not by any unit test: Next sets `x-forwarded-proto: http` on a
direct connection, so every probe got a 308, and a probe that does not follow
redirects reads that as failure. The orchestrator then restarts a perfectly
healthy container, forever.

`src/middleware.ts` · `__tests__/security.test.ts`

## ✓ Authentication

| Credential | Entropy | At rest | Transport |
| --- | --- | --- | --- |
| `session_token` | 256-bit random | SHA-256 | httpOnly, Secure, SameSite=Lax cookie |
| `api_key` | 256-bit random | SHA-256 | `Authorization: Bearer` |
| `display_key` | 256-bit random | SHA-256 | `x-display-key` header |

All three are 32 random bytes, base64url — stronger than the ~122 bits of a
UUIDv4 the brief suggested, and not derived from a timestamp or counter.

SHA-256 with no salt or work factor is correct here and not an oversight: these
are high-entropy random values, so there is no dictionary to run and no reason
to make verification slow.

`src/lib/tokens.ts`, `src/lib/auth.ts`

## ✓ Authorization

Every route was enumerated and its guard recorded:

| Route | Guard |
| --- | --- |
| `/api/admin/**` (7 routes) | `requireAdmin` + `assertVenueScope` |
| `/api/devices/{id}/display`, `/heartbeat` | `requireDevice` + `assertDeviceScope` |
| `/api/venues/{id}/picks` | `requireSession` + `assertVenueScope` |
| `/api/venues/{id}/players` | rate limits (unauthenticated by design — this mints the session) |
| `/api/health`, `/games`, `/leaderboard` | **public by design** — see gaps |

No privilege-escalation path: a venue-A key used against venue B's URL is
rejected by `assertVenueScope` (403), and rotation cannot be aimed at another
venue. Tenant isolation is additionally enforced *in the database* by composite
foreign keys, so a scoping bug in application code still cannot join across
venues.

Two deliberate status-code choices, both tested:

- Session used against another venue → **403**. The caller is authenticated,
  just not here. *(The brief said 404 for this.)*
- Game belonging to another venue → **404**. Not 403, because 403 would confirm
  the id is real, which is enough to enumerate another venue's fixtures.

`__tests__/e2e.test.ts`

## ✓ Data validation

- Zod at the environment boundary; hand-written validators on request input,
  each returning a 400 `ApiError` rather than throwing raw.
- Whitelists: `predicted_winner` ∈ {home, away} — `draw` is a real outcome but
  not a pickable one and is rejected at validation rather than at a CHECK
  constraint; league codes are whitelisted per venue.
- Length limits: nickname 2–30, display name ≤64, Fire TV device id ≤128.
- TypeScript strict mode **plus** `noUncheckedIndexedAccess`, so `rows[0]` is
  `T | undefined` and cannot be dereferenced without a check.
- Database CHECK constraints mirror the application limits, so drift between
  the two surfaces as a clean 400 rather than a constraint violation.

## ✓ Logging and monitoring

- Audit log for privileged actions: config changes, device pairing, key
  rotation, key revocation. Append-only, details redacted.
- Structured JSON logs with levels; errors carry the error object.
- No credential ever reaches a log line (audited).
- Rate-limit rejections are recorded with a monitor hook for alerting.

---

## Known gaps

These are real and accepted for the MVP. None is a blocker for a pilot; all
should be closed before scale.

✗ **`/api/venues/{id}/games` and `/leaderboard` are public and unrate-limited.**
Both are intentionally unauthenticated — they show what is already on a TV in
the room. But an unauthenticated caller can poll them freely. Mitigated by
Redis caching (10s and 60s TTL) so sustained polling costs roughly one database
read per interval per venue rather than one per request. Add an IP-based limit
before exposing the API to the open internet.

✗ **Display key travels in the WebSocket URL query string.** The browser
WebSocket API cannot set headers, unlike the HTTP path which uses
`x-display-key`. Query strings are written to proxy and server access logs. The
fix is a short-lived ticket exchanged over HTTP and redeemed on upgrade.

✗ **Audit log has no retention or archival job.** The 90-day retention the audit
document calls for is not enforced by anything; the table grows without bound.

✗ **No automated secret scanning in CI.** History was audited by hand here.
`git-secrets` or `gitleaks` should run on every push so the next one is caught
without someone remembering to look.

✗ **CORS preflight over plain HTTP in production returns 308, not 403.** HTTPS
enforcement runs first, and browsers do not follow redirects on preflight. Only
reachable if a browser sends a preflight over plain HTTP to production, which a
correctly configured TLS-terminating proxy prevents. Accepted.

✗ **Admin routes have no rate limit.** Treated as trusted, per the brief. This
is defensible while the API key is the only admin credential and is held by
operators, and should be revisited when human admin accounts land.
