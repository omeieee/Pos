import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FAKE_S3_CREDENTIALS, type FakeS3, startFakeS3 } from '../test-support/fake-s3.ts';
import { createR2SlipStore, R2_RECEIPT_PREFIX, R2_SLIP_PREFIX } from './r2-store.ts';
import { newSlipKey, type SlipStore } from './store.ts';

let s3: FakeS3;
beforeEach(async () => {
  s3 = await startFakeS3();
});
afterEach(async () => {
  await s3.close();
});

const store = (prefix: string, extra: Record<string, unknown> = {}): SlipStore =>
  createR2SlipStore({
    ...FAKE_S3_CREDENTIALS,
    prefix,
    endpoint: s3.endpoint,
    pageSize: 2,
    ...extra,
  });

describe('R2 store', () => {
  test('put, get and delete under the prefix with signed requests', async () => {
    const slips = store(R2_SLIP_PREFIX);
    const key = newSlipKey();
    await slips.put(key, Buffer.from('hello'));
    expect([...s3.objects.keys()]).toEqual([`slips/${key}`]);
    expect(await slips.get(key)).toEqual(Buffer.from('hello'));
    await slips.delete(key);
    expect(await slips.get(key)).toBeNull();
    await slips.delete(key); // already gone: not an error
  });

  test('list pages through every object and sees only its own prefix', async () => {
    const slips = store(R2_SLIP_PREFIX);
    const receipts = store(R2_RECEIPT_PREFIX);
    const slipKeys = [newSlipKey(), newSlipKey(), newSlipKey(), newSlipKey(), newSlipKey()];
    for (const key of slipKeys) await slips.put(key, Buffer.alloc(10, 1));
    const receiptKey = newSlipKey();
    await receipts.put(receiptKey, Buffer.alloc(7, 2));
    s3.objects.set('slips/not-a-key', { bytes: Buffer.alloc(1), at: new Date() });

    const listed = await slips.list();
    expect(listed.map((f) => f.key).sort()).toEqual([...slipKeys].sort());
    expect(listed.every((f) => f.size === 10 && f.modifiedAt.getTime() > 0)).toBe(true);
    // 6 objects under slips/, two per page: three pages.
    expect(s3.requests.filter((r) => r.query.includes('list-type')).length).toBe(3);
    expect((await receipts.list()).map((f) => [f.key, f.size])).toEqual([[receiptKey, 7]]);
  });

  test('a wrong secret is refused and the error carries the status only', async () => {
    const bad = store(R2_SLIP_PREFIX, { secretAccessKey: 'wrong' });
    const error = await bad.put(newSlipKey(), Buffer.from('x')).catch((e: Error) => e);
    expect((error as Error).message).toBe('R2 put failed with status 403');
    expect(s3.objects.size).toBe(0);
  });

  test('a server error throws, and a key that is not ours never reaches the network', async () => {
    const slips = store(R2_SLIP_PREFIX);
    s3.failNext(1);
    await expect(slips.get(newSlipKey())).rejects.toThrow('R2 get failed with status 500');
    const before = s3.requests.length;
    await expect(slips.get('../etc/passwd')).rejects.toThrow('invalid slip key');
    expect(s3.requests.length).toBe(before);
  });

  test('a slow server hits the timeout', async () => {
    const slips = store(R2_SLIP_PREFIX, {
      timeoutMs: 20,
      fetch: (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(slips.get(newSlipKey())).rejects.toThrow();
  });
});
