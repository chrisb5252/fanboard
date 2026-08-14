-- =============================================================================
-- FanBoard — MVP bootstrap schema
-- PostgreSQL 15+
--
-- This file is mounted into /docker-entrypoint-initdb.d by docker-compose and
-- runs automatically the first time the `postgres` volume is initialised.
-- It is written to be idempotent so it can also be applied by hand:
--
--     psql "$DATABASE_URL" -f packages/backend/schema.sql
--
-- Multi-tenancy note: every table is scoped by `venue_id`. Child tables that
-- reference more than one venue-scoped parent use *composite* foreign keys
-- (venue_id, id) so the database itself makes it impossible for a pick to
-- reference a game or a player from a different venue.
--
-- gen_random_uuid() is core in PostgreSQL 13+; no pgcrypto extension required.
-- =============================================================================

BEGIN;

SET client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger: stamps updated_at so application code never has to.';

-- -----------------------------------------------------------------------------
-- venues — the tenant root. One row per bar / restaurant running FanBoard.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS venues (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  api_key     TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE venues IS 'Tenant root; every other table cascades from here.';
COMMENT ON COLUMN venues.api_key IS
  'SHA-256 hash of the venue API key. Provision with: encode(sha256(''<raw key>''::bytea), ''hex'')';

DROP TRIGGER IF EXISTS venues_set_updated_at ON venues;
CREATE TRIGGER venues_set_updated_at
  BEFORE UPDATE ON venues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- devices — Fire TV sticks (or any display) paired to a venue.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS devices (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  display_name      TEXT        NOT NULL CHECK (length(btrim(display_name)) > 0),
  fire_tv_device_id TEXT,
  display_key       TEXT        NOT NULL UNIQUE,
  last_heartbeat    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN devices.fire_tv_device_id IS
  'Hardware identifier reported by the Fire TV app; NULL until the device first checks in.';
COMMENT ON COLUMN devices.display_key IS
  'SHA-256 hash of the pairing code shown on the TV. Short codes are low entropy: exchange for a long random device token at pairing time.';
COMMENT ON COLUMN devices.last_heartbeat IS
  'Last successful check-in; drives the "offline display" alert in admin-web.';

-- Required lookup index devices(venue_id, fire_tv_device_id). Declared UNIQUE and
-- partial: a hardware id may only be claimed once per venue, and rows that have
-- not checked in yet (NULL) are excluded rather than colliding with each other.
-- PostgreSQL still uses this index for equality lookups, which imply NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_venue_fire_tv_device_id
  ON devices (venue_id, fire_tv_device_id)
  WHERE fire_tv_device_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- player_sessions — anonymous, nickname-only patrons. No accounts in the MVP.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS player_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  nickname      TEXT        NOT NULL CHECK (length(btrim(nickname)) BETWEEN 1 AND 50),
  session_token TEXT        NOT NULL UNIQUE,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired       BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Target for the composite foreign key from picks.
  CONSTRAINT player_sessions_venue_id_id_key UNIQUE (venue_id, id)
);

-- Widen an already-initialised database to match. The inline CHECK above only
-- applies on first creation, so existing volumes need this to stay in step with
-- validateNickname()'s 50-character ceiling. If the two drift, an over-long
-- nickname stops being a clean 400 and becomes a constraint violation.
ALTER TABLE player_sessions DROP CONSTRAINT IF EXISTS player_sessions_nickname_check;
ALTER TABLE player_sessions ADD CONSTRAINT player_sessions_nickname_check
  CHECK (length(btrim(nickname)) BETWEEN 1 AND 50);

COMMENT ON COLUMN player_sessions.session_token IS
  'SHA-256 hash of the bearer token held in the phone browser. The raw token is never stored.';
COMMENT ON COLUMN player_sessions.expired IS
  'Soft-expiry flag. Set by the reaper job so historical picks and leaderboards stay intact.';

CREATE INDEX IF NOT EXISTS idx_player_sessions_venue_last_seen
  ON player_sessions (venue_id, last_seen_at DESC)
  WHERE NOT expired;

-- -----------------------------------------------------------------------------
-- games — schedule rows ingested per venue from TheSportsDB.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS games (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  external_id   TEXT        NOT NULL,
  league        TEXT        NOT NULL,
  sport         TEXT        NOT NULL,
  home_team     TEXT        NOT NULL,
  away_team     TEXT        NOT NULL,
  home_logo_url TEXT,
  away_logo_url TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  locked_at     TIMESTAMPTZ,
  graded_at     TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled', 'live', 'final', 'postponed', 'cancelled')),
  home_score    INTEGER     CHECK (home_score >= 0),
  away_score    INTEGER     CHECK (away_score >= 0),
  winner        TEXT        CHECK (winner IN ('home', 'away', 'draw')),
  cancelled     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A provider fixture is ingested at most once per venue; this is the upsert key.
  CONSTRAINT games_venue_id_external_id_key UNIQUE (venue_id, external_id),
  -- Target for the composite foreign key from picks.
  CONSTRAINT games_venue_id_id_key UNIQUE (venue_id, id),
  -- A graded, non-cancelled game must have resolved to a winner.
  CONSTRAINT games_graded_requires_winner
    CHECK (graded_at IS NULL OR cancelled OR winner IS NOT NULL)
);

COMMENT ON COLUMN games.external_id IS 'TheSportsDB event id (idEvent).';
COMMENT ON COLUMN games.locked_at IS
  'Cut-off after which no new picks are accepted; normally kick-off time.';
COMMENT ON COLUMN games.graded_at IS
  'Set once the grading job has scored every pick on this game. NULL means ungraded.';
COMMENT ON COLUMN games.cancelled IS
  'Cancelled/abandoned fixture. Picks are voided rather than graded.';

CREATE INDEX IF NOT EXISTS idx_games_venue_scheduled_at
  ON games (venue_id, scheduled_at);

-- The grading worker's candidate scan, every 2 minutes forever. Partial, so it
-- holds only unsettled games and shrinks as games are graded. At the scale
-- measured here (240 games) the planner still prefers a sequential scan, which
-- is correct; this exists so the scan does not degrade as a season accumulates.
CREATE INDEX IF NOT EXISTS idx_games_awaiting_grading
  ON games (scheduled_at)
  WHERE graded_at IS NULL AND cancelled = FALSE;

CREATE INDEX IF NOT EXISTS idx_games_external_id
  ON games (external_id);

DROP TRIGGER IF EXISTS games_set_updated_at ON games;
CREATE TRIGGER games_set_updated_at
  BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- picks — one prediction per player per game.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS picks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID        NOT NULL,
  game_id           UUID        NOT NULL,
  player_session_id UUID        NOT NULL,
  predicted_winner  TEXT        NOT NULL CHECK (predicted_winner IN ('home', 'away', 'draw')),
  points            INTEGER,
  correct           BOOLEAN,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graded_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT picks_game_id_player_session_id_key UNIQUE (game_id, player_session_id),

  -- Composite FKs: a pick can never straddle two venues.
  CONSTRAINT picks_venue_game_fkey
    FOREIGN KEY (venue_id, game_id)
    REFERENCES games (venue_id, id) ON DELETE CASCADE,
  CONSTRAINT picks_venue_player_session_fkey
    FOREIGN KEY (venue_id, player_session_id)
    REFERENCES player_sessions (venue_id, id) ON DELETE CASCADE,

  -- Three legal states, and nothing else:
  --   ungraded  graded_at NULL,     correct NULL,     points NULL
  --   graded    graded_at NOT NULL, correct NOT NULL, points NOT NULL
  --   voided    graded_at NOT NULL, correct NULL,     points NULL
  -- Voided is how a cancelled game settles: the pick is finished with, but it
  -- counts as neither a win nor a loss. It is distinguishable from ungraded
  -- only by graded_at, which is why grading must always stamp it.
  CONSTRAINT picks_grading_consistency
    CHECK (
      (correct IS NULL) = (points IS NULL)
      AND (correct IS NULL OR graded_at IS NOT NULL)
    )
);

COMMENT ON COLUMN picks.correct IS
  'NULL while ungraded and for voided picks; TRUE/FALSE once graded. Pair with graded_at to tell those apart.';
COMMENT ON COLUMN picks.points IS
  'NULL until graded and for voided picks; 0 for a wrong pick. Always NULL exactly when correct is NULL.';

-- Bring an already-initialised database in line with the three-state model
-- above. The inline definitions only apply on first creation.
ALTER TABLE picks ALTER COLUMN points DROP DEFAULT;
ALTER TABLE picks ALTER COLUMN points DROP NOT NULL;
-- Existing ungraded rows carry the old NOT NULL DEFAULT 0; NULL is what the new
-- constraint requires of them.
UPDATE picks SET points = NULL WHERE graded_at IS NULL AND points IS NOT NULL;
ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_graded_consistency;
ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_grading_consistency;
ALTER TABLE picks ADD CONSTRAINT picks_grading_consistency
  CHECK (
    (correct IS NULL) = (points IS NULL)
    AND (correct IS NULL OR graded_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_picks_venue_player_session_id
  ON picks (venue_id, player_session_id);

CREATE INDEX IF NOT EXISTS idx_picks_game_id
  ON picks (game_id);

-- The grading worker's hot path: "every ungraded pick on this game". Partial,
-- so it stays small -- once a game is graded its picks leave the index.
CREATE INDEX IF NOT EXISTS idx_picks_ungraded_by_game
  ON picks (game_id)
  WHERE graded_at IS NULL;

-- The leaderboard aggregate: venue-scoped, windowed on created_at, counting
-- only settled picks. INCLUDE carries the aggregated columns so the scan never
-- has to visit the heap.
CREATE INDEX IF NOT EXISTS idx_picks_leaderboard
  ON picks (venue_id, created_at)
  INCLUDE (player_session_id, points, correct, submitted_at)
  WHERE correct IS NOT NULL;

-- Requested as picks(graded_at, venue_id).
--
-- MEASURED: unused. Against 250k picks across 25 venues, pg_stat_user_indexes
-- reported scans=0 for this index while idx_picks_leaderboard took 60 scans and
-- idx_picks_ungraded_by_game 58. No query in the codebase leads with graded_at:
-- the leaderboard aggregate is venue-first, and the grading worker filters on
-- game_id. It costs write amplification on every pick insert and grade for no
-- read benefit. Kept because it was explicitly requested; drop it unless a
-- "recently graded across all venues" query appears.
CREATE INDEX IF NOT EXISTS idx_picks_graded_at_venue_id
  ON picks (graded_at, venue_id);

-- -----------------------------------------------------------------------------
-- leaderboard_snapshot — precomputed standings, read directly by the TV app.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leaderboard_snapshot (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  period            TEXT        NOT NULL
                                CHECK (period IN ('daily', 'weekly', 'monthly', 'all_time')),
  player_session_id UUID        REFERENCES player_sessions(id) ON DELETE SET NULL,
  nickname          TEXT        NOT NULL,
  wins              INTEGER     NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses            INTEGER     NOT NULL DEFAULT 0 CHECK (losses >= 0),
  points            INTEGER     NOT NULL DEFAULT 0,
  rank              INTEGER     NOT NULL CHECK (rank > 0),
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE leaderboard_snapshot IS
  'Denormalised standings written by the leaderboard job. The TV never aggregates at read time.';
COMMENT ON COLUMN leaderboard_snapshot.nickname IS
  'Denormalised on purpose: a snapshot must still render after its session is reaped.';

CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshot_venue_period_rank
  ON leaderboard_snapshot (venue_id, period, rank);

-- Serves "give me the newest snapshot for this venue+period" before ranking.
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshot_venue_period_computed_at
  ON leaderboard_snapshot (venue_id, period, computed_at DESC);

COMMIT;
