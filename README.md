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

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests.

- **verify** — `npm ci`, `type-check`, `lint`, `build`, then asserts each of the
  four packages actually emitted output (`.next/BUILD_ID`, `dist/index.html`
  plus a hashed JS bundle). A build that silently produces nothing fails here.
- **infra** — validates `docker-compose.yml`, applies `schema.sql` to a real
  Postgres 15 service container **twice** to prove idempotency, then asserts all
  six tables exist.

## Tooling notes

ESLint is pinned to **8.57.1** because the spec calls for `.eslintrc.json`,
which ESLint 9 supports only behind a deprecated flag and ESLint 10 removes
entirely. npm will warn that 8.x is unsupported. Migrating to `eslint.config.js`
flat config is the way to clear it, and is worth doing before this scaffold
grows much further.

TypeScript is on the 5.x line rather than 7.x; the 7.0 native compiler is out
but `@typescript-eslint` and the Next.js plugin have not caught up.
