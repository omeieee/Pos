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
    const { keys } = await customersRepo.takeCustomerSlipKeys(db, customer?.id ?? '');
    expect(keys).toEqual([row.slipImageKey]);
    expect(await repo.findPaymentById(db, row.id)).toMatchObject({
      slipVerify: null,
      slipVerifyCode: null,
      slipVerifyRef: null,
      slipVerifyAttempts: 0,
      slipVerifiedAt: null,
    });
    expect((await q('select 1 from payments where id = $1', [row.id])).length).toBe(1);
    // The claim is still open and its picture is gone: the order's board flag says so.
    expect(
      (
        await q<{ f: boolean }>('select claim_without_slip f from orders where id = $1', [
          row.orderId,
        ])
      )[0]?.f,
    ).toBe(true);
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

describe('findOtherSlipUse (the strict duplicate rule of an automatic confirmation)', () => {
  test('finds a payment that used the same slip even when it was claimed LATER', async () => {
    const earlier = await claimedPayment(null, { slipQrHash: 'qr-key-1' });
    const later = await claimedPayment(null, { slipQrHash: 'qr-key-1' });
    // The staff hint only looks backwards in time ...
    expect(await repo.findEarlierSlipUse(db, earlier)).toBeUndefined();
    // ... the automatic rule looks at every other payment that used the slip.
    expect(await repo.findOtherSlipUse(db, earlier)).toMatchObject({ status: 'claimed' });
    expect(await repo.findOtherSlipUse(db, later)).toMatchObject({ status: 'claimed' });
  });

  test('matches by image, reference or QR key; ignores itself and other keys', async () => {
    const byImage = await claimedPayment(null, { slipImageHash: 'img-1' });
    const byRef = await claimedPayment(null, { slipRefHash: 'ref-1' });
    expect(await repo.findOtherSlipUse(db, byImage)).toBeUndefined();
    expect(await repo.findOtherSlipUse(db, byRef)).toBeUndefined();
    await claimedPayment(null, { slipImageHash: 'img-1' });
    await claimedPayment(null, { slipRefHash: 'ref-1' });
    expect(await repo.findOtherSlipUse(db, byImage)).toBeDefined();
    expect(await repo.findOtherSlipUse(db, byRef)).toBeDefined();
    const loner = await claimedPayment(null, { slipQrHash: 'qr-unique' });
    expect(await repo.findOtherSlipUse(db, loner)).toBeUndefined();
    expect(
      await repo.findOtherSlipUse(db, { ...loner, slipQrHash: null, slipImageHash: null }),
    ).toBeUndefined();
  });
});

// Voided and refunded rows need a staff member (a table constraint): the route tests cover them.
describe('findOtherSlipUse counts a payment in almost ANY status (D-27)', () => {
  const keys = [
    { slipImageHash: 'img-any' },
    { slipRefHash: 'ref-any' },
    { slipQrHash: 'qr-any' },
  ] as const;
  const cancelledWith = async (key: (typeof keys)[number], verdict: string | null) => {
    // Every test gets its own value: the database is shared.
    const fresh = Object.fromEntries(
      Object.entries(key).map(([k, v]) => [k, `${v}-${unique()}`]),
    ) as Record<string, string>;
    const mine = await claimedPayment(null, fresh);
    const other = await claimedPayment(null, fresh);
    await repo.updatePaymentIfVersion(db, other.id, other.version, {
      status: 'cancelled',
      ...(verdict ? { slipVerify: verdict as 'valid' } : {}),
    });
    return mine;
  };
  // A claim cancelled before the bank check ever said anything about the transfer (live case).
  test.each(keys)(
    'a cancelled payment with no verdict and the same key %o does not block',
    async (key) => {
      const mine = await cancelledWith(key, null);
      expect(await repo.findOtherSlipUse(db, mine)).toBeUndefined();
    },
  );
  test.each(keys.flatMap((key) => ['unchecked', 'not_found'].map((v) => [key, v] as const)))(
    'a cancelled payment, verdict %# (%o), does not block',
    async (key, verdict) => {
      const mine = await cancelledWith(key, verdict);
      expect(await repo.findOtherSlipUse(db, mine)).toBeUndefined();
    },
  );
  test.each(
    keys.flatMap((key) =>
      ['valid', 'pending', 'amount_mismatch', 'receiver_mismatch', 'date_mismatch', 'fraud'].map(
        (v) => [key, v] as const,
      ),
    ),
  )('a cancelled payment, verdict %# (%o), still blocks', async (key, verdict) => {
    const mine = await cancelledWith(key, verdict);
    expect(await repo.findOtherSlipUse(db, mine)).toMatchObject({ status: 'cancelled' });
    // The staff hint keeps its narrower rule: rejected payments do not look "used".
    expect(await repo.findEarlierSlipUse(db, mine)).toBeUndefined();
  });
  test('a cancelled payment that was blocked, or that was ever confirmed, still blocks', async () => {
    const key = { slipImageHash: 'img-blocked' } as const;
    const mine = await claimedPayment(null, key);
    const blocked = await claimedPayment(null, key);
    await repo.updatePaymentIfVersion(db, blocked.id, blocked.version, {
      status: 'cancelled',
      slipBlockedAt: new Date('2026-10-01T03:06:00Z'),
    });
    expect(await repo.findOtherSlipUse(db, mine)).toBeDefined();
    const key2 = { slipImageHash: 'img-was-confirmed' } as const;
    const mine2 = await claimedPayment(null, key2);
    const was = await claimedPayment(null, key2);
    await q(
      "update payments set status = 'cancelled', confirmed_at = now(), auto_confirmed = true where id = $1",
      [was.id],
    );
    expect(await repo.findOtherSlipUse(db, mine2)).toBeDefined();
  });
  test.each(['pending', 'claimed'] as const)('an open %s payment still blocks', async (status) => {
    const key = { slipImageHash: `img-open-${status}` };
    const mine = await claimedPayment(null, key);
    const other = await claimedPayment(null, key);
    if (status === 'pending') {
      await q("update payments set status = 'pending' where id = $1", [other.id]);
    }
    expect(await repo.findOtherSlipUse(db, mine)).toMatchObject({ status });
  });
  test.each(['confirmed', 'voided'] as const)(
    'a %s (automatic) payment still blocks',
    async (status) => {
      const key = { slipImageHash: `img-${status}` };
      const mine = await claimedPayment(null, key);
      const other = await claimedPayment(null, key);
      const done = await repo.updatePaymentIfVersion(db, other.id, other.version, {
        status: 'confirmed',
        confirmedAt: new Date('2026-10-01T03:10:00Z'),
        autoConfirmed: true,
      });
      if (status === 'voided') {
        await repo.updatePaymentIfVersion(db, other.id, done?.version ?? 0, {
          status: 'voided',
          voidReason: 'no money',
        });
      }
      expect(await repo.findOtherSlipUse(db, mine)).toMatchObject({ status });
    },
  );
  test('two cancelled-unchecked payments with the same slip and one confirmed: the confirmed one blocks both', async () => {
    const key = { slipImageHash: 'img-sym' } as const;
    const a = await claimedPayment(null, key);
    const b = await claimedPayment(null, key);
    await repo.updatePaymentIfVersion(db, a.id, a.version, { status: 'cancelled' });
    // b is confirmed (as the automatic path would): a re-created A must not also confirm.
    await repo.updatePaymentIfVersion(db, b.id, b.version, {
      status: 'confirmed',
      confirmedAt: new Date('2026-10-01T03:10:00Z'),
      autoConfirmed: true,
    });
    const reopened = await claimedPayment(null, key);
    expect(await repo.findOtherSlipUse(db, reopened)).toMatchObject({ status: 'confirmed' });
  });
});

describe('bumpSlipVerifyAttempts', () => {
  test('counts an attempt on a pending row only, for that picture', async () => {
    const row = await claimedPayment(null, {
      slipVerify: 'pending',
      slipImageHash: 'img-attempt',
    });
    expect(await repo.bumpSlipVerifyAttempts(db, row.id, 'img-attempt')).toBe(1);
    expect(await repo.bumpSlipVerifyAttempts(db, row.id, 'img-attempt')).toBe(2);
    expect(await repo.bumpSlipVerifyAttempts(db, row.id, 'another')).toBeNull();
    const after = await repo.findPaymentById(db, row.id);
    expect(after).toMatchObject({ slipVerifyAttempts: 2 });
    await repo.updatePaymentIfVersion(db, row.id, after?.version ?? 0, { slipVerify: 'valid' });
    expect(await repo.bumpSlipVerifyAttempts(db, row.id, 'img-attempt')).toBeNull();
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

describe('one transfer can never be confirmed twice (PAY-06, D-40)', () => {
  const confirm = (row: repo.PaymentRow) =>
    repo.updatePaymentIfVersion(db, row.id, row.version, {
      status: 'confirmed',
      confirmedAt: new Date('2026-10-01T04:00:00Z'),
      autoConfirmed: true,
    });

  test('two claimed payments may hold one QR key, but only one of them can be confirmed', async () => {
    const key = `qr-twice-${unique()}`;
    const first = await claimedPayment(null, { slipQrHash: key });
    const second = await claimedPayment(null, { slipQrHash: key });
    expect((await confirm(first))?.status).toBe('confirmed');
    const error = await confirm(second).then(
      () => null,
      (e: unknown) => e,
    );
    expect(repo.isSlipTransferConflict(error)).toBe(true);
    expect((await repo.findPaymentById(db, second.id))?.status).toBe('claimed');
  });

  test('a voided confirmation frees the key, and payments without a key are never in conflict', async () => {
    const key = `qr-void-${unique()}`;
    const first = await claimedPayment(null, { slipQrHash: key });
    const confirmed = await confirm(first);
    await repo.updatePaymentIfVersion(db, first.id, confirmed?.version ?? 0, {
      status: 'voided',
      voidReason: 'no money',
    });
    const other = await claimedPayment(null, { slipQrHash: key });
    expect((await confirm(other))?.status).toBe('confirmed');
    const a = await claimedPayment(null);
    const b = await claimedPayment(null);
    expect((await confirm(a))?.status).toBe('confirmed');
    expect((await confirm(b))?.status).toBe('confirmed');
  });

  test('the auto-confirm block is never in the sync feed', async () => {
    const row = await claimedPayment(null, { slipAutoconfirmBlocked: true });
    expect(row.slipAutoconfirmBlocked).toBe(true);
    const batch = await sync.readChanges(db, {
      since: 0,
      limit: 500,
      include: { orders: false, payments: true, menu: false, settings: false, customers: false },
    });
    expect(JSON.stringify(batch)).not.toMatch(/autoconfirm/i);
  });
});
