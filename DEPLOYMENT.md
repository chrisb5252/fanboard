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

# Railway edge + Caddy. See the section below — getting this wrong silently
# breaks per-IP rate limiting in one direction or the other.
TRUSTED_PROXY_HOPS=2

# Only needed for clients NOT served through the Caddy proxy, which are
# same-origin. No default in production: unset denies every cross-origin
# browser call, scheme + host, no trailing slash.
# CORS_ALLOWED_ORIGINS=https://someother.example
```

Do **not** set `PORT`. Railway provides it and the server reads it.

### Schema

Railway will not apply `schema.sql` for you. Run it against the plugin database
after the first deploy and after any release that changes it — including the
key-rotation columns (`previous_api_key`, `previous_api_key_expires_at`):

```bash
railway run --service <backend> psql "$DATABASE_URL" -f packages/backend/schema.sql
```

It is idempotent, so re-running is safe and is how column additions land.

### Realtime shares the API port

`npm start` runs `server.mjs`, a custom Next server that owns one HTTP listener
and routes `/ws` upgrades to the realtime layer. There is **no second port** to
publish or proxy, which is what makes realtime work on a platform that exposes
one port per service.

Nothing to configure. `WS_PORT` and `WS_STANDALONE_PORT` apply only to the
standalone mode, which `npm run dev` uses locally and which a deployment fronted
by its own proxy can opt into.

### Frontends

Do not run `vite` or `vite preview` in production. Both are development servers
— unminified, source-mapped, not written to face the public — and the only
reason a Node process was ever there is the `/api` and `/ws` proxy.

Build each frontend into a Caddy image instead. Caddy serves the static bundle
*and* proxies `/api` and `/ws` to the backend, so the browser still sees one
origin:

```bash
docker build -f deploy/frontend.Dockerfile --build-arg PACKAGE=mobile-web -t fanboard-mobile .
docker build -f deploy/frontend.Dockerfile --build-arg PACKAGE=fire-tv    -t fanboard-tv .
docker build -f deploy/frontend.Dockerfile --build-arg PACKAGE=admin-web  -t fanboard-admin .
```

Each frontend service needs one variable:

```bash
BACKEND_ORIGIN=http://<backend-service>.railway.internal:3000
```

Railway sets `PORT` itself; Caddy reads it.

Same-origin is the reason for the proxy rather than pointing the clients at the
backend domain: the patron's session cookie is httpOnly and `SameSite=Lax`, so
it rides the WebSocket handshake only when the socket shares the page's origin,
and same-origin `/api` avoids a CORS preflight on every poll.

With Caddy in place the frontends no longer need `CORS_ALLOWED_ORIGINS` entries
for themselves — every call is same-origin. Keep the variable set for any
client you deploy elsewhere.

### TRUSTED_PROXY_HOPS is 2 behind Caddy

There are now two proxies in front of the backend: Railway's edge, then Caddy.
`X-Forwarded-For` gains an entry at each, so the rate limiter must count **2**
hops from the right:

```bash
TRUSTED_PROXY_HOPS=2
```

Leave it at 1 and every request appears to come from Caddy's address, so one
venue shares a single rate-limit bucket and the whole room is locked out after
five joins. Verify rather than trust: trip the session limit and confirm
`clientIp` on the rejection log line is the real client address.

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
