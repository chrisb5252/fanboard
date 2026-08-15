# Deploying the FanBoard backend

Covers the backend package only. Infrastructure (PostgreSQL 15, Redis 7) is
defined in the repository-root `docker-compose.yml`.

---

## Redis availability is a security control

Rate limiting on `POST /api/venues/:venueId/players` — the only unauthenticated
write in the system — depends on Redis for atomic counting and TTL management.

### What happens when Redis is unavailable

Both limits fail open. Every request is allowed, and the event is logged at
error level. This is deliberate: failing closed would mean a Redis blip stops
every patron in every venue from joining. The cost is equally real —

> **An attacker who can make Redis unreachable also removes the rate limit.**

Concretely: an attacker hammering the session endpoint would normally be cut off
after 5 requests per IP and 500 per venue. With Redis down, neither fires, and
`player_sessions` accumulates spam rows for as long as the outage lasts.

Verified behaviour with the Redis container stopped: 8/8 requests served,
degraded messages logged.

### Therefore, before shipping you need

1. **Redis uptime monitoring.** Any connection failure is high severity, not a
   warning — a security control is offline for the duration.

2. **Log-based alerting** on these exact strings (JSON `message` field,
   lower-case — a search for `Rate limit check failed` will not match):

   - `rate limit check failed; failing open`
   - `rate limiter received an unexpected reply; failing open`
   - `rate limiting degraded: Redis unavailable, requests are unthrottled`
   - `no trustworthy client IP; per-IP rate limiting is inactive`

3. **An incident runbook.** One is at the end of this document.

4. **Redis high availability** (recommended): Sentinel for automatic failover,
   or a managed Redis with an SLA. At minimum, a tested restart procedure.

### Known gap: slow Redis is not covered

The client is created with `createClient({ url })` and **no connect or command
timeout**. Fail-open triggers on an error, not on a hang. If Redis accepts
connections but stops responding, requests wait on it rather than degrading.

There are no `REDIS_CONNECT_TIMEOUT_MS` / `REDIS_COMMAND_TIMEOUT_MS`
environment variables — setting them has no effect. Closing this needs a code
change (`socket.connectTimeout` plus a command timeout), not configuration.

---

## Configuration

### Required

```bash
DATABASE_URL=postgresql://user:password@host:5432/fanboard
REDIS_URL=redis://host:6379            # or redis://user:password@host:6379
THESPORTSDB_API_KEY=your_key_here
NEXT_PUBLIC_API_URL=https://your-domain.com
```

### Security-critical

```bash
# How many proxies append to X-Forwarded-For between client and app.
# Wrong value = per-IP rate limiting is bypassable or collectively locks out.
TRUSTED_PROXY_HOPS=1

# Workers drain on SIGTERM only if Next is not handling signals itself.
NEXT_MANUAL_SIG_HANDLE=1
```

`TRUSTED_PROXY_HOPS` is the one to get right. Too high is a **bypass**; too low
but non-zero makes every client share one bucket. See
[RATE_LIMITING.md](./RATE_LIMITING.md#trusted_proxy_hops) for the measured
behaviour of each misconfiguration and how to verify yours.

`NEXT_MANUAL_SIG_HANDLE` must be a real process environment variable, not a
value in `.env.local`: `next start` installs its own SIGTERM handler before the
app loads and exits from it, cutting off the worker drain.

### Optional

```bash
COOKIE_SECURE=false   # ONLY for plain-http LAN deployments; default is secure
LOG_LEVEL=info        # debug | info | warn | error | silent
WORKERS_ENABLED=false # boot without background workers
```

---

## Pre-launch verification

**1. Redis reachable**

```bash
redis-cli -u "$REDIS_URL" ping     # PONG
```

**2. Schema applied**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/backend/schema.sql
```

Idempotent — safe to re-run. It also brings an existing database up to date.

**3. Rate limiting works end to end**

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    -H 'content-type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.42' \
    -d '{"nickname":"ProbeUser"}' \
    https://your-host/api/venues/<VENUE_ID>/players
done; echo
```

Expect `201 201 201 201 201 429`.

**4. `TRUSTED_PROXY_HOPS` is right**

Find the rejection from step 3 in the logs and check `clientIp`:

```json
{"level":"warn","message":"player session rejected by per-IP rate limit",
 "clientIp":"203.0.113.42","source":"x-forwarded-for"}
```

Your probe address means correct. An internal address (`10.x`, `172.16.x`,
`192.168.x`) means **hops too low**. No rejection at all after six requests
means per-IP limiting is inactive — look for
`no trustworthy client IP; per-IP rate limiting is inactive`.

Delete the probe sessions afterwards.

**5. Workers started**

```
{"message":"worker started","worker":"poll-games", ...}
{"message":"scheduler started","workers":["poll-games","grade-games","update-leaderboard"]}
```

If you see `NEXT_MANUAL_SIG_HANDLE is not set: next start will exit on SIGTERM
before workers can drain`, fix that before relying on graceful shutdown.

---

## Deployment checklist

- [ ] `TRUSTED_PROXY_HOPS` matches the proxy chain, **verified in logs** (step 4)
- [ ] `NEXT_MANUAL_SIG_HANDLE=1` set as a process env var
- [ ] Venue API keys provisioned as SHA-256 hashes, not raw
      (`encode(sha256('key'::bytea), 'hex')`)
- [ ] `REDIS_URL` uses auth if Redis is network-reachable
- [ ] Redis uptime monitoring configured, connection failure = high severity
- [ ] Log alerting on the four fail-open / inactive strings above
- [ ] Rate limiting load-tested (step 3 returns `201×5, 429`)
- [ ] `schema.sql` applied and re-applied cleanly
- [ ] Redis Sentinel / managed HA, or a tested restart procedure
- [ ] Redis-down runbook reviewed with whoever carries the pager
- [ ] TLS terminated in front of the app, or `COOKIE_SECURE=false` set knowingly

### Not available yet

- [ ] ~~`GET /api/health` returns 200/503~~ — **no health endpoint exists.**
      `checkDatabaseHealth()` and `checkRedisHealth()` in `src/lib/health.ts`
      return `{dependency, healthy, latencyMs, error?}` and are ready to wire up,
      but no route exposes them. Load-balancer health checks and any monitoring
      that expects `/api/health` will need this built first.
- [ ] ~~Metrics export~~ — no exporter; JSON logs are the only signal.

---

## Runbook: Redis is down

### Detect

- Logs contain `; failing open` or
  `rate limiting degraded: Redis unavailable, requests are unthrottled`
- Rate limiting is **off**; session creation is unbounded
- Leaderboard and display reads fall through to PostgreSQL — slower, still
  correct

### Triage

```bash
redis-cli -u "$REDIS_URL" ping        # PONG?
docker compose ps redis               # or systemctl status redis
docker compose logs --tail=100 redis
```

Distinguish **refused** from **hung**. Refused → fail-open engages, requests are
served. Hung → requests block on Redis (see the known gap above); expect
elevated latency and possible timeouts upstream.

### Mitigate

1. Restart or fail over to the replica.
2. If the outage will be long and abuse is suspected, drop
   `POST /api/venues/*/players` at the proxy. Patrons already holding a session
   cookie keep playing; only new joins stop.

### After recovery

Confirm limiting is live again:

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    -H 'content-type: application/json' -H 'X-Forwarded-For: 203.0.113.42' \
    -d '{"nickname":"ProbeUser"}' \
    https://your-host/api/venues/<VENUE_ID>/players
done; echo     # expect 201 201 201 201 201 429
```

Check for spam created during the window:

```sql
SELECT venue_id, count(*) AS sessions
  FROM player_sessions
 WHERE created_at > NOW() - INTERVAL '2 hours'
 GROUP BY venue_id
 ORDER BY sessions DESC;
```

A venue well above 500/hour is a strong signal of abuse during the outage.
Inspect before deleting:

```sql
SELECT nickname, created_at
  FROM player_sessions
 WHERE venue_id = '<VENUE_ID>'
   AND created_at > NOW() - INTERVAL '2 hours'
 ORDER BY created_at;
```

Deleting a session cascades to its picks and nulls it out of leaderboard
snapshots. Re-run the leaderboard worker afterwards so standings reflect the
cleanup.

Then: why did Redis go down, and did monitoring catch it before the logs did?
