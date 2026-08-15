import { NextResponse } from 'next/server';
import { checkDatabaseHealth } from '../../../lib/db';
import { logger as rootLogger } from '../../../lib/logger';
import { checkRedisHealth } from '../../../lib/redis';
import { getWorkerStatus } from '../../../lib/worker-scheduler';
import type { HealthStatus } from '../../../lib/health';

/** Never cached: a cached health check reports the past. */
export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: 'GET /api/health' });

interface WorkerHealth {
  readonly dependency: 'workers';
  readonly healthy: boolean;
  readonly running: boolean;
  readonly workers: { name: string; runs: number; failures: number; overlapsSkipped: number }[];
  readonly error?: string;
}

/**
 * Worker health, which is not the same question as "is the process up".
 *
 * A worker host whose scheduler is stopped still answers HTTP perfectly well
 * while games quietly stop grading, so this is reported explicitly rather than
 * inferred from the fact that a response came back at all.
 *
 * Failures are counted, not fatal. Workers are built to survive a bad poll and
 * retry, so a non-zero failure count is normal operation; only a scheduler that
 * is not running at all is unhealthy. Web-only deployments that intentionally
 * run no workers set WORKERS_ENABLED=false and are not marked down for it.
 */
function checkWorkers(): WorkerHealth {
  const status = getWorkerStatus();
  const expected = process.env['WORKERS_ENABLED'] !== 'false';

  if (!expected) {
    return { dependency: 'workers', healthy: true, running: status.running, workers: [] };
  }

  return status.running
    ? { dependency: 'workers', healthy: true, running: true, workers: status.workers }
    : {
        dependency: 'workers',
        healthy: false,
        running: false,
        workers: status.workers,
        error: 'worker scheduler is not running',
      };
}

/**
 * Ceiling on how long the whole check may take.
 *
 * Measured, not guessed: with Redis stopped, its client took just over five
 * seconds to give up, so the endpoint answered in 5004ms. Every platform health
 * probe has a timeout in that range — the Dockerfile's is 5s — which means a
 * real Redis outage produced a *probe timeout* rather than the clean 503 this
 * endpoint was carefully written to return. The orchestrator then reports
 * "health check timed out", which says nothing about which dependency failed.
 *
 * Answering within the budget is what makes the 503 useful.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout(
  dependency: string,
  probe: Promise<HealthStatus>,
): Promise<HealthStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<HealthStatus>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          dependency,
          healthy: false,
          latencyMs: PROBE_TIMEOUT_MS,
          error: `probe exceeded ${PROBE_TIMEOUT_MS}ms`,
        }),
      PROBE_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    // Without this the pending timer keeps the event loop alive, which turns a
    // fast healthy response into a process that will not exit.
    clearTimeout(timer);
  }
}

/**
 * Liveness and readiness for load balancers and the deployment runbook.
 *
 * 200 when every dependency is reachable, 503 when any is not, so a platform
 * health check can act on the status code without parsing the body. The body
 * names which dependency failed, because "unhealthy" alone sends an on-call
 * engineer looking in three places at once.
 *
 * Unauthenticated by design — a load balancer cannot present a credential — so
 * it deliberately reveals nothing beyond dependency names, booleans, and
 * latencies. No connection strings, no versions, no counts of anything a
 * competitor or an attacker could use.
 *
 * Probes run concurrently: a health check that serialises its dependencies
 * takes the sum of their timeouts, which is exactly when it gets killed for
 * being slow.
 */
export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();

  const [database, redis] = await Promise.all([
    withTimeout('postgres', checkDatabaseHealth()),
    withTimeout('redis', checkRedisHealth()),
  ]);
  const workers = checkWorkers();

  const dependencies: (HealthStatus | WorkerHealth)[] = [database, redis, workers];
  const healthy = dependencies.every((dependency) => dependency.healthy);

  if (!healthy) {
    log.error('health check failed', {
      database: database.healthy,
      redis: redis.healthy,
      workers: workers.healthy,
    });
  }

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      dependencies: { database, redis, workers },
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
