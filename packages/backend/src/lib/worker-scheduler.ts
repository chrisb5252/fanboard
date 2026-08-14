import { closePool } from './db';
import { logger as rootLogger, type Logger } from './logger';
import { closeRedis } from './redis';
import {
  POLL_GAMES_INTERVAL_MS,
  POLL_GAMES_WORKER_NAME,
  pollGamesOnce,
} from '../workers/poll-games';

export interface WorkerDefinition {
  readonly name: string;
  readonly intervalMs: number;
  /** Run once immediately on start rather than waiting a full interval. */
  readonly runImmediately?: boolean;
  run(): Promise<unknown>;
}

export interface StartWorkersOptions {
  workers?: readonly WorkerDefinition[];
  logger?: Logger;
  /** Skip process signal handlers. Tests use this. */
  installSignalHandlers?: boolean;
}

export interface StopWorkersOptions {
  /** How long to wait for in-flight ticks before giving up. */
  drainTimeoutMs?: number;
  /** Close the pg pool and Redis client after draining. */
  closeConnections?: boolean;
}

interface WorkerState {
  readonly definition: WorkerDefinition;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  runs: number;
  failures: number;
  overlapsSkipped: number;
}

interface SchedulerState {
  workers: Map<string, WorkerState>;
  running: boolean;
  stopping: boolean;
  signalHandlersInstalled: boolean;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/**
 * Scheduler state lives on globalThis so a hot reload — or Next importing this
 * module through two different bundles — cannot start a second set of timers
 * against the same database.
 */
const globalForScheduler = globalThis as unknown as { fanboardScheduler?: SchedulerState };

function getState(): SchedulerState {
  const existing = globalForScheduler.fanboardScheduler;
  if (existing !== undefined) {
    return existing;
  }
  const created: SchedulerState = {
    workers: new Map(),
    running: false,
    stopping: false,
    signalHandlersInstalled: false,
  };
  globalForScheduler.fanboardScheduler = created;
  return created;
}

function defaultWorkers(): WorkerDefinition[] {
  return [
    {
      name: POLL_GAMES_WORKER_NAME,
      intervalMs: POLL_GAMES_INTERVAL_MS,
      runImmediately: true,
      run: () => pollGamesOnce(),
    },
  ];
}

/**
 * Executes one tick.
 *
 * If the previous tick is still running the new one is skipped rather than
 * queued: poll-games talks to a rate-limited API and a slow run must not build
 * up a backlog of overlapping ticks that all hammer it at once.
 */
function tick(state: WorkerState, log: Logger): void {
  if (state.inFlight !== null) {
    state.overlapsSkipped += 1;
    log.warn('tick skipped, previous run still in flight', {
      worker: state.definition.name,
      overlapsSkipped: state.overlapsSkipped,
    });
    return;
  }

  const startedAt = Date.now();
  state.runs += 1;

  state.inFlight = (async () => {
    try {
      const result = await state.definition.run();
      log.debug('tick complete', {
        worker: state.definition.name,
        durationMs: Date.now() - startedAt,
        result,
      });
    } catch (error) {
      // A worker is expected to handle its own errors; reaching here means it
      // did not, and the scheduler absorbs it so the timer survives.
      state.failures += 1;
      log.error('tick threw; worker continues', {
        worker: state.definition.name,
        durationMs: Date.now() - startedAt,
        failures: state.failures,
        error,
      });
    } finally {
      state.inFlight = null;
    }
  })();
}

/**
 * Starts every worker. Idempotent — calling it twice is a no-op, which matters
 * because Next.js can evaluate the instrumentation hook more than once.
 *
 * Returns true when this call actually started the scheduler.
 */
export function startWorkers(options: StartWorkersOptions = {}): boolean {
  const state = getState();
  const log = options.logger ?? rootLogger.child({ component: 'worker-scheduler' });

  if (state.running) {
    log.debug('scheduler already running; start ignored');
    return false;
  }

  const definitions = options.workers ?? defaultWorkers();
  state.running = true;
  state.stopping = false;

  for (const definition of definitions) {
    if (state.workers.has(definition.name)) {
      log.warn('duplicate worker name ignored', { worker: definition.name });
      continue;
    }

    const workerState: WorkerState = {
      definition,
      timer: null,
      inFlight: null,
      runs: 0,
      failures: 0,
      overlapsSkipped: 0,
    };

    const timer = setInterval(() => {
      tick(workerState, log);
    }, definition.intervalMs);

    // Do not hold the event loop open purely for a timer.
    timer.unref?.();
    workerState.timer = timer;
    state.workers.set(definition.name, workerState);

    log.info('worker started', {
      worker: definition.name,
      intervalMs: definition.intervalMs,
      runImmediately: definition.runImmediately === true,
    });

    if (definition.runImmediately === true) {
      tick(workerState, log);
    }
  }

  if ((options.installSignalHandlers ?? true) && !state.signalHandlersInstalled) {
    installSignalHandlers(log);
    state.signalHandlersInstalled = true;
  }

  log.info('scheduler started', { workers: [...state.workers.keys()] });
  return true;
}

/**
 * Stops timers and waits for in-flight ticks to finish, bounded by
 * `drainTimeoutMs` so a hung worker cannot block shutdown forever.
 */
export async function stopWorkers(
  reason: string,
  options: StopWorkersOptions = {},
): Promise<void> {
  const state = getState();
  const log = rootLogger.child({ component: 'worker-scheduler' });

  if (!state.running || state.stopping) {
    log.debug('scheduler not running; stop ignored', { reason });
    return;
  }

  state.stopping = true;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  log.info('scheduler stopping', { reason, drainTimeoutMs });

  const pending: Promise<void>[] = [];

  for (const [name, workerState] of state.workers) {
    if (workerState.timer !== null) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
    if (workerState.inFlight !== null) {
      pending.push(workerState.inFlight);
    }
    log.info('worker stopped', {
      worker: name,
      runs: workerState.runs,
      failures: workerState.failures,
      overlapsSkipped: workerState.overlapsSkipped,
      draining: workerState.inFlight !== null,
    });
  }

  if (pending.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
    });

    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => 'drained' as const),
      timeout,
    ]);

    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (outcome === 'timeout') {
      log.error('drain timed out; abandoning in-flight ticks', {
        pending: pending.length,
        drainTimeoutMs,
      });
    } else {
      log.info('all in-flight ticks drained', { drained: pending.length });
    }
  }

  state.workers.clear();
  state.running = false;
  state.stopping = false;

  if (options.closeConnections ?? true) {
    await closeConnections(log);
  }

  log.info('scheduler stopped', { reason });
}

async function closeConnections(log: Logger): Promise<void> {
  const results = await Promise.allSettled([closePool(), closeRedis()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      log.error('failed to close a connection during shutdown', {
        error: result.reason instanceof Error ? result.reason : String(result.reason),
      });
    }
  }
}

function installSignalHandlers(log: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('shutdown signal received', { signal });
      void stopWorkers(signal).catch((error: unknown) => {
        log.error('graceful shutdown failed', { signal, error });
      });
    });
  }
  log.debug('signal handlers installed', { signals: ['SIGTERM', 'SIGINT'] });
}

/** Introspection for health endpoints and tests. */
export function getWorkerStatus(): {
  running: boolean;
  workers: { name: string; runs: number; failures: number; overlapsSkipped: number }[];
} {
  const state = getState();
  return {
    running: state.running,
    workers: [...state.workers.values()].map((worker) => ({
      name: worker.definition.name,
      runs: worker.runs,
      failures: worker.failures,
      overlapsSkipped: worker.overlapsSkipped,
    })),
  };
}
