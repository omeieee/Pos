import { describe, expect, test } from 'vitest';
import { alertOnAttempt, backoffMs, superviseJobs } from './supervisor.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A manual timer: `fire()` runs the one pending callback, as if its delay had passed. */
function manualTimers() {
  let pending: { fn: () => void; ms: number } | undefined;
  const delays: number[] = [];
  return {
    delays,
    set: (fn: () => void, ms: number) => {
      pending = { fn, ms };
      delays.push(ms);
      return pending;
    },
    clear: (t: unknown) => {
      if (pending === t) pending = undefined;
    },
    hasPending: () => pending !== undefined,
    async fire() {
      const p = pending;
      pending = undefined;
      p?.fn();
      await tick();
    },
  };
}

describe('backoffMs', () => {
  test('doubles from 5 seconds and is capped at 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });
});

describe('alertOnAttempt', () => {
  test('alerts on the first failure and about hourly after that', () => {
    const alerted = Array.from({ length: 25 }, (_, i) => i + 1).filter(alertOnAttempt);
    expect(alerted).toEqual([1, 12, 24]);
  });
});

describe('superviseJobs', () => {
  test('returns at once and does not wait for the start', async () => {
    let release: (v: { stop(): Promise<void> }) => void = () => {};
    const sup = superviseJobs({
      start: () => new Promise((r) => (release = r)),
      onFailure: () => {},
      timers: manualTimers(),
    });
    expect(sup).toBeDefined(); // returned while start is still pending
    release({ stop: async () => {} });
  });

  test('a failed start is retried with growing delays, reporting a class name and code only', async () => {
    const t = manualTimers();
    const failures: unknown[] = [];
    let calls = 0;
    const err = Object.assign(new TypeError('secret host db.example.test password=hunter2'), {
      code: 'ECONNREFUSED',
    });
    superviseJobs({
      start: async () => {
        calls += 1;
        if (calls < 3) throw err;
        return { stop: async () => {} };
      },
      onFailure: (f) => failures.push(f),
      timers: t,
    });
    await tick();
    expect(calls).toBe(1);
    await t.fire();
    expect(calls).toBe(2);
    await t.fire();
    expect(calls).toBe(3);
    expect(t.hasPending()).toBe(false); // started: no more retries
    expect(t.delays).toEqual([5_000, 10_000]);
    expect(failures).toEqual([
      { attempt: 1, errorName: 'TypeError', code: 'ECONNREFUSED', nextRetryMs: 5_000 },
      { attempt: 2, errorName: 'TypeError', code: 'ECONNREFUSED', nextRetryMs: 10_000 },
    ]);
    expect(JSON.stringify(failures)).not.toContain('hunter2');
  });

  test('stop cancels a pending retry and stops running jobs', async () => {
    const t = manualTimers();
    const failing = superviseJobs({
      start: async () => {
        throw new Error('x');
      },
      onFailure: () => {},
      timers: t,
    });
    await tick();
    expect(t.hasPending()).toBe(true);
    await failing.stop();
    expect(t.hasPending()).toBe(false);

    let stopped = 0;
    const ok = superviseJobs({
      start: async () => ({
        stop: async () => {
          stopped += 1;
        },
      }),
      onFailure: () => {},
      timers: manualTimers(),
    });
    await tick();
    await ok.stop();
    expect(stopped).toBe(1);
  });

  test('a start that finishes after stop is stopped at once', async () => {
    let release: (v: { stop(): Promise<void> }) => void = () => {};
    let stopped = 0;
    const sup = superviseJobs({
      start: () => new Promise((r) => (release = r)),
      onFailure: () => {},
      timers: manualTimers(),
    });
    await sup.stop();
    release({
      stop: async () => {
        stopped += 1;
      },
    });
    await tick();
    expect(stopped).toBe(1);
  });
});
