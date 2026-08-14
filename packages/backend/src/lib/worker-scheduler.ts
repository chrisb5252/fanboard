import { closePool } from './db';
import { logger as rootLogger, type Logger } from './logger';
import { closeRedis } from './redis';
import {
  GRADE_GAMES_INTERVAL_MS,
  GRADE_GAMES_WORKER_NAME,
  gradeGamesOnce,
} from '../workers/grade-games';
import {
  POLL_GAMES_INTERVAL_MS,
  POLL_GAMES_WORKER_NAME,
  pollGamesOnce,
} from '../workers/poll-games';
import {
  UPDATE_LEADERBOARD_INTERVAL_MS,
  UPDATE_LEADERBOARD_WORKER_NAME,
  updateLeaderboardsOnce,
} from '../workers/update-leaderboard';

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
  /**
   * Injectable so tests can drive shutdown without raising a real signal.
   * Returns a function that removes the handler again.
   */
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => void) => (() => void) | void;
  /** Injectable so tests do not terminate the runner. */
  exit?: (code: number) => void;
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
  /** Removers for the signal handlers, run on stop so none are left dangling. */
  signalCleanup: (() => void)[];
  /** Logger supplied at start, so stopWorkers reports through the same sink. */
  logger: Logger | null;
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
    signalCleanup: [],
    logger: null,
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
    {
      name: GRADE_GAMES_WORKER_NAME,
      intervalMs: GRADE_GAMES_INTERVAL_MS,
      runImmediately: true,
      // Grading and leaderboard materialisation are chained rather than run as
      // independent timers: a settled game that waits up to 5 minutes for the
      // next leaderboard tick is a scoreboard the room can see is wrong. The
      // 5 minute timer below still runs, and covers picks graded by any other
      // path plus the rolling "today"/"this_week" window boundaries.
      run: async () => {
        const graded = await gradeGamesOnce();
        if (graded.gamesGraded > 0 || graded.gamesVoided > 0) {
          const refreshed = await updateLeaderboardsOnce();
          return { graded, refreshed };
        }
        return { graded };
      },
    },
    {
      name: UPDATE_LEADERBOARD_WORKER_NAME,
      intervalMs: UPDATE_LEADERBOARD_INTERVAL_MS,
      runImmediately: false,
      run: () => updateLeaderboardsOnce(),
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
  state.logger = log;

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
    state.signalCleanup = installSignalHandlers(
      log,
      options.registerSignalHandler ??
        ((signal, handler) => {
          process.once(signal, handler);
          return () => {
            process.off(signal, handler);
          };
        }),
      options.exit ?? ((code) => process.exit(code)),
    );
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
  // Report through whatever sink start was given, so a silenced scheduler stays
  // silent through shutdown too.
  const log = state.logger ?? rootLogger.child({ component: 'worker-scheduler' });

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

  // Leave no handlers behind: a stopped scheduler that still answers SIGTERM
  // would fire a second, pointless drain if the process is later signalled.
  for (const remove of state.signalCleanup) {
    remove();
  }
  state.signalCleanup = [];
  state.signalHandlersInstalled = false;
  state.logger = null;

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

/** Exit codes Node uses for signal termination: 128 + signal number. */
const EXIT_CODE_BY_SIGNAL: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Whether `next start` has left shutdown to us.
 *
 * `next start` registers its own SIGTERM/SIGINT handlers *before* the app is
 * loaded, and its cleanup ends in process.exit(). Node runs signal listeners in
 * registration order, so Next's runs first and terminates the process before an
 * async drain here could finish. Next's documented opt-out is
 * NEXT_MANUAL_SIG_HANDLE — when it is set Next installs nothing, and the
 * responsibility for both draining *and* exiting becomes ours.
 */
function weOwnShutdown(): boolean {
  return process.env['NEXT_MANUAL_SIG_HANDLE'] !== undefined;
}

function installSignalHandlers(
  log: Logger,
  register: (signal: NodeJS.Signals, handler: () => void) => (() => void) | void,
  exit: (code: number) => void,
): (() => void)[] {
  const owned = weOwnShutdown();
  const cleanup: (() => void)[] = [];

  if (!owned) {
    log.warn(
      'NEXT_MANUAL_SIG_HANDLE is not set: next start will exit on SIGTERM before workers can drain',
      { remedy: 'set NEXT_MANUAL_SIG_HANDLE=1 in the runtime environment' },
    );
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const remove = register(signal, () => {
      log.info('shutdown signal received', { signal });
      void stopWorkers(signal)
        .catch((error: unknown) => {
          log.error('graceful shutdown failed', { signal, error });
        })
        .finally(() => {
          // Only exit when Next is not going to. Calling it otherwise would
          // race Next's own exit and truncate its cleanup.
          if (owned) {
            exit(EXIT_CODE_BY_SIGNAL[signal] ?? 128);
          }
        });
    });
    if (typeof remove === 'function') {
      cleanup.push(remove);
    }
  }

  log.debug('signal handlers installed', { signals: ['SIGTERM', 'SIGINT'], ownsExit: owned });
  return cleanup;
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
