import { describe, expect, it, vi } from 'vitest';
import { createPoolWatchdog } from './pool-watchdog.ts';

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error('down'));
const hang = () => new Promise<void>(() => {});

function setup(checkPool: () => Promise<void>, checkFresh: () => Promise<void>) {
  const onWedged = vi.fn();
  const watchdog = createPoolWatchdog({
    checkPool,
    checkFresh,
    onWedged,
    intervalMs: 3_600_000,
    threshold: 3,
    timeoutMs: 20,
  });
  return { onWedged, tick: watchdog.tick, stop: watchdog.stop };
}

describe('createPoolWatchdog', () => {
  it('does nothing while the pool works', async () => {
    const { onWedged, tick, stop } = setup(ok, ok);
    for (let i = 0; i < 5; i++) await tick();
    stop();
    expect(onWedged).not.toHaveBeenCalled();
  });

  it('reports a wedged pool after three failures while fresh connections work', async () => {
    const { onWedged, tick, stop } = setup(hang, ok);
    await tick();
    await tick();
    expect(onWedged).not.toHaveBeenCalled();
    await tick();
    stop();
    expect(onWedged).toHaveBeenCalledTimes(1);
  });

  it('never reports a real database outage (fresh connections fail too)', async () => {
    const { onWedged, tick, stop } = setup(fail, fail);
    for (let i = 0; i < 6; i++) await tick();
    stop();
    expect(onWedged).not.toHaveBeenCalled();
  });

  it('resets the count when the pool recovers', async () => {
    let poolOk = false;
    const { onWedged, tick, stop } = setup(() => (poolOk ? ok() : fail()), ok);
    await tick();
    await tick();
    poolOk = true;
    await tick();
    poolOk = false;
    await tick();
    await tick();
    stop();
    expect(onWedged).not.toHaveBeenCalled();
  });
});
