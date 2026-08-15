# Deploying FanBoard to production

How to get FanBoard running on real infrastructure, start to finish.

This is the **deployment procedure**. For the configuration reference — every
environment variable, what `TRUSTED_PROXY_HOPS` does to rate limiting, why Redis
is a security control — see [`packages/backend/DEPLOYMENT.md`](packages/backend/DEPLOYMENT.md).
Those two documents are deliberately not merged: this one is read once per
deploy, that one is read when something is wrong.

---

## Prerequisites

- Docker 24+ (the image is multi-stage; older BuildKit works but is untested here)
- A container registry (ECR, GHCR, Docker Hub)
- Managed PostgreSQL 15+ and Redis 7+, or the single-host compose stack below
- A TLS-terminating reverse proxy (ALB, Cloudflare, nginx, Caddy)
- A TheSportsDB API key

---

## 1. PostgreSQL

Use a managed service (RDS, Cloud SQL, Neon, Supabase). Backups, failover and
patching become someone else's rotation, which for a two-person team is the
whole argument.

Create the database, then apply the schema:

```bash
psql "$DATABASE_URL" -f packages/backend/schema.sql
```

`schema.sql` is idempotent — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, `DROP CONSTRAINT IF EXISTS` before each `ADD CONSTRAINT` — so
re-running it against an existing database is safe and is how column additions
land.

Required: `gen_random_uuid()`, which is built in from PostgreSQL 13.

**Enable automated backups and verify a restore before launch.** A backup nobody
has restored is a hypothesis, not a backup.

## 2. Redis

Use a managed service (ElastiCache, Upstash, Redis Cloud). Configure:

- `maxmemory-policy allkeys-lru` — everything stored is a cache or a rate-limit
  counter and can be rebuilt
- A password, and TLS if the provider offers it
- Alerting on availability

Read [`packages/backend/DEPLOYMENT.md`](packages/backend/DEPLOYMENT.md) on why
Redis availability is a security control before going live: when Redis is
unreachable, rate limiting fails **open**.

## 3. Environment variables

Set these on the host or in your platform's secret store. Never in a file that
gets committed, and never in the image.

```bash
# Required
DATABASE_URL=postgresql://user:password@host:5432/fanboard
REDIS_URL=redis://:password@host:6379
THESPORTSDB_API_KEY=your-key
NEXT_PUBLIC_API_URL=https://api.fanboard.com

# Required in production
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://app.fanboard.com,https://tv.fanboard.com
NEXT_MANUAL_SIG_HANDLE=1

# Security-critical — get this right for your topology
TRUSTED_PROXY_HOPS=1
```

Two of these bite if you skip them:

- **`CORS_ALLOWED_ORIGINS` has no default in production.** An unset value denies
  every cross-origin browser request. That is intentional — the alternative is a
  deployment that silently trusts the wrong origin — but it means the phone and
  the TV will fail to reach the API until it is set.
- **`NEXT_MANUAL_SIG_HANDLE=1` must be a real process environment variable**, not
  a line in `.env.local`. `next start` installs its own SIGTERM handler *before*
  the app loads and exits the process from it, cutting off the worker drain
  mid-transaction.

`TRUSTED_PROXY_HOPS` controls how the rate limiter reads `X-Forwarded-For`.
Setting it too high makes per-IP limiting bypassable; too low makes an entire
venue share one bucket. See `RATE_LIMITING.md`.

## 4. Build the image

Build from the **repository root**, not from `packages/backend`:

```bash
docker build -f packages/backend/Dockerfile -t fanboard-backend:$(git rev-parse --short HEAD) .
```

This is an npm workspaces monorepo: the lockfile is at the root, and `npm ci`
will not run without it. A build context of `packages/backend` cannot see it.

The build is multi-stage because the compiler is a devDependency — installing
with `--omit=dev` and then running `npm run build` fails. The build stage
installs everything; the runtime stage does a separate production-only install.

## 5. Push to a registry

```bash
docker tag fanboard-backend:$(git rev-parse --short HEAD) $REGISTRY/fanboard-backend:$(git rev-parse --short HEAD)
docker push $REGISTRY/fanboard-backend:$(git rev-parse --short HEAD)
```

Tag with the commit SHA, not `latest`. A rollback needs a name for the thing you
are rolling back to.

## 6. Deploy

**Single host** — everything on one machine, suitable for a pilot:

```bash
export POSTGRES_USER=fanboard POSTGRES_PASSWORD=... REDIS_PASSWORD=...
export THESPORTSDB_API_KEY=... NEXT_PUBLIC_API_URL=https://api.fanboard.com
export CORS_ALLOWED_ORIGINS=https://app.fanboard.com

docker compose -f docker-compose.prod.yml up -d
```

The compose file requires every secret and refuses to start without one. A stack
that silently boots with `postgres/postgres` in production is worse than one
that will not boot.

**Platform (ECS, Cloud Run, Render, Railway)** — point it at the pushed image,
set the environment variables from step 3, expose port 3000, and configure the
health check from step 8.

Both expose two ports:

- **3000** — the HTTP API
- **3100** — the WebSocket listener, in the same process on its own port,
  because Next's App Router does not hand out its HTTP server for an upgrade
  handler. Put the reverse proxy in front and route `/ws` to 3100 so clients see
  one origin.

## 7. Migrations

There is no migration tool. `schema.sql` is the schema and it is idempotent:

```bash
psql "$DATABASE_URL" -f packages/backend/schema.sql
```

Run it **before** rolling out a new image, and only make additive changes
(new nullable columns, new tables, new indexes) so the old and new versions can
run side by side during the rollout.

This is a real limitation, not a design: destructive changes need a hand-written
plan, and there is no down-migration. Adopt a migration tool before the first
change that drops or renames anything.

## 8. Verify

```bash
curl -fsS https://api.fanboard.com/api/health | jq
```

Expect `200` and `"status": "healthy"`, with `database`, `redis` and `workers`
all `healthy: true`. Any dependency down gives `503` and names which one.

The endpoint answers within ~3 seconds even when a dependency is hanging: probes
are bounded, so a Redis outage produces a clean 503 rather than a probe timeout
that tells the operator nothing.

Point your platform's health check at `/api/health`. It is exempt from the
HTTPS redirect precisely so probes can reach it over plain HTTP from inside the
perimeter.

Then check the rest by hand:

```bash
# Public reads
curl -fsS https://api.fanboard.com/api/venues/$VENUE_ID/games

# CORS allows your real origin
curl -sD - -o /dev/null -H "Origin: https://app.fanboard.com" \
  https://api.fanboard.com/api/venues/$VENUE_ID/games | grep -i access-control

# ...and refuses anything else
curl -sD - -o /dev/null -H "Origin: https://evil.example" \
  https://api.fanboard.com/api/venues/$VENUE_ID/games | grep -i access-control  # expect nothing

# HSTS is present
curl -sD - -o /dev/null https://api.fanboard.com/api/health | grep -i strict-transport
```

Confirm workers are alive by watching for `poll started` and `games locked` in
the logs, and confirm `TRUSTED_PROXY_HOPS` by tripping the session rate limit
and reading `clientIp` on the rejection line — it must be the real client
address, not the proxy's.

## Railway

Railway builds from the repo and injects `$PORT`. Four things differ from the
generic path above.

### Variables

Set these on the **backend** service (Variables tab). `DATABASE_URL` and
`REDIS_URL` come from Railway's Postgres and Redis plugins — reference them
rather than pasting literals, so a credential rotation on the plugin does not
silently break the app:

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
THESPORTSDB_API_KEY=<your key>
NEXT_PUBLIC_API_URL=https://<backend>.up.railway.app

NODE_ENV=production
NEXT_MANUAL_SIG_HANDLE=1
TRUSTED_PROXY_HOPS=1

# Every frontend origin that calls the API. No default in production — unset
# means every cross-origin browser call is denied.
CORS_ALLOWED_ORIGINS=https://<mobile>.up.railway.app,https://<admin>.up.railway.app,https://<tv>.up.railway.app
```

Do **not** set `PORT`. Railway provides it and `next start` reads it.

`CORS_ALLOWED_ORIGINS` is the one that bites: each Vite app is its own Railway
service on its own domain, so every call from them is cross-origin. Leave it
unset and the API refuses all of them — deliberately, since the alternative is
trusting an origin nobody chose. The values must be scheme + host with no
trailing slash and no path.

`TRUSTED_PROXY_HOPS=1` matches Railway's single edge proxy. Verify it rather
than trusting it: trip the session rate limit and check `clientIp` on the
rejection log line is the real client address, not Railway's.

### Schema

Railway will not apply `schema.sql` for you. Run it against the plugin database
after the first deploy and after any release that changes it — including the
key-rotation columns (`previous_api_key`, `previous_api_key_expires_at`):

```bash
railway run --service <backend> psql "$DATABASE_URL" -f packages/backend/schema.sql
```

It is idempotent, so re-running is safe and is how column additions land.

### The WebSocket is not reachable on Railway

**Realtime does not work on Railway as currently deployed.** This is a real
limitation, not a configuration mistake to hunt for:

- The realtime listener binds its own port (3100). Next's App Router does not
  hand out its HTTP server, so an upgrade handler cannot share the API's port
  without a custom server.
- That design assumes a reverse proxy routing `/ws` → 3100. Railway publishes
  exactly **one** port per service and provides no such proxy.
- In production the Vite apps are static builds. `vite.config.ts`'s `/ws` proxy
  only applies to `vite dev` and `vite preview`, so it does nothing here.

The visible symptom is mild, which is why it is easy to miss: clients fail to
connect, retry on their backoff schedule, and **keep polling**, so screens and
phones still update — just on the poll interval rather than instantly. Polling
was deliberately kept alongside the socket for exactly this reason.

Options, in increasing order of effort:

1. **Accept it.** Displays refresh every 10s and phones on their own timer. For
   a pilot this is genuinely fine.
2. **Custom Next server.** One HTTP server that delegates to Next's handler and
   handles `/ws` upgrades itself, so both share `$PORT`. The real work is that
   the WebSocket module is TypeScript and a custom server needs it compiled —
   put the `WebSocketServer` in `noServer` mode and have the server delegate
   upgrades to it.
3. **Separate WebSocket service.** Works, but the patron socket authenticates
   with an httpOnly **cookie** that rides the handshake *because it is
   same-origin*. A different domain drops it, so this needs a cookie scoped to a
   shared parent domain or a token exchange — more invasive than option 2.

## 9. Load test

```bash
VENUE_ID=<uuid> BASE=https://api.fanboard.com node packages/backend/scripts/loadtest.mjs
```

100 concurrent players for 20 seconds, at roughly the 4:1 read/write mix a real
venue produces. Exits non-zero if p95 exceeds 500ms or the 5xx rate exceeds
0.1%, so it can gate a release.

Measured against the production image on a developer laptop, with Postgres and
Redis in containers on the same host:

| Endpoint | n | p50 | p95 | p99 | errors |
| --- | --- | --- | --- | --- | --- |
| `POST /players` | 100 | 332ms | 501ms | 514ms | 0 |
| `GET /games` | 2290 | 4ms | 10ms | 15ms | 0 |
| `GET /leaderboard` | 2257 | 4ms | 11ms | 103ms | 0 |
| `POST /picks` | 1092 | 10ms | 22ms | 25ms | 0 |
| **overall** | **5739** | **5ms** | **18ms** | **316ms** | **0 (0.000%)** |

274 req/s sustained. Both targets met.

Two things the numbers actually say:

- **`POST /players` is the slow one, and it is a test artifact.** All 100 players
  join in the same instant, which no venue does — patrons trickle in. It is the
  only endpoint that writes a session and hashes a token, so a simultaneous
  hundred queues on the connection pool. Sustained behaviour is the read/write
  mix below it.
- **The reads are served from Redis**, which is why they sit at 4ms. With Redis
  down they fall through to Postgres and get slower but stay correct — the
  figure to re-measure if you are sizing for a Redis outage.

Two ways to get a meaningless pass, both guarded against in the script:

- If every game at the venue is locked, every pick returns 423 and the run
  measures the *rejection* path — a Redis cache hit — instead of the write. The
  script refuses to start if no game is open.
- Against a production build over plain HTTP, every request is answered 308 and
  the run measures redirects. The script sends `x-forwarded-proto: https`, as a
  TLS-terminating proxy would.

---

## Provisioning the first venue

There is no venue-creation endpoint yet; it is a database insert. Generate a key
and store its hash:

```bash
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$KEY').digest('hex'))")
psql "$DATABASE_URL" -c "INSERT INTO venues (name, api_key) VALUES ('The Anchor', '$HASH')"
echo "API key (store now, not recoverable): $KEY"
```

Only the hash is stored, so the key cannot be read back. If it is lost, rotate
with `POST /api/admin/venues/{venueId}/rotate-key` while the old one still
works, or insert a new hash directly.

## Rotating a key

```bash
curl -X POST -H "Authorization: Bearer $CURRENT_KEY" \
  https://api.fanboard.com/api/admin/venues/$VENUE_ID/rotate-key
```

The old key keeps working for 24 hours so clients can be updated without an
outage. Once they are, end the window:

```bash
curl -X DELETE -H "Authorization: Bearer $NEW_KEY" \
  https://api.fanboard.com/api/admin/venues/$VENUE_ID/rotate-key
```

If the old key is believed compromised, revoke immediately rather than waiting.

---

## Rollback

```bash
docker pull $REGISTRY/fanboard-backend:$PREVIOUS_SHA
# redeploy that tag
```

Safe as long as schema changes have been additive. A release that dropped or
renamed a column cannot be rolled back this way — which is the reason for the
additive-only rule in step 7.

## After deploy

- [ ] `/api/health` returns 200
- [ ] Database backups enabled **and a restore tested**
- [ ] Redis availability alert configured (rate limiting fails open without it)
- [ ] Log aggregation receiving structured JSON
- [ ] Alert on `rate limiting degraded` and `no trustworthy client IP` log lines
- [ ] A Fire TV paired and rendering against production
- [ ] A phone able to join, pick, and see the leaderboard update live
- [ ] On-call rotation and [`RUNBOOKS.md`](RUNBOOKS.md) circulated
