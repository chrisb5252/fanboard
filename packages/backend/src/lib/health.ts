/** Shared shape for dependency health probes (Postgres, Redis, ...). */
export interface HealthStatus {
  /** Name of the checked dependency, e.g. "postgres". */
  readonly dependency: string;
  readonly healthy: boolean;
  readonly latencyMs: number;
  /** Present only when `healthy` is false. */
  readonly error?: string;
}

/**
 * Runs a probe and turns any failure into a HealthStatus rather than a throw,
 * so a health endpoint can report a degraded dependency instead of 500ing.
 */
export async function probe(
  dependency: string,
  check: () => Promise<boolean>,
): Promise<HealthStatus> {
  const startedAt = Date.now();
  try {
    const healthy = await check();
    const latencyMs = Date.now() - startedAt;
    return healthy
      ? { dependency, healthy: true, latencyMs }
      : { dependency, healthy: false, latencyMs, error: 'probe returned false' };
  } catch (error) {
    return {
      dependency,
      healthy: false,
      latencyMs: Date.now() - startedAt,
      // Falls back to the constructor name because some client libraries throw
      // errors with an empty message — a connection timeout being the common
      // one. "unhealthy, reason: (blank)" is what an on-call engineer reads at
      // 3am, and it tells them nothing.
      error: describeError(error),
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message !== '' ? error.message : error.constructor.name;
  }
  const described = String(error);
  return described !== '' ? described : 'unknown error';
}
