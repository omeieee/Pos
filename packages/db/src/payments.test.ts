import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as ordersRepo from './orders.ts';
import * as repo from './payments.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import { staff } from './schema.ts';

let db: PgliteDb;
let client: PGlite;
let staffId: string;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
  const [row] = await db
    .insert(staff)
    .values({ displayName: 'cashier', role: 'cashier', pinHash: 'x' })
    .returning({ id: staff.id });
  staffId = row?.id ?? '';
}, 60_000);
afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();

async function newOrder(): Promise<ordersRepo.OrderRow> {
  const row = await ordersRepo.insertOrder(db, {
    orderNo: `S-${unique().slice(0, 6)}`,
    businessDate: '2026-10-01',
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: 5000,
    discountSatang: 0,
    totalSatang: 5000,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: unique(),
    requestHash: unique(),
    placedAt: new Date('2026-10-01T03:00:00Z'),
    acceptedAt: null,
  });
  if (!row) throw new Error('order not created');
  return row;
}

const pending = (orderId: string, over: Partial<repo.NewPayment> = {}): repo.NewPayment => ({
  orderId,
  method: 'promptpay',
  status: 'pending',
  amountSatang: 5000,
  promptpayTargetMasked: '******4321',
  clientRequestId: unique(),
  requestHash: unique(),
  ...over,
});

describe('payments repo', () => {
  test('inserts with the request hash, and a sync trigger gives it version 1 and a rev', async () => {
    const order = await newOrder();
    const input = pending(order.id);
    const row = await repo.insertPayment(db, input);
    expect(row).toMatchObject({
      orderId: order.id,
      status: 'pending',
      requestHash: input.requestHash,
      version: 1,
      qrPayload: null,
    });
    expect(row?.rev).toBeGreaterThan(0);
  });

  test('a second insert with the same client request id returns nothing and writes nothing', async () => {
    const order = await newOrder();
    const first = pending(order.id);
    expect(await repo.insertPayment(db, first)).toBeDefined();
    expect(await repo.insertPayment(db, { ...first, method: 'platform' })).toBeUndefined();
    expect(await repo.listPaymentsForOrder(db, order.id)).toHaveLength(1);
    expect((await repo.findPaymentByClientRequestId(db, first.clientRequestId))?.method).toBe(
      'promptpay',
    );
  });

  test('the update is guarded by the version and bumps version and rev', async () => {
    const order = await newOrder();
    const row = await repo.insertPayment(db, pending(order.id));
    const id = row?.id ?? '';
    expect(await repo.updatePaymentIfVersion(db, id, 99, { status: 'claimed' })).toBeUndefined();
    const claimed = await repo.updatePaymentIfVersion(db, id, 1, {
      status: 'claimed',
      claimedAt: new Date('2026-10-01T03:05:00Z'),
    });
    expect(claimed).toMatchObject({ status: 'claimed', version: 2 });
    expect(claimed?.rev).toBeGreaterThan(row?.rev ?? 0);
    expect((await repo.findPaymentById(db, id))?.claimedAt).toEqual(
      new Date('2026-10-01T03:05:00Z'),
    );
  });

  test('the database refuses a confirmed payment that names nobody', async () => {
    const order = await newOrder();
    await expect(
      repo.insertPayment(db, pending(order.id, { method: 'cash', status: 'confirmed' })),
    ).rejects.toThrow();
    const ok = await repo.insertPayment(
      db,
      pending(order.id, {
        method: 'cash',
        status: 'confirmed',
        tenderedSatang: 10000,
        changeSatang: 5000,
        confirmedByStaffId: staffId,
        confirmedAt: new Date('2026-10-01T03:01:00Z'),
      }),
    );
    expect(ok).toMatchObject({ status: 'confirmed', confirmedByStaffId: staffId });
  });

  test('lists the payments of one order only, oldest first, and finds by id', async () => {
    const a = await newOrder();
    const b = await newOrder();
    const first = await repo.insertPayment(db, pending(a.id, { status: 'cancelled' }));
    const second = await repo.insertPayment(db, pending(a.id));
    await repo.insertPayment(db, pending(b.id));
    const list = await repo.listPaymentsForOrder(db, a.id);
    expect(list.map((p) => p.id)).toEqual([first?.id, second?.id]);
    expect((await repo.findPaymentById(db, second?.id ?? ''))?.orderId).toBe(a.id);
    expect(await repo.findPaymentById(db, unique())).toBeUndefined();
  });

  test('the database allows only one open (pending or claimed) payment per order', async () => {
    const order = await newOrder();
    const first = await repo.insertPayment(db, pending(order.id));
    const clash = await repo.insertPayment(db, pending(order.id, { method: 'platform' })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(clash).toBeDefined();
    expect(repo.isOpenPaymentConflict(clash)).toBe(true);
    expect(await repo.listPaymentsForOrder(db, order.id)).toHaveLength(1);

    // A claimed payment is still open, so it blocks a new one too.
    await repo.updatePaymentIfVersion(db, first?.id ?? '', 1, { status: 'claimed' });
    const claimedClash = await repo.insertPayment(db, pending(order.id)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(repo.isOpenPaymentConflict(claimedClash)).toBe(true);
  });

  test('closed payments never block: cancelled, voided and refunded sit beside a new open one', async () => {
    const order = await newOrder();
    const old = await repo.insertPayment(db, pending(order.id));
    await repo.updatePaymentIfVersion(db, old?.id ?? '', 1, { status: 'cancelled' });
    const next = await repo.insertPayment(db, pending(order.id));
    expect(next?.status).toBe('pending');
    // Another order is a different key.
    const other = await newOrder();
    expect(await repo.insertPayment(db, pending(other.id))).toBeDefined();
    expect(await repo.listPaymentsForOrder(db, order.id)).toHaveLength(2);
  });

  test('cancelling the open payment and inserting the new one in one transaction works (change-method)', async () => {
    const order = await newOrder();
    const old = await repo.insertPayment(db, pending(order.id));
    const made = await db.transaction(async (tx) => {
      await repo.updatePaymentIfVersion(tx, old?.id ?? '', 1, { status: 'cancelled' });
      return repo.insertPayment(tx, pending(order.id, { method: 'platform' }));
    });
    expect(made?.method).toBe('platform');
  });

  test('isOpenPaymentConflict recognises both driver shapes and nothing else', () => {
    const name = repo.OPEN_PAYMENT_INDEX;
    // PGlite: `constraint`; postgres-js: `constraint_name`; Drizzle wraps either as `cause`.
    expect(repo.isOpenPaymentConflict({ cause: { code: '23505', constraint: name } })).toBe(true);
    expect(repo.isOpenPaymentConflict({ cause: { code: '23505', constraint_name: name } })).toBe(
      true,
    );
    expect(repo.isOpenPaymentConflict({ code: '23505', constraint_name: name })).toBe(true);
    // Last resort: the server's message names the index.
    expect(
      repo.isOpenPaymentConflict({
        cause: {
          code: '23505',
          message: `duplicate key value violates unique constraint "${name}"`,
        },
      }),
    ).toBe(true);
    // Another unique index, another error class, junk.
    expect(
      repo.isOpenPaymentConflict({
        cause: { code: '23505', constraint: 'payments_client_request_id_key' },
      }),
    ).toBe(false);
    expect(repo.isOpenPaymentConflict({ cause: { code: '23503', constraint: name } })).toBe(false);
    expect(repo.isOpenPaymentConflict(new Error('boom'))).toBe(false);
    expect(repo.isOpenPaymentConflict(null)).toBe(false);
    expect(repo.isOpenPaymentConflict('23505')).toBe(false);
  });

  test('an order takes a payment status through its own update, bumping its version and rev', async () => {
    const order = await newOrder();
    const updated = await ordersRepo.updateOrderIfVersion(db, order.id, order.version, {
      paymentStatus: 'awaiting_confirmation',
    });
    expect(updated).toMatchObject({ paymentStatus: 'awaiting_confirmation', version: 2 });
    expect(updated?.rev).toBeGreaterThan(order.rev);
  });

  test('partial refunds are append-only: listed oldest first, never changed or deleted', async () => {
    const order = await newOrder();
    const paid = await repo.insertPayment(
      db,
      pending(order.id, {
        method: 'cash',
        status: 'confirmed',
        confirmedByStaffId: staffId,
        confirmedAt: new Date('2026-10-01T03:01:00Z'),
        tenderedSatang: 5000,
        changeSatang: 0,
      }),
    );
    const base = {
      orderId: order.id,
      paymentId: paid?.id ?? '',
      reason: 'test',
      refundedByStaffId: staffId,
    };
    const a = await repo.insertRefund(db, { ...base, amountSatang: 1000, method: 'cash' });
    const b = await repo.insertRefund(db, {
      ...base,
      amountSatang: 500,
      method: 'promptpay',
      referenceNote: 'ref',
    });
    expect((await repo.listRefundsForOrder(db, order.id)).map((r) => r.id)).toEqual([a.id, b.id]);
    await expect(
      repo.insertRefund(db, { ...base, amountSatang: 0, method: 'cash' }),
    ).rejects.toThrow();
    await expect(client.query('update payment_refunds set amount_satang = 1')).rejects.toThrow();
    await expect(client.query('delete from payment_refunds')).rejects.toThrow();
    await expect(client.query('truncate payment_refunds')).rejects.toThrow();
  });
});
