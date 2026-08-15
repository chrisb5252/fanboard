# FanBoard runbooks

What to do when something is wrong, written for someone who did not build this
and is reading it at 11pm on a Sunday with a bar full of people.

**Start here every time:**

```bash
curl -fsS https://api.fanboard.com/api/health | jq
```

It names the failing dependency. `database`, `redis` and `workers` are reported
separately, so "the app is down" becomes a specific question in one command.

---

## 1. A Fire TV is offline

**Symptom:** a screen is blank, frozen, or showing stale scores. The admin
dashboard shows the device as offline.

A device is marked offline after **120 seconds** without a heartbeat, so a
device that just restarted may show offline for up to two minutes legitimately.

### Triage, cheapest first

1. **Check the dashboard.** If `lastHeartbeat` is recent, the device is talking
   to us and the problem is rendering, not connectivity — skip to step 4.
2. **Is it only this device?** If every display at the venue is offline, it is
   the venue's internet, not the sticks. Call the venue before dispatching
   anyone.
3. **Is it every venue?** Then it is us. Check `/api/health` and go to runbook
   5.
4. **Restart the app** on the stick: Settings → Applications → FanBoard → Force
   stop, then reopen. This resolves most cases and takes a minute.
5. **Restart the device.** Unplug it, count to ten, plug it back in.
6. **Re-pair** if it comes back and still will not authenticate: the display key
   may have been rotated or the device deleted. Generate a new pairing from the
   admin dashboard.

### If the screen renders but data is stale

The display polls every 10 seconds and also holds a WebSocket. If the socket
drops it reconnects on a backoff, and **polling continues regardless** — that is
deliberate, so a dead socket degrades latency rather than correctness.

Stale data with a live heartbeat therefore points upstream: check runbook 2.

### Escalate when

Multiple venues report offline displays at once and `/api/health` is green.
That combination suggests a problem between us and the venues, not in either.

---

## 2. Games are not updating

**Symptom:** scores are stale, games never lock, or finished games never grade.

Four workers can be responsible. `/api/health` lists each with its run and
failure counts — read that first, because it tells you which one to look at:

| Worker | Every | Does |
| --- | --- | --- |
| `poll-games` | 5 min | Fetches fixtures and scores from TheSportsDB |
| `lock-games` | 30 s | Stamps `locked_at` once kick-off passes |
| `grade-games` | 2 min | Settles finished games, scores picks |
| `update-leaderboard` | 5 min | Materialises standings |

### Triage

1. **Is the scheduler running at all?**
   `/api/health` → `dependencies.workers.running`. If `false`, the process is
   serving HTTP but doing no background work — restart it. Check
   `WORKERS_ENABLED` was not left at `false`.

2. **Are runs incrementing?** Call `/api/health` twice, a minute apart. If
   `runs` is not climbing for the relevant worker, it is stuck rather than
   failing — restart the process.

3. **Are runs failing?** A climbing `failures` count means it is running and
   erroring. Search logs for the worker name:

   ```bash
   docker logs fanboard-prod-backend 2>&1 | grep '"worker":"poll-games"' | tail -20
   ```

4. **Is the sports API the problem?** Look for `sports api request failed` or a
   4xx from TheSportsDB. Verify the key directly:

   ```bash
   curl -s "https://www.thesportsdb.com/api/v1/json/$THESPORTSDB_API_KEY/eventsday.php?d=$(date +%F)" | head -c 300
   ```

   A rejected key means `THESPORTSDB_API_KEY` is wrong, expired, or rate
   limited. Provider outages are **not** an emergency: existing games and picks
   are unaffected, and grading catches up when the provider returns. Say so to
   the venue rather than restarting things.

5. **Database or Redis?** `/api/health` names either. Go to runbook 3 or 4.

### Games locked but not graded

Grading deliberately waits **30 minutes** after kick-off before considering a
game (`GRADING_DELAY_MINUTES`) — a game is not final at the scheduled time.
A game finished 20 minutes ago is not yet late.

Grading also refuses to settle a game the provider reports as `final` with no
winner, because the database constraint would reject it. That is correct
behaviour and resolves itself on a later poll.

---

## 3. The database is down

**Symptom:** `/api/health` returns 503 with `database.healthy: false`. Most
endpoints return 500.

This is the most serious failure: Postgres is the source of truth for picks,
and picks cannot be reconstructed.

### Immediately

1. **Page the on-call engineer.** Do not work this alone.
2. **Confirm it is the database, not the network**, from the app host:
   ```bash
   psql "$DATABASE_URL" -c "SELECT 1"
   ```
3. **Check the provider's status page** before touching anything. If it is a
   managed failover already in progress, wait — intervening extends the outage.

### What still works

Reads served from Redis (leaderboards, display payloads, game lists) keep
answering until their TTL expires: 10 seconds for displays, 60 for leaderboards.
Screens go stale within a minute; they do not go blank immediately.

Pick submission fails outright. There is no queue and picks are **not** buffered
— by design. A pick accepted without a durable write is a pick the player thinks
they made and the leaderboard disagrees about, which is worse than a visible
error.

### Recovery

1. Restore from the most recent backup or promote the replica.
2. **Verify integrity before resuming traffic:**
   ```sql
   SELECT count(*) FROM picks WHERE graded_at IS NOT NULL AND points IS NULL;   -- expect 0
   SELECT count(*) FROM games WHERE graded_at IS NOT NULL
     AND NOT cancelled AND winner IS NULL;                                       -- expect 0
   SELECT max(submitted_at) FROM picks;   -- how much was lost
   ```
3. Restart the app so the connection pool rebuilds.
4. Leaderboards recompute on the next `update-leaderboard` pass, within 5
   minutes. Force it by restarting rather than waiting, if a venue is watching.
5. **Tell the venue what was lost.** If picks were dropped, patrons will notice
   and being told beforehand is the difference between a glitch and a
   controversy.

---

## 4. Redis is down

**Symptom:** `/api/health` returns 503 with `redis.healthy: false`. The app
keeps working, more slowly.

### This is a security incident, not just a performance one

**Rate limiting fails open.** With Redis unreachable, `POST /players` — the only
unauthenticated write in the system — is unthrottled. Every request is allowed
and logged at error level:

```bash
docker logs fanboard-prod-backend 2>&1 | grep "rate limiting degraded"
```

Treat a prolonged Redis outage as an exposure window, not merely a slowdown.

### What still works, and why

Everything. Redis holds only caches and counters:

- **Leaderboards and displays** fall through to Postgres. Slower, still correct.
- **Game locks** are still enforced. The cached lock is a fast path; the
  authoritative check is a `WHERE` clause on the same statement that writes the
  pick, evaluated by Postgres against its own clock. **Locks cannot be bypassed
  by taking Redis down.**
- **WebSocket fan-out stops.** Events publish through Redis, so pushes are lost.
  Clients keep polling and continue to update — this is exactly why polling was
  kept alongside the socket.

### Recovery

1. Restart or fail over Redis.
2. No cache warming is needed; it repopulates on demand.
3. Nothing is lost. Every Redis key is derived data.
4. Check for abuse during the window:
   ```sql
   SELECT venue_id, count(*) FROM player_sessions
    WHERE created_at > NOW() - INTERVAL '1 hour'
    GROUP BY venue_id ORDER BY count DESC;
   ```
   A venue far above its usual patron count was probably farmed while limits
   were open.

---

## 5. API performance is degraded

**Symptom:** slow responses, timeouts, complaints from multiple venues.

### Triage

1. **`/api/health` reports `durationMs`.** Above ~100ms on a healthy system
   means a dependency is struggling. It also reports each dependency's
   `latencyMs` separately, which usually identifies the culprit outright.

2. **Find slow queries:**
   ```sql
   SELECT query, calls, mean_exec_time, total_exec_time
     FROM pg_stat_statements
    ORDER BY total_exec_time DESC LIMIT 10;
   ```
   Expect grading and leaderboard computation at the top — they are the heavy
   ones by design. Anything else near the top is worth investigating.

3. **Check for N+1s.** The known-heavy paths are all bulk statements: grading
   scores every pick on a game in one `UPDATE`, and polling upserts fixtures
   with a single `UNNEST`. A per-row pattern appearing in `pg_stat_statements`
   with a very high `calls` count is a regression.

4. **Is Redis responding?**
   ```bash
   redis-cli -u "$REDIS_URL" --latency
   ```
   A slow Redis is worse than a dead one: dead is detected and bypassed
   immediately, slow adds its latency to every request that touches it. This is
   a known gap — there is no timeout on cache reads in the request path.

5. **Connection pool exhaustion.** The pool is 10 per instance.
   ```sql
   SELECT count(*), state FROM pg_stat_activity
    WHERE application_name = 'fanboard-backend' GROUP BY state;
   ```
   Many `idle in transaction` means something is holding a transaction open.

6. **Is it real load or an attack?**
   ```bash
   docker logs fanboard-prod-backend 2>&1 | grep "rate limit" | tail -50
   ```

### Quick mitigations

- **Restart the app.** Clears a leaked pool and a stuck worker. Cheap and often
  sufficient.
- **Scale horizontally.** The app is stateless; WebSocket fan-out goes through
  Redis pub/sub precisely so multiple instances stay correct.
- **Raise cache TTLs** (`DISPLAY_TTL_SECONDS`, `LEADERBOARD_TTL_SECONDS`) to
  trade freshness for database load.

Do **not** disable rate limiting to relieve load. It is the thing standing
between you and the load getting worse.

---

## 6. A leaked API key

1. Rotate, using the key that still works:
   ```bash
   curl -X POST -H "Authorization: Bearer $CURRENT_KEY" \
     https://api.fanboard.com/api/admin/venues/$VENUE_ID/rotate-key
   ```
2. Update every client that holds it.
3. **Revoke the old key immediately** rather than letting the 24-hour grace
   window run:
   ```bash
   curl -X DELETE -H "Authorization: Bearer $NEW_KEY" \
     https://api.fanboard.com/api/admin/venues/$VENUE_ID/rotate-key
   ```
4. Review what was done with it:
   ```sql
   SELECT * FROM audit_logs WHERE venue_id = '...' ORDER BY created_at DESC LIMIT 100;
   ```

A key used after rotation but before revocation logs `venue authenticated with a
superseded API key` — useful for telling whether the leak was exercised.

---

## Escalation

| Condition | Action |
| --- | --- |
| Database down > 5 min | Page on-call, notify affected venues |
| Picks lost | Page on-call, notify venues **before** patrons notice |
| Redis down > 30 min | Page on-call — this is an open rate-limit window |
| One venue affected | Handle in hours |
| Sports provider down | Not an emergency; inform venues, grading catches up |
