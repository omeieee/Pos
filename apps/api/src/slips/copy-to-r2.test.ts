import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FAKE_S3_CREDENTIALS, type FakeS3, startFakeS3 } from '../test-support/fake-s3.ts';
import { copySlipsToTarget } from './copy-to-r2.ts';
import { createR2SlipStore, R2_SLIP_PREFIX } from './r2-store.ts';
import { createFsSlipStore, newSlipKey } from './store.ts';

let s3: FakeS3;
let dir: string;
beforeEach(async () => {
  s3 = await startFakeS3();
  dir = await mkdtemp(join(tmpdir(), 'sds-slips-'));
});
afterEach(async () => {
  await s3.close();
  await rm(dir, { recursive: true, force: true });
});

const target = () =>
  createR2SlipStore({
    ...FAKE_S3_CREDENTIALS,
    prefix: R2_SLIP_PREFIX,
    endpoint: s3.endpoint,
    pageSize: 2,
  });

async function seed(count: number) {
  const source = createFsSlipStore(dir);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const key = newSlipKey();
    const bytes = Buffer.from(`slip picture ${i} `.repeat(10 + i));
    await source.put(key, bytes);
    files.set(key, bytes);
  }
  // Not ours: a temporary file and a stray name.
  await writeFile(join(dir, 'abc.tmp'), 'x');
  return { source, files };
}

describe('copySlipsToTarget', () => {
  test('a dry run (the default) reads and counts but writes nothing', async () => {
    const { source } = await seed(3);
    const report = await copySlipsToTarget({ source, target: target() });
    expect(report).toEqual({
      apply: false,
      found: 3,
      alreadyThere: 0,
      copied: 0,
      wouldCopy: 3,
      mismatched: 0,
      failed: 0,
    });
    expect(s3.objects.size).toBe(0);
  });

  test('--apply copies every file under its own key, verified by hash, and keeps the source', async () => {
    const { source, files } = await seed(5);
    const report = await copySlipsToTarget({ source, target: target(), apply: true });
    expect(report).toMatchObject({
      found: 5,
      copied: 5,
      alreadyThere: 0,
      mismatched: 0,
      failed: 0,
    });
    expect(s3.objects.size).toBe(5);
    for (const [key, bytes] of files) {
      const stored = s3.objects.get(`slips/${key}`)?.bytes as Buffer;
      expect(createHash('sha256').update(stored).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(await source.get(key)).toEqual(bytes); // the source is never touched
    }
  });

  test('a second run is idempotent: nothing is copied again', async () => {
    const { source } = await seed(4);
    await copySlipsToTarget({ source, target: target(), apply: true });
    s3.requests.length = 0;
    const report = await copySlipsToTarget({ source, target: target(), apply: true });
    expect(report).toMatchObject({ found: 4, alreadyThere: 4, copied: 0 });
    expect(s3.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  test('a partial earlier run is completed; a slip added later is picked up', async () => {
    const { source } = await seed(3);
    await copySlipsToTarget({ source, target: target(), apply: true });
    const [oneKey] = [...s3.objects.keys()];
    s3.objects.delete(oneKey as string);
    await source.put(newSlipKey(), Buffer.from('uploaded during the move'));
    const report = await copySlipsToTarget({ source, target: target(), apply: true });
    expect(report).toMatchObject({ found: 4, alreadyThere: 2, copied: 2 });
  });

  test('a copy that does not read back the same is reported, not hidden', async () => {
    const { source } = await seed(2);
    const real = target();
    const flaky = {
      ...real,
      put: async (key: string, bytes: Buffer) =>
        real.put(key, Buffer.concat([bytes, Buffer.from('!')])),
    };
    const report = await copySlipsToTarget({ source, target: flaky, apply: true });
    expect(report).toMatchObject({ found: 2, copied: 0, mismatched: 2 });
  });

  test('a store error on one file counts as failed and the others go on', async () => {
    const { source } = await seed(3);
    const real = target();
    let first = true;
    const flaky = {
      ...real,
      put: async (key: string, bytes: Buffer) => {
        if (first) {
          first = false;
          throw new Error('R2 put failed with status 500');
        }
        return real.put(key, bytes);
      },
    };
    const report = await copySlipsToTarget({ source, target: flaky, apply: true });
    expect(report).toMatchObject({ found: 3, copied: 2, failed: 1 });
  });
});
