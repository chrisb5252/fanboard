import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger';
import {
  getWorkerStatus,
  startWorkers,
  stopWorkers,
  type WorkerDefinition,
} from '../src/lib/worker-scheduler';

const silent = createLogger({ level: 'silent' });

const stopOpts = { closeConnections: false, drainTimeoutMs: 2000 } as const;

afterEach(async () => {
  await stopWorkers('test cleanup', stopOpts);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('worker-scheduler lifecycle', () => {
  it('runs immediately and reports running state', async () => {
    let runs = 0;
    const worker: WorkerDefinition = {
      name: 'w1',
      intervalMs: 10_000,
      runImmediately: true,
      run: async () => {
        runs += 1;
      },
    };

    startWorkers({ workers: [worker], logger: silent, installSignalHandlers: false });
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toBe(1);
    expect(getWorkerStatus().running).toBe(true);
    expect(getWorkerStatus().workers[0]?.name).toBe('w1');
  });

  it('is idempotent: a second start does not double-schedule', async () => {
    let runs = 0;
    const worker: WorkerDefinition = {
      name: 'w1',
      intervalMs: 10_000,
      runImmediately: true,
      run: async () => {
        runs += 1;
      },
    };

    expect(startWorkers({ workers: [worker], logger: silent, installSignalHandlers: false })).toBe(true);
    expect(startWorkers({ workers: [worker], logger: silent, installSignalHandlers: false })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toBe(1);
  });

  it('ticks on the interval', async () => {
    let runs = 0;
    startWorkers({
      workers: [{ name: 'fast', intervalMs: 15, run: async () => { runs += 1; } }],
      logger: silent,
      installSignalHandlers: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toBeGreaterThanOrEqual(3);
  });

  it('skips a tick while the previous one is still in flight', async () => {
    const gate = deferred();
    let started = 0;

    startWorkers({
      workers: [
        {
          name: 'slow',
          intervalMs: 10,
          runImmediately: true,
          run: async () => {
            started += 1;
            await gate.promise;
          },
        },
      ],
      logger: silent,
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 80));
    // Timer fired repeatedly, but only the first run was allowed to start.
    expect(started).toBe(1);
    expect(getWorkerStatus().workers[0]?.overlapsSkipped).toBeGreaterThan(0);

    gate.resolve();
  });

  it('waits for an in-flight tick to finish before reporting stopped', async () => {
    const gate = deferred();
    let finished = false;

    startWorkers({
      workers: [
        {
          name: 'draining',
          intervalMs: 10_000,
          runImmediately: true,
          run: async () => {
            await gate.promise;
            finished = true;
          },
        },
      ],
      logger: silent,
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 20));

    const stopping = stopWorkers('drain test', stopOpts);
    expect(finished).toBe(false);

    gate.resolve();
    await stopping;

    expect(finished).toBe(true);
    expect(getWorkerStatus().running).toBe(false);
  });

  it('gives up on a hung tick after the drain timeout', async () => {
    const gate = deferred();
    startWorkers({
      workers: [
        {
          name: 'hung',
          intervalMs: 10_000,
          runImmediately: true,
          run: () => gate.promise,
        },
      ],
      logger: silent,
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 20));

    const startedAt = Date.now();
    await stopWorkers('timeout test', { closeConnections: false, drainTimeoutMs: 60 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(getWorkerStatus().running).toBe(false);
    gate.resolve();
  });

  it('survives a worker that throws and keeps ticking', async () => {
    let runs = 0;
    startWorkers({
      workers: [
        {
          name: 'thrower',
          intervalMs: 15,
          runImmediately: true,
          run: async () => {
            runs += 1;
            throw new Error('boom');
          },
        },
      ],
      logger: silent,
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(getWorkerStatus().workers[0]?.failures).toBeGreaterThanOrEqual(3);
  });

  it('stopping when not running is a no-op', async () => {
    await expect(stopWorkers('never started', stopOpts)).resolves.toBeUndefined();
  });
});
