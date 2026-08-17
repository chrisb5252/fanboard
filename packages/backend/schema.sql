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
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  api_key         TEXT        NOT NULL UNIQUE,
  -- Leagues this venue shows. JSONB array of whitelist codes, e.g. ["NFL"].
  enabled_leagues JSONB       NOT NULL DEFAULT '[]'::jsonb
                              CHECK (jsonb_typeof(enabled_leagues) = 'array'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bring an already-initialised database in line; the column definition above
-- only applies on first creation.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS enabled_leagues JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_enabled_leagues_is_array;
ALTER TABLE venues ADD CONSTRAINT venues_enabled_leagues_is_array
  CHECK (jsonb_typeof(enabled_leagues) = 'array');

-- The venue's own day.
--
-- "Today's games" and the daily leaderboard were computed in the database's
-- timezone, which is UTC. For an American venue that rolls the day over at 8pm
-- Eastern — in the middle of the busiest part of the night. A 8:10pm ET game is
-- tomorrow to UTC, so it silently drops off the pickable list exactly when the
-- room is watching it, and the next day's fixtures appear in its place.
--
-- Defaults to UTC so existing venues behave exactly as before until an operator
-- sets their real zone.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- Validated against the server's own zone database rather than a hand-kept
-- list: an unknown name here would make every games query for the venue throw
-- at read time, which is a much worse failure than a rejected write.
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_timezone_known;
ALTER TABLE venues ADD CONSTRAINT venues_timezone_known
  CHECK (now() AT TIME ZONE timezone IS NOT NULL);

COMMENT ON COLUMN venues.timezone IS
  'IANA zone (e.g. America/New_York) defining this venue''s day for the games list and the daily leaderboard. Defaults to UTC.';

-- What kind of venue this is, and therefore what patrons predict.
--
--   sports_bar     games + picks           — who wins a fixture
--   bowling_alley  bowling_lanes + bowling_predictions — what a bowler scores
--
-- NOT NULL with a default rather than nullable: every venue is one kind or the
-- other, and a null would leave the read path guessing. Existing rows are
-- backfilled by the DEFAULT, so no separate UPDATE is needed.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'sports_bar';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS num_lanes INTEGER;

-- CHECK rather than an enum type, matching how status is handled elsewhere: a
-- new venue kind is then a one-line change here rather than an ALTER TYPE that
-- cannot run inside a transaction.
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_type_known;
ALTER TABLE venues ADD CONSTRAINT venues_type_known
  CHECK (type IN ('sports_bar', 'bowling_alley'));

-- num_lanes belongs to bowling alleys and only to them. Without this a sports
-- bar could carry a lane count that nothing reads, and a bowling alley could
-- carry none while the app expects one.
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_num_lanes_matches_type;
ALTER TABLE venues ADD CONSTRAINT venues_num_lanes_matches_type
  CHECK (
    (type = 'bowling_alley' AND num_lanes IS NOT NULL AND num_lanes BETWEEN 1 AND 200)
    OR (type <> 'bowling_alley' AND num_lanes IS NULL)
  );

COMMENT ON COLUMN venues.type IS
  'sports_bar predicts fixtures via games/picks; bowling_alley predicts scores via bowling_lanes/bowling_predictions.';
COMMENT ON COLUMN venues.num_lanes IS
  'Lane count, required for bowling_alley and NULL otherwise.';

-- Suspension. An operator needs a way to stop a venue taking new picks without
-- deleting anything: a disputed result, a display showing the wrong fixtures, a
-- venue under investigation. Suspension blocks new picks only — games still
-- grade and leaderboards still settle, because abandoning picks already made
-- would punish patrons for an operator's problem.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_suspension_paired;
ALTER TABLE venues ADD CONSTRAINT venues_suspension_paired
  CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL));

COMMENT ON COLUMN venues.suspended_at IS
  'Set while the venue is not accepting new picks. NULL means active.';
COMMENT ON COLUMN venues.suspended_reason IS
  'Why it was suspended. Surfaced to operators, never to patrons.';

-- Key rotation. The previous key stays valid for a bounded grace window so a
-- venue can roll its credential without an outage: rotating a single-column
-- key breaks every running client the instant it is written, which is why
-- rotation that costs downtime never actually gets used.
--
-- Both columns are cleared on revocation, which is the "disable the old key
-- now" path for a suspected compromise.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS previous_api_key TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS previous_api_key_expires_at TIMESTAMPTZ;

-- A stale previous key must never be accepted, so the two columns are only
-- ever meaningful together.
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_previous_key_paired;
ALTER TABLE venues ADD CONSTRAINT venues_previous_key_paired
  CHECK ((previous_api_key IS NULL) = (previous_api_key_expires_at IS NULL));

-- Partial: only rows mid-rotation are indexed, which is almost none of them.
CREATE INDEX IF NOT EXISTS venues_previous_api_key_idx
  ON venues (previous_api_key)
  WHERE previous_api_key IS NOT NULL;

COMMENT ON TABLE venues IS 'Tenant root; every other table cascades from here.';
COMMENT ON COLUMN venues.api_key IS
  'SHA-256 hash of the venue API key. Provision with: encode(sha256(''<raw key>''::bytea), ''hex'')';
COMMENT ON COLUMN venues.previous_api_key IS
  'SHA-256 hash of the superseded key, accepted until previous_api_key_expires_at.';
COMMENT ON COLUMN venues.previous_api_key_expires_at IS
  'When the superseded key stops being accepted. NULL means no key is mid-rotation.';
COMMENT ON COLUMN venues.enabled_leagues IS
  'Whitelisted league codes this venue ingests, e.g. ["NFL","NBA"]. Empty array means no filter.';

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

-- "List every display at this venue", for the admin device-status board.
-- PostgreSQL does not index a foreign key column automatically, and the partial
-- index above cannot serve this: it excludes devices that have never reported a
-- hardware id, which are exactly the ones an operator is looking for.
CREATE INDEX IF NOT EXISTS idx_devices_venue_id
  ON devices (venue_id);

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
  -- Absolute cap on a session's life, independent of the 12-hour idle timeout.
  -- Used for authentication only. It deliberately does NOT filter leaderboards:
  -- see the note below.
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

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
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');

COMMENT ON COLUMN player_sessions.expired IS
  'Soft-expiry flag. Set by the reaper job so historical picks and leaderboards stay intact.';
COMMENT ON COLUMN player_sessions.expires_at IS
  'Absolute session lifetime, enforced at authentication. NOT a leaderboard filter: standings are historical fact and must survive the session that produced them.';

CREATE INDEX IF NOT EXISTS idx_player_sessions_venue_last_seen
  ON player_sessions (venue_id, last_seen_at DESC)
  WHERE NOT expired;

-- The admin player list, which unlike the app path deliberately includes
-- expired sessions -- an operator debugging "where did that player go" needs to
-- see them. The partial index above cannot serve that, because the rows it
-- excludes are exactly the ones being asked about.
CREATE INDEX IF NOT EXISTS idx_player_sessions_venue_last_seen_all
  ON player_sessions (venue_id, last_seen_at DESC);

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

-- -----------------------------------------------------------------------------
-- audit_logs — an append-only record of privileged actions.
--
-- The prompt that introduced this table was truncated before the DDL, so the
-- shape below is derived from the auditLog(action, userId?, venueId, details?)
-- signature it specified. Two choices worth challenging:
--
--   * user_id is TEXT and nullable. Admin auth is a venue API key, which
--     identifies a *venue*, not a person, so every row written today has a NULL
--     user_id. It becomes meaningful only once admin accounts exist. TEXT
--     rather than a UUID FK so it can hold whatever identity scheme lands.
--
--   * ON DELETE CASCADE. Deleting a venue erases its audit trail, which is
--     wrong for a compliance log and right for a deletion request. It is
--     consistent with every other table here. If these records must outlive
--     their venue, drop the foreign key and keep venue_id as a bare UUID.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT        NOT NULL CHECK (length(btrim(action)) > 0),
  user_id    TEXT,
  venue_id   UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  details    JSONB       NOT NULL DEFAULT '{}'::jsonb
                         CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE audit_logs IS
  'Append-only record of privileged actions. Never updated or deleted by application code.';
COMMENT ON COLUMN audit_logs.user_id IS
  'Always NULL while admin auth is a venue API key: that credential identifies a venue, not a person.';
COMMENT ON COLUMN audit_logs.details IS
  'Action-specific context. Credential-shaped keys are redacted before insert; never put a secret here.';

-- "What happened at this venue, most recent first" — the only way this table is
-- read today.
CREATE INDEX IF NOT EXISTS idx_audit_logs_venue_created_at
  ON audit_logs (venue_id, created_at DESC);

-- "Every occurrence of this action", for tracing one kind of change across time.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at
  ON audit_logs (action, created_at DESC);

-- -----------------------------------------------------------------------------
-- bowling_lanes — a bowling alley's lanes, the equivalent of games at a bar.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bowling_lanes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            UUID        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  lane_number         INTEGER     NOT NULL CHECK (lane_number BETWEEN 1 AND 200),
  status              TEXT        NOT NULL DEFAULT 'available'
                                  CHECK (status IN ('available', 'in_use', 'closed')),
  current_bowler_name TEXT        CHECK (current_bowler_name IS NULL
                                         OR length(btrim(current_bowler_name)) BETWEEN 1 AND 50),
  -- Ten frames, and only ten. A frame counter that drifts past 10 would make
  -- "is this game over?" unanswerable.
  current_frame       INTEGER     NOT NULL DEFAULT 1 CHECK (current_frame BETWEEN 1 AND 10),
  current_score       INTEGER     NOT NULL DEFAULT 0 CHECK (current_score BETWEEN 0 AND 300),
  final_score         INTEGER     CHECK (final_score BETWEEN 0 AND 300),
  -- Deliberately no `predictions_locked` boolean beside this. Two columns
  -- meaning the same thing can disagree, and then nothing can say which is
  -- right. Locked is `locked_at IS NOT NULL`, exactly as it is for games.
  locked_at           TIMESTAMPTZ,
  graded_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One lane number per venue; this is also the natural upsert key.
  CONSTRAINT bowling_lanes_venue_id_lane_number_key UNIQUE (venue_id, lane_number),
  -- Target for the composite foreign key from bowling_predictions, the same
  -- trick games uses to make cross-venue rows impossible.
  CONSTRAINT bowling_lanes_venue_id_id_key UNIQUE (venue_id, id),

  -- A graded lane must have a final score to have been graded against.
  CONSTRAINT bowling_lanes_graded_requires_score
    CHECK (graded_at IS NULL OR final_score IS NOT NULL)
);

COMMENT ON TABLE bowling_lanes IS
  'Lanes at a bowling_alley venue. Plays the role games does at a sports_bar.';
COMMENT ON COLUMN bowling_lanes.locked_at IS
  'Cut-off after which no new predictions are accepted. NULL means still open.';
COMMENT ON COLUMN bowling_lanes.final_score IS
  'Set once frame 10 is complete; predictions are graded against it.';

CREATE INDEX IF NOT EXISTS idx_bowling_lanes_venue_status
  ON bowling_lanes (venue_id, status);

-- The grading worker's candidate scan: lanes finished but not yet settled.
-- Partial, so it holds only unsettled lanes and shrinks as they grade.
CREATE INDEX IF NOT EXISTS idx_bowling_lanes_ungraded
  ON bowling_lanes (venue_id)
  WHERE graded_at IS NULL;

DROP TRIGGER IF EXISTS bowling_lanes_set_updated_at ON bowling_lanes;
CREATE TRIGGER bowling_lanes_set_updated_at
  BEFORE UPDATE ON bowling_lanes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- bowling_predictions — one score prediction per player per lane.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bowling_predictions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- venue_id is carried here rather than only reached through the lane. It is
  -- what makes the composite foreign keys below possible, and those are what
  -- stop a player at one venue predicting on another venue's lane. Without it
  -- the database would happily accept that pairing.
  venue_id          UUID        NOT NULL,
  lane_id           UUID        NOT NULL,
  player_session_id UUID        NOT NULL,
  -- 0-300 is the full range of a ten-pin game. Scores of 291-299 are in fact
  -- unreachable, but rejecting them would be a rule about bowling rather than
  -- about data, and it would reject a legitimately mistyped-then-corrected
  -- entry for no gain.
  predicted_score   INTEGER     NOT NULL CHECK (predicted_score BETWEEN 0 AND 300),
  actual_score      INTEGER     CHECK (actual_score BETWEEN 0 AND 300),
  -- NULL until graded, not 0. A zero default cannot be told apart from a
  -- prediction that was graded and scored nothing, which is the same mistake
  -- the picks table is careful to avoid.
  points            INTEGER,
  accuracy_delta    INTEGER     CHECK (accuracy_delta IS NULL OR accuracy_delta BETWEEN 0 AND 300),
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graded_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bowling_predictions_lane_player_key UNIQUE (lane_id, player_session_id),

  -- Composite FKs: a prediction can never straddle two venues.
  CONSTRAINT bowling_predictions_venue_lane_fkey
    FOREIGN KEY (venue_id, lane_id)
    REFERENCES bowling_lanes (venue_id, id) ON DELETE CASCADE,
  CONSTRAINT bowling_predictions_venue_player_session_fkey
    FOREIGN KEY (venue_id, player_session_id)
    REFERENCES player_sessions (venue_id, id) ON DELETE CASCADE,

  -- Three legal states, mirroring picks:
  --   ungraded  graded_at NULL,     actual_score NULL, points NULL
  --   graded    graded_at NOT NULL, actual_score NOT NULL, points NOT NULL
  --   voided    graded_at NOT NULL, actual_score NULL,  points NULL
  -- Voided is how an abandoned lane settles: finished with, but scoring
  -- nothing. Distinguishable from ungraded only by graded_at.
  CONSTRAINT bowling_predictions_grading_consistency
    CHECK (
      (actual_score IS NULL) = (points IS NULL)
      AND (accuracy_delta IS NULL) = (points IS NULL)
      AND (points IS NULL OR graded_at IS NOT NULL)
    )
);

COMMENT ON TABLE bowling_predictions IS
  'One score prediction per player per lane. Plays the role picks does at a sports_bar.';
COMMENT ON COLUMN bowling_predictions.points IS
  'NULL while ungraded and for voided predictions; pair with graded_at to tell those apart.';
COMMENT ON COLUMN bowling_predictions.accuracy_delta IS
  'abs(predicted_score - actual_score) at grading time, stored so the scoring rule can change without rewriting history.';

CREATE INDEX IF NOT EXISTS idx_bowling_predictions_lane
  ON bowling_predictions (lane_id);

-- "My predictions", the patron's own list.
CREATE INDEX IF NOT EXISTS idx_bowling_predictions_player
  ON bowling_predictions (venue_id, player_session_id);

-- The grading sweep. Partial, so it covers only what is still outstanding.
CREATE INDEX IF NOT EXISTS idx_bowling_predictions_ungraded
  ON bowling_predictions (lane_id)
  WHERE graded_at IS NULL;

COMMIT;
