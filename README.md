# FanBoard

Venue-hosted live sports prediction game. Patrons scan a QR code, pick winners
on their phones, and watch a shared leaderboard on the bar's TV.

This repository currently contains **infrastructure and schema only**. No API
routes are implemented yet.

## Layout

```
fanboard/
├── packages/
│   ├── backend/          Next.js (App Router) — API + jobs + schema
│   ├── admin-web/        React + Vite — venue operator console
│   ├── mobile-web/       React + Vite — patron phone app
│   └── fire-tv/          React + Vite — big-screen display app
├── docker-compose.yml    PostgreSQL 15 + Redis 7
├── .github/workflows/ci.yml
├── tsconfig.json         shared strict base, extended by every package
├── .eslintrc.json        single lint config for the whole monorepo
└── .gitignore
```

npm workspaces, no Turborepo/Nx. Four packages with no cross-package imports
does not yet justify a build orchestrator.

| Package      | npm name              | Dev port |
| ------------ | --------------------- | -------- |
| `backend`    | `@fanboard/backend`   | 3000     |
| `admin-web`  | `@fanboard/admin-web` | 3001     |
| `mobile-web` | `@fanboard/mobile-web`| 3002     |
| `fire-tv`    | `@fanboard/fire-tv`   | 3003     |

## Prerequisites

- Node.js >= 22 (CI pins 22)
- npm >= 10
- Docker with Compose v2

## Getting started

```bash
npm install
```

```bash
cp packages/backend/.env.example packages/backend/.env.local
```

```bash
docker compose up -d
```

Postgres applies `packages/backend/schema.sql` automatically on the **first**
boot of its volume. To re-apply after editing the schema:

```bash
docker compose down -v && docker compose up -d
```

Then run whichever app you need:

```bash
npm run dev:backend
```

```bash
npm run dev:admin
```

```bash
npm run dev:mobile
```

```bash
npm run dev:tv
```

### Port conflicts

If 5432 or 6379 are already taken (another project's containers, a local
Postgres install), override them without editing the compose file:

```bash
cp .env.example .env
```

Then set `POSTGRES_PORT` / `REDIS_PORT` in `.env`. Container-internal ports are
unchanged, so only `DATABASE_URL` / `REDIS_URL` in `.env.local` need to match.
Note that Windows reserves scattered high port ranges for Hyper-V; if a bind
fails with "access permissions", pick a different port rather than debugging it.

## Scripts

Run from the repository root:

| Script                 | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `npm run build`        | Builds all four packages                            |
| `npm run type-check`   | `tsc --noEmit` in every package                      |
| `npm run lint`         | One ESLint pass over the whole monorepo             |
| `npm run lint:fix`     | Same, with `--fix`                                   |
| `npm run test`         | Vitest in every package that has tests              |
| `npm run infra:up`     | `docker compose up -d`                              |
| `npm run infra:down`   | `docker compose down`                               |
| `npm run infra:reset`  | `docker compose down -v && up -d` (re-applies schema)|
| `npm run infra:logs`   | Tails container logs                                |
| `npm run infra:validate` | `docker compose config --quiet`                   |

## Environment

`packages/backend/.env.local` (git-ignored; template in `.env.example`):

| Variable              | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `DATABASE_URL`        | Postgres connection string                 |
| `REDIS_URL`           | Redis connection string                    |
| `THESPORTSDB_API_KEY` | Schedule and score ingestion               |
| `NEXT_PUBLIC_API_URL` | Backend origin, exposed to browser clients |

Validated by `src/lib/env.ts` with Zod. Validation is **lazy** — deliberately,
so `next build` works on machines and CI runners with no `.env.local`, which is
also what lets the CI `build` step run without any secrets.

The root `.env.example` is separate: it only overrides docker-compose ports and
credentials, and every value in it is already the compose default.

## Schema

`packages/backend/schema.sql` — six tables, all scoped by `venue_id`:

`venues` → `devices`, `player_sessions`, `games` → `picks` → `leaderboard_snapshot`

Two decisions worth knowing:

**Composite foreign keys.** `picks` references `games (venue_id, id)` and
`player_sessions (venue_id, id)` rather than the bare primary keys. A pick
therefore *cannot* reference a game or a player from a different venue — the
database rejects it rather than trusting application code to filter correctly.
This is the multi-tenant isolation guarantee for the leaderboard.

**CHECK constraints, not enums.** `status`, `period`, `winner` and
`predicted_winner` use `CHECK (... IN ...)`. Adding a value is a one-line
`ALTER TABLE`; adding one to a Postgres enum is considerably more awkward to
run inside a migration.

The file is idempotent, so it can also be applied by hand:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/backend/schema.sql
```

It is a **bootstrap** schema, not a migration system. Introduce a migration tool
before the first production deploy — once real venue data exists, editing this
file in place stops being viable.

### Before production

Two columns hold bearer secrets in plaintext: `venues.api_key` and
`player_sessions.session_token`. Store hashes instead. Both are marked with a
`COMMENT` in the schema.

## Backend architecture

```
src/instrumentation.ts        Next.js server-startup hook -> startWorkers()
src/lib/worker-scheduler.ts   interval timers, overlap guard, graceful drain
src/workers/poll-games.ts     every 30s: provider -> normalize -> upsert
src/lib/sports-provider.ts    abstract SportsProvider + NormalizedGame
src/lib/thesportsdb.ts        TheSportsDBProvider implementation
src/lib/auth.ts               session / admin / device route guards
src/lib/tokens.ts             token generation and SHA-256 hashing
src/lib/validators.ts         Zod input validation, branded UUID type
src/lib/errors.ts             ApiError and client-safe error rendering
src/lib/cache-keys.ts         Redis key builders in one place
src/services/players.ts       create a player session
src/services/picks.ts         submit a pick, with the atomic lock check
src/app/api/venues/[venueId]/players/route.ts
src/app/api/venues/[venueId]/picks/route.ts
src/lib/db.ts                 pooled pg, query(), withTransaction()
src/lib/redis.ts              client singleton, get()/set()/del()
src/lib/logger.ts             structured JSON logs with secret redaction
src/lib/env.ts                lazy, Zod-validated environment
src/lib/health.ts             shared probe shape for dependency checks
```

### API

| Route | Auth | Success | Failures |
| --- | --- | --- | --- |
| `POST /api/venues/:venueId/players` | none | 201 + cookie | 400, 404 |
| `POST /api/venues/:venueId/picks` | session cookie | 201 new · 200 changed | 400, 401, 403, 404, 423 |
| `GET /api/venues/:venueId/leaderboard?period=` | none (public) | 200 | 400 |

The graph is acyclic (verified with `madge --circular`); `logger`, `env`,
`health` and `sports-provider` are leaves.

### Where workers are started

`src/instrumentation.ts`, **not** the root layout. A layout is a React
component: it is evaluated during static prerendering at `next build` — which
would start a scheduler on a CI runner with no database — and again on every
request. `register()` runs once, per server process, which is what a scheduler
needs. Set `WORKERS_ENABLED=false` to boot the server without it.

### Authentication

Three route-level guards in `src/lib/auth.ts`: `sessionMiddleware` (patron
cookie), `adminMiddleware` (venue API key), `deviceMiddleware` (display key).

They are **not** Next.js middleware. Real `middleware.ts` runs on the Edge
runtime, which cannot open the TCP sockets pg and redis need, so a credential
check there would have nothing to check against. These are called at the top of
a route handler and return a verified context or throw an `ApiError`.

**Every credential column stores a SHA-256 hash, never the raw value.** A leaked
dump or an over-broad SELECT yields hashes, not working credentials. Provision a
venue with:

```sql
INSERT INTO venues (name, api_key) VALUES ('The Anchor', encode(sha256('your-raw-key'::bytea), 'hex'));
```

Session cookies are `HttpOnly; Secure; SameSite=Lax; Path=/`. Lax rather than
Strict because patrons arrive by scanning a QR code and Strict would withhold
the cookie on that first navigation; Lax still withholds it on cross-site POSTs,
which is the CSRF case. `COOKIE_SECURE=false` exists for LAN deployments without
TLS — see `.env.example`.

`assertVenueScope` rejects a valid session acting on a different venue than the
one in the URL. Without it, changing the venue id in the path would be enough.

### Game locking

The pick write is one statement:

```sql
WITH open_game AS (SELECT ... WHERE COALESCE(locked_at, scheduled_at) > NOW() AND status = 'scheduled')
INSERT INTO picks ... SELECT ... FROM open_game ON CONFLICT ... DO UPDATE ...
```

The check-then-write alternative is a TOCTOU race, and the gap is widest exactly
when everyone is submitting. Here PostgreSQL evaluates "is it open?" and "write
the pick" atomically. Consequences:

- `NOW()` is the **database's** clock. No timestamp from the client is read,
  parsed or trusted anywhere in this path.
- `COALESCE(locked_at, scheduled_at)` lets an operator close picks early by
  setting `locked_at`, without touching the schedule.
- A conflicting row only updates when the same predicate held, so an existing
  pick cannot be edited after lock either.
- Zero rows means "not written" and deliberately does not say why; the caller
  re-reads the game to tell 404 from 423.

Redis (`game:{id}:locked_at`) is a fast path in front of this, never the source
of truth: a present key is trusted for rejection because locks never lift, an
absent key falls through to the database, and a Redis outage degrades to the
database rather than failing writes.

### Shutdown: NEXT_MANUAL_SIG_HANDLE

`next start` registers `process.on('SIGTERM', cleanup)` **before** the app loads,
and that cleanup ends in `process.exit(143)`. Node runs signal listeners in
registration order, so Next's fires first and kills the process before the
worker drain can finish — on Linux as much as anywhere.

Set `NEXT_MANUAL_SIG_HANDLE=1` in the runtime environment and Next installs
nothing; `worker-scheduler.ts` then drains, closes the pool and Redis, and exits
143 (or 130 for SIGINT) itself. Without it the scheduler logs a warning at
startup. Note that when we own the signals, Next no longer closes the HTTP
server on shutdown; draining in-flight requests as well as workers is the next
step there.

### Grading and leaderboards

`grade-games` runs every 2 minutes; `update-leaderboard` every 5, and also
immediately after any grading run that settled something — a scoreboard the room
can see is wrong is worse than an extra query.

**Candidates are chosen by `graded_at IS NULL`, not `status <> 'final'`.**
poll-games sets status to `final` the moment the provider reports it, so a
status filter would skip exactly the games that are ready and they would never
settle.

**Picks grade in one statement.** "Load the picks, loop, update each" is an N+1
in disguise; the scoring rule is expressible in SQL, so 10,000 rows never leave
the database. Game update and pick grading share a transaction, so a game is
never marked graded with its picks unscored.

**Picks have three states**, enforced by `picks_grading_consistency`:

| state | `graded_at` | `correct` | `points` |
| --- | --- | --- | --- |
| ungraded | NULL | NULL | NULL |
| graded | set | TRUE/FALSE | 10 / 0 |
| voided (cancelled game) | set | NULL | NULL |

Voided picks are excluded from the leaderboard entirely — a cancelled game is
neither a win nor a loss. Voided is distinguishable from ungraded only by
`graded_at`, which is why grading always stamps it.

A `final` game with no winner (scores missing upstream) is **not** graded: it
would violate `games_graded_requires_winner`, so it waits for a later poll.

### Leaderboard

`computeLeaderboard(venueId, period)` aggregates, ranks, replaces the stored
snapshot and returns it — all in one statement. The `DELETE` runs as a
data-modifying CTE, which always executes to completion and sees the same table
snapshot as the `INSERT`, so a reader gets either the old board or the new one,
never an empty table mid-swap.

Ranking is points DESC, then wins DESC, then earliest pick, then id — fully
deterministic, so two runs over identical data produce identical ranks.

Periods use two vocabularies and `PERIOD_TO_SNAPSHOT` in `leaderboard.ts` is the
only place they meet: the API takes `today` / `this_week` / `all_time`, while
`leaderboard_snapshot.period` is constrained to `daily` / `weekly` / `all_time`.
Passing a storage name such as `daily` to the API is a 400.

**Timezone caveat:** `date_trunc` runs in the database's timezone (UTC), so
"today" rolls over at 00:00 UTC rather than the venue's local midnight. A bar
closing at 01:00 local sees its evening split across two boards. Fixing this
properly needs a timezone column on `venues`.

### Measured performance

25 venues, 250,000 picks, Postgres 15 in Docker:

| operation | measured | budget |
| --- | --- | --- |
| grade 10,000 picks (10 games) | 169 ms | 5,000 ms |
| compute leaderboard (1,000 players) | 31–36 ms | 500 ms |
| read snapshot | 5 ms | 500 ms |

`EXPLAIN ANALYZE` on the leaderboard aggregate shows a Bitmap Index Scan on
`idx_picks_leaderboard` (4.9 ms). Note that with a *single* venue owning the
whole table the planner correctly prefers a sequential scan — the index only
earns its place once venue_id is selective, which is why the numbers above were
taken across 25 venues rather than one.

**`idx_picks_graded_at_venue_id` is unused.** It was requested explicitly and is
created, but `pg_stat_user_indexes` reports `scans=0` against the workload above
while `idx_picks_leaderboard` took 64 and `idx_picks_ungraded_by_game` 68. No
query leads with `graded_at`. It costs write amplification on every pick insert
and grade for no read benefit; drop it unless a "recently graded across all
venues" query appears.

### poll-games

Every 30 seconds it fetches the next 7 days from TheSportsDB, caches each day's
raw response in Redis for 5 minutes, and upserts into `games`.

Three things worth knowing:

**One statement per venue.** The upsert passes 13 parallel arrays through
`UNNEST` rather than issuing a statement per game, so venue count does not
multiply round trips. `xmax = 0` in the `RETURNING` clause separates inserts
from updates for the run log.

**Graded games are immutable.** The `DO UPDATE` carries
`WHERE games.graded_at IS NULL`. Once the grading job has scored picks against
a result, a late provider correction must not move the outcome underneath
players who already won or lost on it. Those rows are reported as `skipped`.

**Games fan out to every venue.** The MVP has no per-venue league selection, so
every venue receives every fetched game. `FetchGamesOptions.leagues` is already
threaded through the whole call path, so adding that selection is a data change
rather than a signature change. This is an assumption a PRD would settle.

The API key is kept out of logs two ways: the URL is redacted to `/json/***/`
at the call site, and the key is registered with the logger, which scrubs it
from any line it appears in. There is a test asserting it never leaks on the
success, error and exception paths.

### Testing

```bash
npm run test
```

Unit tests run everywhere. The integration suite additionally exercises the real
`UNNEST` upsert — that it is valid SQL, that its arrays line up with their
columns, that timestamps survive as the same instant, and that a constraint
violation rolls the whole batch back. It self-skips unless a database is named:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fanboard npm run test
```

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests.

- **verify** — `npm ci`, `type-check`, `lint`, `test`, `build`, then asserts each
  of the four packages actually emitted output (`.next/BUILD_ID`,
  `dist/index.html` plus a hashed JS bundle). A build that silently produces
  nothing fails here. The integration suite self-skips in this job.
- **infra** — validates `docker-compose.yml`, applies `schema.sql` to a real
  Postgres 15 service container **twice** to prove idempotency, asserts all six
  tables exist, then runs the integration suite against that database. This is
  the only place the `UNNEST` upsert meets real PostgreSQL.

## Tooling notes

ESLint is pinned to **8.57.1** because the spec calls for `.eslintrc.json`,
which ESLint 9 supports only behind a deprecated flag and ESLint 10 removes
entirely. npm will warn that 8.x is unsupported. Migrating to `eslint.config.js`
flat config is the way to clear it, and is worth doing before this scaffold
grows much further.

TypeScript is on the 5.x line rather than 7.x; the 7.0 native compiler is out
but `@typescript-eslint` and the Next.js plugin have not caught up.
