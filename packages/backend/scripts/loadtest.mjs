/**
 * FanBoard load test — 100 concurrent players against a running deployment.
 *
 *   VENUE_ID=<uuid> BASE=https://api.fanboard.com node packages/backend/scripts/loadtest.mjs
 *
 * Models a busy venue rather than a synthetic hammer. Patrons mostly read — the
 * games list and the leaderboard refresh on a timer — and occasionally write a
 * pick, roughly 4:1. A pure-write benchmark measures something no venue does,
 * and a spin loop measures how fast Node loops rather than how the service
 * behaves, so each virtual player sleeps between requests like a real client.
 *
 * Two headers matter:
 *
 *  - `x-forwarded-for` is unique per player, so the per-IP session limit sees
 *    100 distinct clients. Without it, player 6 onwards is rejected with 429
 *    and the test measures the rate limiter instead of the service.
 *  - `x-forwarded-proto: https` is what a TLS-terminating proxy sets. Against a
 *    production build over plain HTTP the app correctly answers 308, and every
 *    request would fail. Send this rather than weakening the build.
 *
 * Targets: p95 < 500ms, 5xx error rate < 0.1%.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env['BASE'] ?? 'http://localhost:3000';
const VENUE_ID = process.env['VENUE_ID'];
const PLAYERS = Number(process.env['PLAYERS'] ?? 100);
const DURATION_MS = Number(process.env['DURATION_MS'] ?? 20_000);

if (VENUE_ID === undefined) {
  console.error('VENUE_ID is required');
  process.exit(1);
}

const PROXY = { 'x-forwarded-proto': 'https' };

const samples = [];
let errors = 0;
let rateLimited = 0;

/** A distinct address per player; 100 never collide. */
function ipFor(index) {
  return `203.0.${Math.floor(index / 250) + 1}.${(index % 250) + 1}`;
}

async function timed(label, fn) {
  const startedAt = performance.now();
  try {
    const response = await fn();
    samples.push({ label, ms: performance.now() - startedAt, status: response.status });
    if (response.status === 429) rateLimited += 1;
    else if (response.status >= 500) errors += 1;
    return response;
  } catch {
    samples.push({ label, ms: performance.now() - startedAt, status: 0 });
    errors += 1;
    return null;
  }
}

/** Pickable games, read from the API so the script needs no database access. */
async function loadGameIds() {
  const response = await fetch(`${BASE}/api/venues/${VENUE_ID}/games`, { headers: PROXY });
  if (!response.ok) {
    throw new Error(`could not load games: HTTP ${response.status}`);
  }
  const games = await response.json();
  const open = games.filter((game) => game.status === 'scheduled').map((game) => game.id);
  if (open.length === 0) {
    // Worth failing loudly: with every game locked, every pick returns 423 and
    // the run silently measures the rejection path instead of the write path.
    throw new Error('no open games at this venue — the pick path would not be exercised');
  }
  return open;
}

async function player(index, gameIds) {
  const ip = ipFor(index);
  const headers = { 'x-forwarded-for': ip, ...PROXY };

  const joined = await timed('POST /players', () =>
    fetch(`${BASE}/api/venues/${VENUE_ID}/players`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ nickname: `Load${index}-${Math.random().toString(36).slice(2, 7)}` }),
    }),
  );

  if (joined === null || joined.status !== 201) return;
  const token = /session_token=([^;]+)/.exec(joined.headers.get('set-cookie') ?? '')?.[1];
  if (token === undefined) return;

  const deadline = Date.now() + DURATION_MS;
  let n = 0;

  while (Date.now() < deadline) {
    n += 1;

    if (n % 5 === 0) {
      await timed('POST /picks', () =>
        fetch(`${BASE}/api/venues/${VENUE_ID}/picks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `session_token=${token}`, ...headers },
          body: JSON.stringify({
            gameId: gameIds[n % gameIds.length],
            predictedWinner: n % 2 === 0 ? 'home' : 'away',
          }),
        }),
      );
    } else if (n % 2 === 0) {
      await timed('GET /games', () =>
        fetch(`${BASE}/api/venues/${VENUE_ID}/games`, { headers }),
      );
    } else {
      await timed('GET /leaderboard', () =>
        fetch(`${BASE}/api/venues/${VENUE_ID}/leaderboard`, { headers }),
      );
    }

    await sleep(200 + Math.random() * 300);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function report(label, rows) {
  if (rows.length === 0) return;
  const sorted = rows.map((row) => row.ms).sort((a, b) => a - b);
  const bad = rows.filter((row) => row.status === 0 || row.status >= 500).length;
  console.log(
    `  ${label.padEnd(18)} n=${String(rows.length).padStart(5)}  ` +
      `p50=${percentile(sorted, 50).toFixed(0).padStart(4)}ms  ` +
      `p95=${percentile(sorted, 95).toFixed(0).padStart(4)}ms  ` +
      `p99=${percentile(sorted, 99).toFixed(0).padStart(4)}ms  errors=${bad}`,
  );
}

const gameIds = await loadGameIds();
console.log(`  ${PLAYERS} players · ${DURATION_MS / 1000}s · ${gameIds.length} open games · ${BASE}\n`);

const startedAt = Date.now();
await Promise.all(Array.from({ length: PLAYERS }, (_, i) => player(i, gameIds)));
const elapsed = (Date.now() - startedAt) / 1000;

const all = samples.map((sample) => sample.ms).sort((a, b) => a - b);

for (const label of ['POST /players', 'GET /games', 'GET /leaderboard', 'POST /picks']) {
  report(label, samples.filter((sample) => sample.label === label));
}

const statuses = {};
for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
const errorRate = (errors / samples.length) * 100;
const p95 = percentile(all, 95);

console.log(`\n  requests ${samples.length} · ${(samples.length / elapsed).toFixed(0)} req/s`);
console.log(`  p50 ${percentile(all, 50).toFixed(0)}ms · p95 ${p95.toFixed(0)}ms · p99 ${percentile(all, 99).toFixed(0)}ms`);
console.log(`  status ${JSON.stringify(statuses)} · rate limited ${rateLimited}`);
console.log(`\n  p95 < 500ms:   ${p95 < 500 ? 'PASS' : 'FAIL'} (${p95.toFixed(0)}ms)`);
console.log(`  errors < 0.1%: ${errorRate < 0.1 ? 'PASS' : 'FAIL'} (${errorRate.toFixed(3)}%)`);

process.exit(p95 < 500 && errorRate < 0.1 ? 0 : 1);
