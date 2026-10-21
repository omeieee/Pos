import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createLineRuntime } from '../line/runtime.ts';
import { createMemorySlipStore, type SlipStore } from '../slips/store.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { JOBS, type JobDeps } from './jobs.ts';
import { R2_FREE_BYTES, STORAGE_WARN_RATIO } from './storage-usage.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.alerts.length = 0;
});

/** A store that only reports sizes: no bytes are held. */
const sized = (...sizes: number[]): SlipStore => ({
  ...createMemorySlipStore(),
  list: async () =>
    sizes.map((size, i) => ({ key: String(i).padStart(32, 'k'), modifiedAt: new Date(), size })),
});

const run = (slips: SlipStore, receipts?: SlipStore) => {
  const job = JOBS.find((j) => j.name === 'storage-usage-check');
  if (!job) throw new Error('no such job');
  const deps: JobDeps = {
    db: h.db,
    events: h.bus,
    now: h.clock.now,
    line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
    slips,
    ...(receipts ? { receipts } : {}),
  };
  return job.run(deps);
};

describe('storage-usage-check (D-36)', () => {
  test('is a nightly job', () => {
    const job = JOBS.find((j) => j.name === 'storage-usage-check');
    expect(job?.cron.trim().split(/\s+/)).toHaveLength(5);
  });

  test('sums bytes and files of both stores and stays quiet below 70%', async () => {
    const result = await run(sized(1_000_000, 2_000_000), sized(500_000));
    expect(result).toMatchObject({
      slipFiles: 2,
      receiptFiles: 1,
      usedBytes: 3_500_000,
      alerts: 0,
    });
    expect(h.alerts).toHaveLength(0);
  });

  test('warns the owner once the total passes 70% of the free 10 GB', async () => {
    expect(STORAGE_WARN_RATIO).toBe(0.7);
    const justUnder = R2_FREE_BYTES * 0.7; // exactly 70%: not above it
    expect((await run(sized(justUnder))).alerts).toBe(0);
    const result = await run(sized(justUnder), sized(1));
    expect(result).toMatchObject({ alerts: 1, usedPercent: 70 });
    const alert = h.alerts.find((a) => a.kind === 'storage.quota_high');
    expect(alert?.severity).toBe('warn');
  });

  test('works without a receipts store (a deployment that has none)', async () => {
    expect(await run(sized(10))).toMatchObject({ slipFiles: 1, receiptFiles: 0, usedBytes: 10 });
  });
});
