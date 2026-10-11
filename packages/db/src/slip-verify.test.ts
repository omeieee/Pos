import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as customersRepo from './customers.ts';
import * as ordersRepo from './orders.ts';
import * as repo from './payments.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as retention from './retention.ts';
import { customers } from './schema.ts';
import * as sync from './sync.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();

async function newOrder(customerId: string | null = null): Promise<ordersRepo.OrderRow> {
  const row = await ordersRepo.insertOrder(db, {
    orderNo: `S-${unique().slice(0, 6)}`,
    businessDate: '2026-10-01',
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId,
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

async function claimedPayment(
  customerId: string | null = null,
  patch: repo.PaymentPatch = {},
): Promise<repo.PaymentRow> {
  const order = await newOrder(customerId);
  const row = await repo.insertPayment(db, {
    orderId: order.id,
    method: 'promptpay',
    status: 'pending',
    amountSatang: 5000,
    clientRequestId: unique(),
    requestHash: unique(),
  });
  if (!row) throw new Error('payment not created');
  const updated = await repo.updatePaymentIfVersion(db, row.id, row.version, {
    status: 'claimed',
    claimedAt: new Date('2026-10-01T03:05:00Z'),
    slipImageKey: `slips/${unique()}`,
    ...patch,
  });
  if (!updated) throw new Error('payment not updated');
  return updated;
}

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await client.query<T>(text, params)).rows;

describe('slip_verify columns (migration 0031)', () => {
  test('a new payment has no verdict and zero attempts', async () => {
    const order = await newOrder();
    const row = await repo.insertPayment(db, {
      orderId: order.id,
      method: 'promptpay',
      status: 'pending',
      amountSatang: 5000,
      clientRequestId: unique(),
      requestHash: unique(),
    });
    expect(row).toMatchObject({
      slipVerify: null,
      slipVerifyCode: null,
      slipVerifyRef: null,
      slipVerifyAttempts: 0,
      slipVerifiedAt: null,
    });
  });

  test('the patch writes every field, and the sync trigger bumps version and rev', async () => {
    const before = await claimedPayment();
    const at = new Date('2026-10-01T03:06:00Z');
    const after = await repo.updatePaymentIfVersion(db, before.id, before.version, {
      slipVerify: 'valid',
      slipVerifyCode: '200200',
      slipVerifyRef: 'ref-1',
      slipVerifyAttempts: 2,
      slipVerifiedAt: at,
    });
    expect(after).toMatchObject({
      slipVerify: 'valid',
      slipVerifyCode: '200200',
      slipVerifyRef: 'ref-1',
      slipVerifyAttempts: 2,
      slipVerifiedAt: at,
      version: before.version + 1,
    });
    expect(after?.rev).toBeGreaterThan(before.rev);
  });

  test('the database refuses a verdict outside the list', async () => {
    const row = await claimedPayment();
    await expect(
      client.query("update payments set slip_verify = 'maybe' where id = $1", [row.id]),
    ).rejects.toThrow(/payments_slip_verify/);
    for (const verdict of [
      'pending',
      'valid',
      'amount_mismatch',
      'receiver_mismatch',
      'date_mismatch',
      'not_found',
      'fraud',
      'unchecked',
    ]) {
      await client.query('update payments set slip_verify = $2 where id = $1', [row.id, verdict]);
    }
  });
});

describe('listPendingSlipChecks', () => {
  test('selects by each kind of reading separately', async () => {
    const ocrOnly = await claimedPayment(null, { slipCheck: 'pending' });
    const verifyOnly = await claimedPayment(null, { slipVerify: 'pending' });
    const both = await claimedPayment(null, { slipCheck: 'pending', slipVerify: 'pending' });
    const done = await claimedPayment(null, { slipCheck: 'match', slipVerify: 'valid' });
    const noImage = await claimedPayment(null, { slipVerify: 'pending', slipImageKey: null });
    const ids = (flags: { ocr: boolean; verify: boolean }) =>
      repo.listPendingSlipChecks(db, 100, flags);

    const ocr = await ids({ ocr: true, verify: false });
    expect(ocr).toContain(ocrOnly.id);
    expect(ocr).toContain(both.id);
    expect(ocr).not.toContain(verifyOnly.id);

    const verify = await ids({ ocr: false, verify: true });
    expect(verify).toContain(verifyOnly.id);
    expect(verify).toContain(both.id);
    expect(verify).not.toContain(ocrOnly.id);

    const either = await ids({ ocr: true, verify: true });
    for (const id of [ocrOnly.id, verifyOnly.id, both.id]) expect(either).toContain(id);
    for (const id of [done.id, noImage.id]) expect(either).not.toContain(id);

    expect(await ids({ ocr: false, verify: false })).toEqual([]);
  });
});

describe('where the verdict never goes', () => {
  test('the sync feed carries none of the verdict fields', async () => {
    await claimedPayment(null, {
      slipVerify: 'valid',
      slipVerifyCode: '200200',
      slipVerifyRef: 'REF-SENTINEL-VERIFY',
      slipVerifyAttempts: 1,
      slipVerifiedAt: new Date('2026-10-01T03:06:00Z'),
    });
    const batch = await sync.readChanges(db, {
      since: 0,
      limit: 500,
      include: { orders: false, payments: true, menu: false, settings: false, customers: false },
    });
    const json = JSON.stringify(batch);
    expect(json).toContain('promptpay');
    expect(json).not.toContain('REF-SENTINEL-VERIFY');
    expect(json).not.toMatch(/verif|200200/i);
  });

  test('the 90-day slip purge clears the verdict with the slip', async () => {
    const row = await claimedPayment(null, {
      slipVerify: 'valid',
      slipVerifyCode: '200200',
      slipVerifyRef: 'ref-2',
      slipVerifyAttempts: 1,
      slipVerifiedAt: new Date('2026-10-01T03:06:00Z'),
    });
    await retention.clearSlipKeys(db, {
      slips: [{ id: row.id, key: row.slipImageKey ?? '' }],
      now: new Date('2026-12-31T00:00:00Z'),
    });
    expect(await repo.findPaymentById(db, row.id)).toMatchObject({
      slipImageKey: null,
      slipVerify: null,
      slipVerifyCode: null,
      slipVerifyRef: null,
      slipVerifyAttempts: 0,
      slipVerifiedAt: null,
    });
  });

  test("a customer's erasure clears the verdict with the slip", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ lineUserId: `U-verify-${unique()}` })
      .returning({ id: customers.id });
    const row = await claimedPayment(customer?.id ?? '', {
      slipVerify: 'fraud',
      slipVerifyCode: '200500',
      slipVerifyRef: 'ref-3',
      slipVerifyAttempts: 1,
      slipVerifiedAt: new Date('2026-10-01T03:06:00Z'),
    });
    const keys = await customersRepo.takeCustomerSlipKeys(db, customer?.id ?? '');
    expect(keys).toEqual([row.slipImageKey]);
    expect(await repo.findPaymentById(db, row.id)).toMatchObject({
      slipVerify: null,
      slipVerifyCode: null,
      slipVerifyRef: null,
      slipVerifyAttempts: 0,
      slipVerifiedAt: null,
    });
    expect((await q('select 1 from payments where id = $1', [row.id])).length).toBe(1);
  });
});

describe('an automatic confirmation (D-27, migration 0032)', () => {
  const confirmedAt = new Date('2026-10-01T03:10:00Z');

  test('a confirmed payment may name nobody only when it is marked automatic', async () => {
    const row = await claimedPayment();
    await expect(
      repo.updatePaymentIfVersion(db, row.id, row.version, { status: 'confirmed', confirmedAt }),
    ).rejects.toThrow();
    const done = await repo.updatePaymentIfVersion(db, row.id, row.version, {
      status: 'confirmed',
      confirmedAt,
      autoConfirmed: true,
    });
    expect(done).toMatchObject({
      status: 'confirmed',
      confirmedByStaffId: null,
      autoConfirmed: true,
    });
  });

  test('automatic still needs a time, and a void of it works without naming the staff column', async () => {
    const row = await claimedPayment();
    await expect(
      repo.updatePaymentIfVersion(db, row.id, row.version, {
        status: 'confirmed',
        autoConfirmed: true,
      }),
    ).rejects.toThrow();
    const confirmed = await repo.updatePaymentIfVersion(db, row.id, row.version, {
      status: 'confirmed',
      confirmedAt,
      autoConfirmed: true,
    });
    const voided = await repo.updatePaymentIfVersion(db, row.id, confirmed?.version ?? 0, {
      status: 'voided',
      voidReason: 'checked the bank app: no money',
    });
    expect(voided).toMatchObject({ status: 'voided', autoConfirmed: true });
  });

  test('a payment confirmed by staff is not automatic, and the sync feed never says otherwise', async () => {
    const row = await claimedPayment();
    expect(row.autoConfirmed).toBe(false);
    const batch = await sync.readChanges(db, {
      since: 0,
      limit: 500,
      include: { orders: false, payments: true, menu: false, settings: false, customers: false },
    });
    expect(JSON.stringify(batch)).not.toMatch(/auto/i);
  });
});

describe('daily Slip2Go usage', () => {
  test('counts calls per business date and lets an alert go out once a day', async () => {
    const date = '2026-10-01';
    expect(await repo.slipVerifyCallsOn(db, date)).toBe(0);
    await repo.recordSlipVerifyCall(db, date);
    await repo.recordSlipVerifyCall(db, date);
    await repo.recordSlipVerifyCall(db, '2026-10-02');
    expect(await repo.slipVerifyCallsOn(db, date)).toBe(2);
    expect(await repo.slipVerifyCallsOn(db, '2026-10-02')).toBe(1);

    expect(await repo.claimSlipVerifyAlert(db, date, 'account')).toBe(true);
    expect(await repo.claimSlipVerifyAlert(db, date, 'account')).toBe(false);
    expect(await repo.claimSlipVerifyAlert(db, date, 'cap')).toBe(true);
    expect(await repo.claimSlipVerifyAlert(db, '2026-10-02', 'account')).toBe(true);
  });
});
