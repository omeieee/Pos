import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import * as orders from './orders.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as repo from './print.ts';
import { menuCategories, menuItems } from './schema.ts';

let db: PgliteDb;
let client: PGlite;
let deviceId: string;
let staffId: string;
let menuItemId: string;
let seq = 0;

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
  deviceId = (await auth.insertDevice(db, { name: 'printer', kind: 'print_agent', tokenHash: 'h' }))
    .id;
  const [category] = await db.insert(menuCategories).values({ nameTh: 'c' }).returning();
  const [item] = await db
    .insert(menuItems)
    .values({
      categoryId: category?.id ?? '',
      nameTh: 'n',
      priceSatang: 5000,
      channels: ['storefront'],
    })
    .returning();
  menuItemId = item?.id ?? '';
}, 60_000);
afterAll(async () => {
  await client.close();
});

const T0 = new Date('2026-10-22T05:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

async function newOrder(): Promise<string> {
  seq += 1;
  const row = await orders.insertOrder(db, {
    orderNo: `S-${String(seq).padStart(3, '0')}`,
    businessDate: '2026-10-22',
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'A',
    recipientName: 'x',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: 5000,
    discountSatang: 0,
    totalSatang: 5000,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: crypto.randomUUID(),
    requestHash: 'h',
    placedAt: T0,
    acceptedAt: T0,
  });
  void menuItemId;
  return row?.id ?? '';
}

describe('inserting jobs', () => {
  test('one kitchen job per order: a second insert changes nothing', async () => {
    const orderId = await newOrder();
    const first = await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: T0 });
    expect(first).toMatchObject({ status: 'pending', attempts: 0, kind: 'kitchen', seq: 0 });
    expect(
      await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(5) }),
    ).toBeUndefined();
    const mine = (await repo.listRecent(db, 100)).filter((j) => j.job.orderId === orderId);
    expect(mine).toHaveLength(1);
  });

  test('a reprint takes the next sequence number; a second request id with the same number is refused', async () => {
    const orderId = await newOrder();
    await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: T0 });
    expect(await repo.nextReprintSeq(db, orderId)).toBe(1);
    await repo.insertJob(db, {
      orderId,
      kind: 'reprint',
      seq: 1,
      requestedByStaffId: staffId,
      now: T0,
    });
    expect(await repo.nextReprintSeq(db, orderId)).toBe(2);
    expect(await repo.insertJob(db, { orderId, kind: 'reprint', seq: 1, now: T0 })).toBeUndefined();
  });

  test('the table refuses a kitchen job with a sequence, a reprint without one and an error that is not a code', async () => {
    const orderId = await newOrder();
    await expect(
      client.query(
        `insert into print_jobs (order_id, kind, seq, next_attempt_at, created_at, updated_at) values ($1, 'kitchen', 1, now(), now(), now())`,
        [orderId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `insert into print_jobs (order_id, kind, seq, next_attempt_at, created_at, updated_at) values ($1, 'reprint', 0, now(), now(), now())`,
        [orderId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `insert into print_jobs (order_id, kind, seq, last_error, next_attempt_at, created_at, updated_at) values ($1, 'kitchen', 0, 'the printer at 10.0.0.5 said no', now(), now(), now())`,
        [orderId],
      ),
    ).rejects.toThrow();
  });

  test('a reprint request id can be used once', async () => {
    const orderId = await newOrder();
    const requestId = crypto.randomUUID();
    await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: T0 });
    await repo.insertJob(db, {
      orderId,
      kind: 'reprint',
      seq: 1,
      clientRequestId: requestId,
      now: T0,
    });
    expect((await repo.findByClientRequestId(db, requestId))?.seq).toBe(1);
    expect(
      await repo.insertJob(db, {
        orderId,
        kind: 'reprint',
        seq: 2,
        clientRequestId: requestId,
        now: T0,
      }),
    ).toBeUndefined();
  });
});

describe('claiming', () => {
  const claim = (now: Date, token = crypto.randomUUID()) =>
    repo
      .claimNext(db, {
        deviceId,
        leaseToken: token,
        now,
        leaseUntil: new Date(now.getTime() + 30_000),
        maxAttempts: 5,
      })
      .then((row) => row);

  test('takes the oldest due job, leases it and counts the attempt', async () => {
    await client.query('delete from print_jobs');
    const a = await newOrder();
    const b = await newOrder();
    await repo.insertJob(db, { orderId: a, kind: 'kitchen', seq: 0, now: at(0) });
    await repo.insertJob(db, { orderId: b, kind: 'kitchen', seq: 0, now: at(1) });
    const token = crypto.randomUUID();
    const got = await repo.claimNext(db, {
      deviceId,
      leaseToken: token,
      now: at(2),
      leaseUntil: at(32),
      maxAttempts: 5,
    });
    expect(got).toMatchObject({
      orderId: a,
      status: 'claimed',
      attempts: 1,
      claimedByDeviceId: deviceId,
      leaseToken: token,
    });
    expect(got?.leaseUntil?.toISOString()).toBe(at(32).toISOString());
    // The second claim gets the other job, never the leased one.
    expect((await claim(at(3)))?.orderId).toBe(b);
    expect(await claim(at(4))).toBeUndefined();
  });

  test('an expired lease can be claimed again, a live one cannot', async () => {
    await client.query('delete from print_jobs');
    const orderId = await newOrder();
    await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(0) });
    await repo.claimNext(db, {
      deviceId,
      leaseToken: crypto.randomUUID(),
      now: at(1),
      leaseUntil: at(31),
      maxAttempts: 5,
    });
    expect(await claim(at(30))).toBeUndefined();
    const again = await repo.claimNext(db, {
      deviceId,
      leaseToken: crypto.randomUUID(),
      now: at(32),
      leaseUntil: at(62),
      maxAttempts: 5,
    });
    expect(again).toMatchObject({ orderId, attempts: 2, status: 'claimed' });
  });

  test('a job whose attempts are used up is not claimed again; failExhausted marks it failed', async () => {
    await client.query('delete from print_jobs');
    const orderId = await newOrder();
    await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(0) });
    await client.query(
      `update print_jobs set status = 'claimed', attempts = 5, lease_until = $1 where order_id = $2`,
      [at(10).toISOString(), orderId],
    );
    expect(await claim(at(20))).toBeUndefined();
    const failed = await repo.failExhausted(db, { now: at(20), maxAttempts: 5 });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ orderId, status: 'failed', lastError: 'LEASE_EXPIRED' });
    expect(await repo.failExhausted(db, { now: at(21), maxAttempts: 5 })).toHaveLength(0);
  });

  test('a pending job waits for its back-off time', async () => {
    await client.query('delete from print_jobs');
    const orderId = await newOrder();
    const job = await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(0) });
    await repo.releaseForRetry(db, job?.id ?? '', {
      now: at(1),
      nextAttemptAt: at(20),
      errorCode: 'OUT_OF_PAPER',
    });
    expect(await claim(at(10))).toBeUndefined();
    expect((await claim(at(20)))?.lastError).toBe('OUT_OF_PAPER');
  });
});

describe('finishing', () => {
  test('printed is stamped once and stays printed', async () => {
    await client.query('delete from print_jobs');
    const orderId = await newOrder();
    const job = await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(0) });
    const done = await repo.markPrinted(db, job?.id ?? '', at(5));
    expect(done).toMatchObject({ status: 'printed', leaseUntil: null, leaseToken: null });
    expect(done?.printedAt?.toISOString()).toBe(at(5).toISOString());
    expect(await repo.markPrinted(db, job?.id ?? '', at(9))).toBeUndefined();
    expect((await repo.findById(db, job?.id ?? ''))?.printedAt?.toISOString()).toBe(
      at(5).toISOString(),
    );
  });

  test('markFailed keeps only the code', async () => {
    await client.query('delete from print_jobs');
    const orderId = await newOrder();
    const job = await repo.insertJob(db, { orderId, kind: 'kitchen', seq: 0, now: at(0) });
    expect(
      await repo.markFailed(db, job?.id ?? '', { now: at(3), errorCode: 'PRINTER_OFFLINE' }),
    ).toMatchObject({
      status: 'failed',
      lastError: 'PRINTER_OFFLINE',
    });
  });
});

describe('listing', () => {
  test('newest first, with the order number, limited', async () => {
    await client.query('delete from print_jobs');
    const a = await newOrder();
    const b = await newOrder();
    await repo.insertJob(db, { orderId: a, kind: 'kitchen', seq: 0, now: at(0) });
    await repo.insertJob(db, { orderId: b, kind: 'kitchen', seq: 0, now: at(1) });
    const rows = await repo.listRecent(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job.orderId).toBe(b);
    expect(rows[0]?.orderNo).toMatch(/^S-\d{3}$/);
  });
});
