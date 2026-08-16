# Production readiness

State of the system as of 2026-08-16, checked against the code rather than
against intent. Items are ticked only where I verified them here; anything that
depends on your Railway dashboard or your operational practice is left open,
because I cannot see it and a tick I did not earn is worse than a blank.

---

## Database

- [x] Schema is idempotent and re-runnable (`schema.sql`)
- [x] Key-rotation columns present (`previous_api_key`, `previous_api_key_expires_at`)
- [x] Suspension columns present (`suspended_at`, `suspended_reason`)
- [x] Tenant isolation enforced by composite foreign keys, not just application code
- [x] Backup script written **and run**, output verified (`scripts/backup.sh`)
- [x] Restore tested into a scratch database, integrity checks pass
- [x] Integrity queries documented (`RUNBOOKS.md` §10)
- [ ] **Railway automated backups enabled** — dashboard, cannot verify from here
- [ ] **A restore rehearsed by whoever will do it at 2am**, not just by me

## Backend

- [x] Binds `$PORT`, falls back to 3000 (verified both ways)
- [x] `/ws` shares the API port — no second listener
- [x] Health endpoint reports database, Redis and workers separately, bounded at 3s
- [x] Structured JSON logs to stdout
- [x] Workers: poll-games, lock-games, grade-games, update-leaderboard
- [x] Graceful shutdown drains in-flight work (`NEXT_MANUAL_SIG_HANDLE`)
- [ ] `NODE_ENV=production`, `NEXT_MANUAL_SIG_HANDLE=1`, `TRUSTED_PROXY_HOPS=2`,
      `CORS_ALLOWED_ORIGINS`, `APP`, `BACKEND_ORIGIN` set on Railway — dashboard
- [ ] `TRUSTED_PROXY_HOPS` **verified by tripping the limit**, not assumed

## Security

- [x] Session tokens httpOnly, Secure, SameSite=Lax (asserted on a real response)
- [x] All credentials 256-bit random, SHA-256 at rest
- [x] API key rotation with a grace window, plus immediate revocation
- [x] Every authenticated route carries a guard; three public routes are deliberate
- [x] CORS allowlist, fails closed in production
- [x] HSTS and HTTPS redirect, health probe exempt
- [x] Rate limiting on players, picks and display reads
- [x] Venue isolation verified at service **and** database level
- [ ] Secret scanning in CI (`gitleaks`) — not set up

> The brief's checklist says "venue isolation verified (404 for cross-venue, not
> 403)". Both codes are correct, for different things: a session used against
> another venue's URL is **403** (authenticated, wrong venue), while a *game*
> belonging to another venue is **404** (a 403 would confirm the id exists and
> allow enumeration). Both are tested.

## Observability

- [x] JSON logs to stdout, captured by Railway
- [x] Errors carry context (venue_id, game_id, player_session_id)
- [x] Audit trail for privileged actions, details redacted
- [x] Rate-limit rejections logged with a monitor hook
- [ ] Logs shipped anywhere beyond Railway's retention
- [ ] Alerts on `rate limiting degraded`, `leaderboard_mismatch`,
      `no trustworthy client IP` — no alerting configured

## Admin tools

- [x] Suspend / resume venue
- [x] Void pick
- [x] Reconcile player, reporting whether the repair worked
- [x] Inspect pick, with state named in words
- [x] Audit log endpoint
- [ ] **Manual grading endpoint — not built.** See gaps.

## Ops

- [x] 10 runbooks (`RUNBOOKS.md`)
- [x] Backup and restore procedure, tested
- [x] Deployment guide with the Railway specifics (`DEPLOYMENT.md`)
- [ ] On-call rotation and escalation contacts — yours to define
- [ ] Ops walked through the runbooks

## Tests

- [x] 551 tests, three consecutive full runs, no flakes
- [x] Coverage 82% statements / 80.6% branches; workers 91%, services 91%
- [x] Concurrency: pick races, lock boundary, double settlement, snapshot races
- [x] Venue isolation under concurrent cross-venue load
- [x] Load: 100 concurrent players, p95 18ms, 0 errors
- [ ] `websocket.ts` branch coverage still 62% — the weakest module

---

## Gaps that matter

**No manual grading endpoint.** If the sports provider never reports a game
final, its picks stay ungraded and there is no supported way to settle them.
This is the most likely incident with no tool behind it. I did not build it in
this pass rather than ship a half-tested endpoint that writes scores — it needs
the same idempotency guarantees as the worker, and those deserve tests before
an operator points it at a live venue.

**No alerting.** Everything needed is in the logs, and nothing is watching
them. `leaderboard_mismatch` in particular is logged at error level and should
page someone.

**Audit log grows without bound.** No retention job; the 90-day policy is
aspirational.

**`websocket.ts` at 62% branch coverage.** The realtime layer's failure paths —
subscriber errors, malformed frames, heartbeat termination — are the least
exercised code in the system.

**Single-region, single-instance assumptions are now tested but not exercised.**
The snapshot race was found and fixed by test, not by production traffic.

---

## Sign-off

**Ready for a pilot at one or two venues, with the operator's phone next to
them.** Not ready for unattended multi-venue operation.

What makes the difference between those two is short: Railway backups enabled
and a restore rehearsed, `TRUSTED_PROXY_HOPS` verified by tripping the limit,
and someone on call who has read `RUNBOOKS.md` before the night they need it.

Recommended go-live: the first Saturday **after** those three are done, with
whoever is on call watching the logs for the first hour. Do not schedule the
first live night against a marquee fixture — pick a quiet one, where a problem
costs a shrug rather than a room.
