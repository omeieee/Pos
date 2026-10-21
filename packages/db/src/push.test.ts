import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import * as people from './people.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as repo from './push.ts';

let db: PgliteDb;
let client: PGlite;
let staffId: string;
let seq = 0;
const NOW = new Date('2026-10-22T05:00:00.000Z');

const device = async () =>
  (await auth.insertDevice(db, { name: `d${++seq}`, kind: 'iphone', tokenHash: `h${seq}` })).id;
const sub = (deviceId: string, endpoint = `https://fcm.googleapis.com/fcm/send/${seq}`) => ({
  deviceId,
  staffId,
  endpoint,
  p256dh: 'p',
  auth: 'a',
  now: NOW,
});
const rowOf = async (deviceId: string) =>
  (await repo.listDeliverable(db)).find((r) => r.deviceId === deviceId);

beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
  staffId = (
    await auth.insertOwner(db, {
      email: 'o@example.test',
      displayName: 'o',
      passwordHash: 'x',
      pinHash: null,
      encryptTotpSecret: () => 'e',
      recoveryCodeHashes: [],
    })
  ).staffId;
}, 60_000);
afterAll(async () => {
  await client.close();
});

describe('push subscriptions', () => {
  test('upsert is one row per device and replaces the keys', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d, 'https://fcm.googleapis.com/fcm/send/one'));
    await repo.upsertForDevice(db, {
      ...sub(d, 'https://fcm.googleapis.com/fcm/send/two'),
      p256dh: 'p2',
    });
    const rows = (await repo.listDeliverable(db)).filter((r) => r.deviceId === d);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: 'https://fcm.googleapis.com/fcm/send/two',
      p256dh: 'p2',
    });
  });

  test('a re-subscribe resets the failure count', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d));
    await repo.recordFailure(db, (await rowOf(d))?.id ?? '', 3);
    await repo.upsertForDevice(db, sub(d));
    expect((await rowOf(d))?.failureCount).toBe(0);
  });

  test('the same endpoint on another device moves to the new device', async () => {
    const a = await device();
    const b = await device();
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/same';
    await repo.upsertForDevice(db, sub(a, endpoint));
    await repo.upsertForDevice(db, sub(b, endpoint));
    expect(await repo.existsForDevice(db, a)).toBe(false);
    expect(await repo.existsForDevice(db, b)).toBe(true);
  });

  test('delete by device reports whether a row existed', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d));
    expect(await repo.deleteForDevice(db, d)).toBe(true);
    expect(await repo.deleteForDevice(db, d)).toBe(false);
    expect(await repo.existsForDevice(db, d)).toBe(false);
  });

  test('a revoked device is not deliverable', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d));
    await people.revokeDevice(db, d, NOW);
    expect(await rowOf(d)).toBeUndefined();
    expect(await repo.existsForDevice(db, d)).toBe(true);
  });

  test('success sets last_success_at and clears the count; failures count and drop at the limit', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d));
    const id = (await rowOf(d))?.id ?? '';
    expect(await repo.recordFailure(db, id, 3)).toBe('kept');
    expect(await repo.recordFailure(db, id, 3)).toBe('kept');
    await repo.markSuccess(db, id, NOW);
    const ok = await rowOf(d);
    expect(ok?.failureCount).toBe(0);
    expect(ok?.lastSuccessAt).toEqual(NOW);
    expect(await repo.recordFailure(db, id, 3)).toBe('kept');
    expect(await repo.recordFailure(db, id, 3)).toBe('kept');
    expect(await repo.recordFailure(db, id, 3)).toBe('dropped');
    expect(await repo.existsForDevice(db, d)).toBe(false);
  });

  test('delete by id removes one subscription', async () => {
    const d = await device();
    await repo.upsertForDevice(db, sub(d));
    await repo.deleteById(db, (await rowOf(d))?.id ?? '');
    expect(await repo.existsForDevice(db, d)).toBe(false);
  });
});
