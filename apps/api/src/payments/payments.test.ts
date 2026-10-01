/**
 * Payment routes on the real app and an in-memory Postgres (PGlite). PGlite runs one query at a
 * time, so the tests below prove the rules and the rollbacks but NOT real-Postgres concurrency:
 * the order-row lock that makes "one open payment per order" hold under two simultaneous
 * requests is unproven here. Two requests sent together still end with one payment (the unique
 * request id and the lock queue them), but that is serialisation by the test database.
 */
import { promptpayPayload } from '@sds/promptpay';
import {
  type OrderDto,
  orderDtoSchema,
  type PaymentDto,
  paymentDtoSchema,
  satang,
} from '@sds/shared';
import QRCode from 'qrcode';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deriveAuthKeys } from '../auth/crypto.ts';
import type { AppEvent } from '../events.ts';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';
import { QR_PNG_OPTIONS, signQrLink } from './qr.ts';

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', { id: string; pin: string }>;

// Test identifiers only, not a real PromptPay ID.
const PHONE = '0899994321';
const OTHER_PHONE = '0877775555';

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  owner = await h.newOwner();
  device = await h.newDevice();
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Each test works on its own business day (10:00 in Bangkok), so sessions and numbers start fresh. */
let dayNo = 0;
function newDay(): void {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2028, 0, dayNo, 3, 0, 0)).toISOString());
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sign = (role: 'cashier' | 'manager' | 'kitchen') =>
  h.pinSession(device.token, staff[role].id, staff[role].pin);

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return h.app.inject({
    method,
    url,
    headers: { ...(token ? bearer(token) : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

/** A manager session that has stepped up just now (void and refund need it). */
async function steppedManager(): Promise<string> {
  const token = await sign('manager');
  const res = await call('POST', '/v1/auth/step-up', token, { pin: staff.manager.pin });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.statusCode}`);
  return token;
}

async function setPromptpayId(idValue: string | null): Promise<void> {
  if (idValue === null) {
    await h.client.query("delete from settings where key = 'promptpay'");
    return;
  }
  h.clock.advanceSeconds(90);
  const token = await h.steppedUpOwner(owner);
  const current = await h.client.query<{ version: number }>(
    "select version from settings where key = 'promptpay'",
  );
  const res = await call('PATCH', '/v1/settings/promptpay', token, {
    expectedVersion: current.rows[0]?.version ?? 0,
    idType: 'phone',
    idValue,
  });
  if (res.statusCode !== 200) throw new Error(`promptpay setup failed: ${res.statusCode}`);
}

/** The scheme: 60% government, active every day of the test years, 06:00 to 23:00 Bangkok. */
async function setScheme(over: { enabled?: boolean; from?: number; to?: number } = {}) {
  await h.client.query(
    `insert into gov_copay_schemes (code, name_th, gov_share_bp, gov_daily_cap_satang, gov_total_cap_satang,
       active_from, active_to, active_from_minute, active_to_minute, channels, enabled)
     values ('test', 'ไทยช่วยไทย', 6000, 20000, null, '2026-10-01', '2030-12-31', $1, $2, '{storefront}', $3)
     on conflict (code) do update set enabled = $3, active_from_minute = $1, active_to_minute = $2,
       active_from = '2026-10-01', active_to = '2030-12-31', gov_daily_cap_satang = 20000`,
    [over.from ?? 360, over.to ?? 1380, over.enabled ?? true],
  );
}

async function setMethods(value: Record<string, boolean> | null) {
  await h.client.query("delete from settings where key = 'payment_methods'");
  if (value) {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('payment_methods', $1::jsonb, $2)",
      [JSON.stringify(value), owner.staffId],
    );
  }
}

beforeEach(async () => {
  newDay();
  await setPromptpayId(PHONE);
  await setScheme({ enabled: true });
  await setMethods(null);
});

const orderBody = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  channel: 'storefront',
  fulfillment: 'takeaway',
  items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  ...over,
});

async function place(token: string, over: Record<string, unknown> = {}): Promise<OrderDto> {
  const res = await call('POST', '/v1/orders', token, orderBody(over));
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}

const payBody = (method: string, over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  method,
  ...(method === 'cash' ? { tendered: 10000 } : {}),
  ...over,
});

const pay = (token: string | undefined, orderId: string, body: unknown, headers = {}) =>
  call('POST', `/v1/orders/${orderId}/payments`, token, body, headers);

async function startPayment(
  token: string,
  orderId: string,
  method: string,
  over: Record<string, unknown> = {},
): Promise<PaymentDto> {
  const res = await pay(token, orderId, payBody(method, over));
  if (res.statusCode !== 201) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
  return paymentDtoSchema.parse(res.json().payment);
}

const move = (token: string | undefined, id: string, action: string, body: unknown = {}) =>
  call('POST', `/v1/payments/${id}/${action}`, token, body);

const orderNow = async (token: string, id: string) =>
  orderDtoSchema.parse((await call('GET', `/v1/orders/${id}`, token)).json());

async function row<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await h.client.query<T>(sql, params)).rows[0];
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await row<{ n: number }>(sql, params))?.n);

const paymentCount = (orderId: string) =>
  count('select count(*)::int as n from payments where order_id = $1', [orderId]);

const auditActions = async (id: string) => (await h.auditRows(id)).map((a) => a.action);

const eventsSince = (n: number): AppEvent[] => h.events.slice(n);
const typesOf = (events: AppEvent[]) => events.map((e) => e.type);

// ---------- Creating a payment ----------

describe('POST /v1/orders/:id/payments: who may call it', () => {
  test('needs a session and payment.record; the kitchen may not', async () => {
    const order = await place(await sign('cashier'));
    expect((await pay(undefined, order.id, payBody('promptpay'))).statusCode).toBe(401);
    const kitchen = await pay(await sign('kitchen'), order.id, payBody('promptpay'));
    expect(kitchen.statusCode).toBe(403);
    expect(kitchen.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await pay(await sign('cashier'), order.id, payBody('promptpay'))).statusCode).toBe(201);
  });

  test('an unknown order is 404 and a malformed id is 400', async () => {
    const cashier = await sign('cashier');
    expect((await pay(cashier, crypto.randomUUID(), payBody('promptpay'))).statusCode).toBe(404);
    expect((await pay(cashier, 'not-a-uuid', payBody('promptpay'))).statusCode).toBe(400);
  });
});

describe('the amount always comes from the order', () => {
  test('a body that names an amount, total, change or status is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    for (const extra of [
      { amountSatang: 1 },
      { totalSatang: 1 },
      { changeSatang: 9999 },
      { status: 'confirmed' },
      { qrPayload: '0002' },
    ]) {
      const res = await pay(cashier, order.id, payBody('promptpay', extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await paymentCount(order.id)).toBe(0);
  });

  test('every method charges the order total', async () => {
    const cashier = await sign('cashier');
    await setMethods({ cash: true, promptpay: true, platform: true, other: true });
    for (const method of ['cash', 'promptpay', 'gov_copay', 'platform', 'other']) {
      const order = await place(cashier, {
        items: [{ menuItemId: menu.noodles, qty: 2, modifierOptionIds: [menu.wide, menu.egg] }],
      });
      expect(order.totalSatang).toBe(11000);
      const payment = await startPayment(
        cashier,
        order.id,
        method,
        method === 'cash' ? { tendered: 20000 } : {},
      );
      expect(payment.amountSatang, method).toBe(11000);
    }
  });
});

describe('cash (02 §4.2)', () => {
  test('is recorded as already confirmed by the signed-in staff member, with the change', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const before = h.events.length;
    const res = await pay(cashier, order.id, payBody('cash', { tendered: 10000 }));
    expect(res.statusCode).toBe(201);
    const { payment, order: updated } = res.json();
    expect(paymentDtoSchema.parse(payment)).toMatchObject({
      orderId: order.id,
      method: 'cash',
      status: 'confirmed',
      amountSatang: 5000,
      tenderedSatang: 10000,
      changeSatang: 5000,
      confirmedByStaffId: staff.cashier.id,
      version: 1,
    });
    expect(payment.confirmedAt).toBe(h.clock.now().toISOString());
    expect(orderDtoSchema.parse(updated)).toMatchObject({
      paymentStatus: 'paid',
      version: order.version + 1,
    });
    expect(updated.rev).toBeGreaterThan(order.rev);
    expect(await auditActions(payment.id)).toEqual(['payment.confirm']);
    // Events: the payment, then the order; both after the commit.
    expect(typesOf(eventsSince(before))).toEqual(['payment.upserted', 'order.upserted']);
  });

  test('an exact tender gives no change; one satang more gives one', async () => {
    const cashier = await sign('cashier');
    const exact = await place(cashier);
    expect(
      (await pay(cashier, exact.id, payBody('cash', { tendered: 5000 }))).json().payment,
    ).toMatchObject({
      changeSatang: 0,
    });
    const over = await place(cashier);
    expect(
      (await pay(cashier, over.id, payBody('cash', { tendered: 5001 }))).json().payment,
    ).toMatchObject({
      changeSatang: 1,
    });
  });

  test('a tender below the total is refused and nothing is written', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const before = h.events.length;
    const res = await pay(cashier, order.id, payBody('cash', { tendered: 4999 }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'TENDERED_BELOW_TOTAL' });
    expect(await paymentCount(order.id)).toBe(0);
    expect((await orderNow(cashier, order.id)).paymentStatus).toBe('unpaid');
    expect(h.events.length).toBe(before);
  });

  test('needs tendered; a tender on any other method is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    expect(
      (await pay(cashier, order.id, { clientRequestId: crypto.randomUUID(), method: 'cash' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await pay(cashier, order.id, payBody('promptpay', { tendered: 5000 }))).statusCode,
    ).toBe(400);
    expect(await paymentCount(order.id)).toBe(0);
  });

  test('a total above the cash limit is refused with its own code', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    await h.client.query(
      'update orders set subtotal_satang = 100000001, total_satang = 100000001 where id = $1',
      [order.id],
    );
    const res = await pay(cashier, order.id, payBody('cash', { tendered: 100000000 }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'AMOUNT_TOO_LARGE' });
  });
});

describe('PromptPay', () => {
  test('is pending, shows the masked target only, and stores no payload', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const before = h.events.length;
    const res = await pay(cashier, order.id, payBody('promptpay'));
    expect(res.statusCode).toBe(201);
    const payment = paymentDtoSchema.parse(res.json().payment);
    expect(payment).toMatchObject({
      method: 'promptpay',
      status: 'pending',
      amountSatang: 5000,
      promptpayTargetMasked: '******4321',
      confirmedByStaffId: null,
      tenderedSatang: null,
    });
    expect(res.json().order.paymentStatus).toBe('unpaid');

    const stored = await row(
      'select qr_payload, promptpay_target_masked from payments where id = $1',
      [payment.id],
    );
    expect(stored).toEqual({ qr_payload: null, promptpay_target_masked: '******4321' });

    // Nothing that left the server holds the ID or a payload.
    const everything = JSON.stringify([res.json(), eventsSince(before)]);
    expect(everything).not.toContain(PHONE);
    expect(everything).not.toMatch(/qr_?payload/i);
  });

  test('is refused with a clear code while no PromptPay ID is set', async () => {
    await setPromptpayId(null);
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const res = await pay(cashier, order.id, payBody('promptpay'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PROMPTPAY_NOT_CONFIGURED' });
    expect(await paymentCount(order.id)).toBe(0);
  });
});

describe('government co-pay (rule 4)', () => {
  test('stores the scheme and the ESTIMATED split, never generating a ถุงเงิน QR', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier, {
      items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin, menu.egg] }],
    });
    const res = await pay(cashier, order.id, payBody('gov_copay'));
    expect(res.statusCode).toBe(201);
    const payment = paymentDtoSchema.parse(res.json().payment);
    const scheme = await row<{ id: string }>(
      "select id from gov_copay_schemes where code = 'test'",
    );
    // ฿55 at 60% = ฿33 government, ฿22 customer (under the ฿200 daily cap).
    expect(payment).toMatchObject({
      method: 'gov_copay',
      status: 'pending',
      amountSatang: 5500,
      schemeId: scheme?.id,
      estGovShareSatang: 3300,
      estCustomerShareSatang: 2200,
      promptpayTargetMasked: null,
    });
    // There is no QR for it: the staff create the ถุงเงิน QR in that app.
    const qr = await call('GET', `/v1/payments/${payment.id}/qr-url`, cashier);
    expect(qr.statusCode).toBe(409);
    expect(qr.json()).toMatchObject({ code: 'QR_NOT_AVAILABLE' });
  });

  test('the estimate is cut by the daily cap', async () => {
    await h.client.query(
      "update gov_copay_schemes set gov_daily_cap_satang = 1000 where code = 'test'",
    );
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = (await pay(cashier, order.id, payBody('gov_copay'))).json().payment;
    expect(payment).toMatchObject({ estGovShareSatang: 1000, estCustomerShareSatang: 4000 });
  });

  test('a LINE order paid at the counter qualifies (counter payments are storefront)', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier, { channel: 'line', fulfillment: 'pickup' });
    expect((await pay(cashier, order.id, payBody('gov_copay'))).statusCode).toBe(201);
  });

  test.each([
    ['the scheme is switched off', async () => setScheme({ enabled: false })],
    [
      'there is no scheme at all',
      async () => {
        await h.client.query('update payments set scheme_id = null');
        await h.client.query('delete from gov_copay_schemes');
      },
    ],
    [
      'it is after the scheme hours (23:30 Bangkok)',
      async () => h.clock.set(new Date(Date.UTC(2028, 0, dayNo, 16, 30, 0)).toISOString()),
    ],
    [
      'it is before the scheme hours (05:59 Bangkok)',
      async () => h.clock.set(new Date(Date.UTC(2028, 0, dayNo - 1, 22, 59, 0)).toISOString()),
    ],
    [
      'the round has ended',
      async () =>
        void (await h.client.query(
          "update gov_copay_schemes set active_to = '2027-12-31' where code = 'test'",
        )),
    ],
  ])('is refused when %s', async (_name, arrange) => {
    await arrange();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const res = await pay(cashier, order.id, payBody('gov_copay'));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'GOV_COPAY_UNAVAILABLE' });
    expect(await paymentCount(order.id)).toBe(0);
  });

  test('is refused for room delivery and platform delivery (not face to face)', async () => {
    const cashier = await sign('cashier');
    const room = await place(cashier, { fulfillment: 'room_delivery', roomNo: '1204' });
    const res = await pay(cashier, room.id, payBody('gov_copay'));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'GOV_COPAY_UNAVAILABLE' });
    const platform = await place(cashier, { channel: 'grab', fulfillment: 'platform_delivery' });
    expect((await pay(cashier, platform.id, payBody('gov_copay'))).statusCode).toBe(422);
  });
});

describe('platform and other; method switches', () => {
  test('platform and other are pending and wait for staff to confirm', async () => {
    await setMethods({ cash: true, promptpay: true, platform: true, other: true });
    const cashier = await sign('cashier');
    for (const method of ['platform', 'other']) {
      const order = await place(cashier);
      const res = await pay(cashier, order.id, payBody(method, { referenceNote: 'Grab 8841' }));
      expect(res.statusCode).toBe(201);
      expect(res.json().payment).toMatchObject({
        method,
        status: 'pending',
        referenceNote: 'Grab 8841',
      });
      expect(res.json().order.paymentStatus).toBe('unpaid');
    }
  });

  test('a method the shop switched off is refused (other is off by default)', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const other = await pay(cashier, order.id, payBody('other'));
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'METHOD_DISABLED' });
    await setMethods({ cash: false, promptpay: false, platform: true, other: false });
    expect((await pay(cashier, order.id, payBody('cash'))).json()).toMatchObject({
      code: 'METHOD_DISABLED',
    });
    expect((await pay(cashier, order.id, payBody('promptpay'))).json()).toMatchObject({
      code: 'METHOD_DISABLED',
    });
    expect(await paymentCount(order.id)).toBe(0);
  });
});

describe('one open payment per order', () => {
  test('a second payment is refused while one is pending or claimed', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const first = await startPayment(cashier, order.id, 'promptpay');
    const second = await pay(cashier, order.id, payBody('platform'));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: 'PAYMENT_ALREADY_OPEN',
      details: { paymentId: first.id },
    });

    await move(cashier, first.id, 'claim');
    const third = await pay(cashier, order.id, payBody('platform'));
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ code: 'PAYMENT_ALREADY_OPEN' });
    expect(await paymentCount(order.id)).toBe(1);
  });

  test('a second payment is refused once one is confirmed for the full amount', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    await startPayment(cashier, order.id, 'cash');
    const res = await pay(cashier, order.id, payBody('cash'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ORDER_ALREADY_PAID' });
    expect(await paymentCount(order.id)).toBe(1);
  });

  test('a new payment is allowed again after the old one was cancelled, voided or refunded', async () => {
    const cashier = await sign('cashier');
    const manager = await steppedManager();
    const order = await place(cashier);
    const p1 = await startPayment(cashier, order.id, 'promptpay');
    await move(cashier, p1.id, 'claim');
    await move(cashier, p1.id, 'cancel-claimed', { reason: 'ไม่พบยอดเงินเข้า' });
    const p2 = await startPayment(cashier, order.id, 'cash');
    expect((await move(manager, p2.id, 'void', { reason: 'คิดเงินผิดโต๊ะ' })).statusCode).toBe(200);
    const p3 = await startPayment(cashier, order.id, 'cash');
    expect((await move(manager, p3.id, 'refund', { reason: 'ลูกค้าคืนสินค้า' })).statusCode).toBe(200);
    expect((await orderNow(cashier, order.id)).paymentStatus).toBe('refunded');
    expect((await pay(cashier, order.id, payBody('promptpay'))).statusCode).toBe(201);
  });

  test('a cancelled order cannot be paid, and an order with nothing to pay takes no payment', async () => {
    const cashier = await sign('cashier');
    const cancelled = await place(cashier);
    expect(
      (
        await call('POST', `/v1/orders/${cancelled.id}/cancel`, await sign('manager'), {
          reason: 'ลูกค้ายกเลิก',
        })
      ).statusCode,
    ).toBe(200);
    const res = await pay(cashier, cancelled.id, payBody('promptpay'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ORDER_CLOSED' });

    const free = await place(cashier);
    await h.client.query('update orders set subtotal_satang = 0, total_satang = 0 where id = $1', [
      free.id,
    ]);
    const none = await pay(cashier, free.id, payBody('cash', { tendered: 0 }));
    expect(none.statusCode).toBe(422);
    expect(none.json()).toMatchObject({ code: 'NOTHING_TO_PAY' });
  });

  test('two simultaneous requests for one order leave one payment (serialised by PGlite, not proof of Postgres)', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const [a, b] = await Promise.all([
      pay(cashier, order.id, payBody('promptpay')),
      pay(cashier, order.id, payBody('platform')),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await paymentCount(order.id)).toBe(1);
  });
});

describe('idempotency of the create route', () => {
  test('the same request id and body returns the original payment and writes nothing', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const body = payBody('promptpay');
    const first = await pay(cashier, order.id, body);
    const before = h.events.length;
    const auditBefore = (await h.auditRows(first.json().payment.id)).length;
    const again = await pay(cashier, order.id, body);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.id).toBe(first.json().payment.id);
    expect(again.json().payment.version).toBe(first.json().payment.version);
    expect(await paymentCount(order.id)).toBe(1);
    expect(h.events.length).toBe(before);
    expect((await h.auditRows(first.json().payment.id)).length).toBe(auditBefore);
  });

  test('a replay still works after the payment moved on, and shows its current state', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const body = payBody('promptpay');
    const first = await pay(cashier, order.id, body);
    await move(cashier, first.json().payment.id, 'confirm');
    const again = await pay(cashier, order.id, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.status).toBe('confirmed');
    expect(again.json().order.paymentStatus).toBe('paid');
  });

  test('a cash replay does not take the money twice', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const body = payBody('cash', { tendered: 20000 });
    await pay(cashier, order.id, body);
    const again = await pay(cashier, order.id, body);
    expect(again.statusCode).toBe(200);
    expect(await paymentCount(order.id)).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from audit_log where action = 'payment.confirm' and entity_id = $1",
        [again.json().payment.id],
      ),
    ).toBe(1);
  });

  test('the same request id with a different body is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const key = crypto.randomUUID();
    await pay(cashier, order.id, { clientRequestId: key, method: 'promptpay' });
    for (const other of [
      { clientRequestId: key, method: 'platform' },
      { clientRequestId: key, method: 'promptpay', referenceNote: 'x' },
    ]) {
      const res = await pay(cashier, order.id, other);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    const cashKey = crypto.randomUUID();
    const order2 = await place(cashier);
    await pay(cashier, order2.id, { clientRequestId: cashKey, method: 'cash', tendered: 5000 });
    const changed = await pay(cashier, order2.id, {
      clientRequestId: cashKey,
      method: 'cash',
      tendered: 6000,
    });
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('the same request id on another order is refused, never replayed onto it', async () => {
    const cashier = await sign('cashier');
    const a = await place(cashier);
    const b = await place(cashier);
    const body = payBody('promptpay');
    await pay(cashier, a.id, body);
    const res = await pay(cashier, b.id, body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await paymentCount(b.id)).toBe(0);
  });

  test('an Idempotency-Key header must say the same as clientRequestId', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const body = payBody('promptpay');
    const wrong = await pay(cashier, order.id, body, { 'idempotency-key': crypto.randomUUID() });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
    const right = await pay(cashier, order.id, body, {
      'idempotency-key': body.clientRequestId.toUpperCase(),
    });
    expect(right.statusCode).toBe(201);
  });

  test('two simultaneous requests with the same id create one payment', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const body = payBody('promptpay');
    const [a, b] = await Promise.all([pay(cashier, order.id, body), pay(cashier, order.id, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().payment.id).toBe(b.json().payment.id);
    expect(await paymentCount(order.id)).toBe(1);
  });
});

// ---------- Moving a payment ----------

describe('claim', () => {
  test('moves a pending payment to claimed and never confirms; the order awaits confirmation', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const before = h.events.length;
    const res = await move(cashier, payment.id, 'claim');
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({
      status: 'claimed',
      claimedAt: h.clock.now().toISOString(),
      confirmedByStaffId: null,
      confirmedAt: null,
      version: payment.version + 1,
    });
    expect(res.json().order).toMatchObject({
      paymentStatus: 'awaiting_confirmation',
      version: order.version + 2, // created the payment, then claimed it
    });
    expect(typesOf(eventsSince(before))).toEqual(['payment.upserted', 'order.upserted']);
  });

  test('a retry of a claim answers 200 with nothing written; a claim of a confirmed payment is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const first = await move(cashier, payment.id, 'claim');
    const before = h.events.length;
    const again = await move(cashier, payment.id, 'claim');
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.version).toBe(first.json().payment.version);
    expect(h.events.length).toBe(before);

    await move(cashier, payment.id, 'confirm');
    const late = await move(cashier, payment.id, 'claim');
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('needs payment.record and an existing payment', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    expect((await move(undefined, payment.id, 'claim')).statusCode).toBe(401);
    expect((await move(await sign('kitchen'), payment.id, 'claim')).statusCode).toBe(403);
    expect((await move(cashier, crypto.randomUUID(), 'claim')).statusCode).toBe(404);
  });

  test('a body that names an amount is refused; an old expectedVersion is a conflict', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    expect((await move(cashier, payment.id, 'claim', { amountSatang: 1 })).statusCode).toBe(400);
    const stale = await move(cashier, payment.id, 'claim', {
      expectedVersion: payment.version + 5,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: payment.version },
    });
  });
});

describe('confirm', () => {
  test('only staff with payment.confirm; the confirmer is the session staff; the amount is exact', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    expect((await move(await sign('kitchen'), payment.id, 'confirm')).statusCode).toBe(403);
    expect((await move(undefined, payment.id, 'confirm')).statusCode).toBe(401);
    const before = h.events.length;
    const res = await move(cashier, payment.id, 'confirm', { referenceNote: 'K PLUS 0042' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({
      status: 'confirmed',
      amountSatang: 5000,
      confirmedByStaffId: staff.cashier.id,
      confirmedAt: h.clock.now().toISOString(),
      referenceNote: 'K PLUS 0042',
    });
    expect(res.json().order.paymentStatus).toBe('paid');
    expect(await auditActions(payment.id)).toEqual(['payment.confirm']);
    expect(typesOf(eventsSince(before))).toEqual(['payment.upserted', 'order.upserted']);
  });

  test('a claimed payment is confirmed the same way', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    await move(cashier, payment.id, 'claim');
    const res = await move(cashier, payment.id, 'confirm');
    expect(res.json().payment).toMatchObject({
      status: 'confirmed',
      claimedAt: expect.any(String),
    });
    expect(res.json().order.paymentStatus).toBe('paid');
  });

  test('a retry (a lost response) answers 200 and changes nothing, even for another staff member', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const first = await move(cashier, payment.id, 'confirm');
    const before = h.events.length;
    const manager = await sign('manager');
    const again = await move(manager, payment.id, 'confirm', { expectedVersion: payment.version });
    expect(again.statusCode).toBe(200);
    expect(again.json().payment).toEqual(first.json().payment);
    expect(h.events.length).toBe(before);
    expect(await auditActions(payment.id)).toEqual(['payment.confirm']);
  });

  test('refuses a cancelled payment and a stale expectedVersion', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const stale = await move(cashier, payment.id, 'confirm', { expectedVersion: 9 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    await call('POST', `/v1/payments/${payment.id}/change-method`, cashier, payBody('platform'));
    await setMethods({ cash: true, promptpay: true, platform: true, other: true });
    const res = await move(cashier, payment.id, 'confirm');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('cancel-claimed', () => {
  test('needs a reason, is audited, and puts the order back to unpaid', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    await move(cashier, payment.id, 'claim');
    expect((await move(cashier, payment.id, 'cancel-claimed', {})).statusCode).toBe(400);
    expect((await move(cashier, payment.id, 'cancel-claimed', { reason: '  ' })).statusCode).toBe(
      400,
    );
    const before = h.events.length;
    const res = await move(cashier, payment.id, 'cancel-claimed', { reason: 'ไม่พบยอดเงินเข้า' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({ status: 'cancelled', reason: 'ไม่พบยอดเงินเข้า' });
    expect(res.json().order.paymentStatus).toBe('unpaid');
    const audit = (await h.auditRows(payment.id)).find(
      (a) => a.action === 'payment.cancel_claimed',
    );
    expect(audit).toMatchObject({
      actorId: staff.cashier.id,
      entity: 'payments',
      before: { status: 'claimed', method: 'promptpay' },
      after: { status: 'cancelled', reason: 'ไม่พบยอดเงินเข้า' },
    });
    expect(typesOf(eventsSince(before))).toEqual(['payment.upserted', 'order.upserted']);
  });

  test('only a claimed payment; the kitchen may not; a retry is a no-op', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const pending = await move(cashier, payment.id, 'cancel-claimed', { reason: 'x' });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
    await move(cashier, payment.id, 'claim');
    expect(
      (await move(await sign('kitchen'), payment.id, 'cancel-claimed', { reason: 'x' })).statusCode,
    ).toBe(403);
    await move(cashier, payment.id, 'cancel-claimed', { reason: 'ไม่พบยอด' });
    const audits = (await h.auditRows(payment.id)).length;
    const again = await move(cashier, payment.id, 'cancel-claimed', { reason: 'ไม่พบยอด' });
    expect(again.statusCode).toBe(200);
    expect((await h.auditRows(payment.id)).length).toBe(audits);
  });
});

describe('change-method (02 §4.4)', () => {
  test('cancels the pending payment and creates the new one in one transaction; both events fire', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const old = await startPayment(cashier, order.id, 'promptpay');
    const before = h.events.length;
    const body = payBody('gov_copay');
    const res = await call('POST', `/v1/payments/${old.id}/change-method`, cashier, body);
    expect(res.statusCode).toBe(201);
    const { payment, cancelledPayment, order: updated } = res.json();
    expect(cancelledPayment).toMatchObject({ id: old.id, status: 'cancelled' });
    expect(payment).toMatchObject({
      method: 'gov_copay',
      status: 'pending',
      orderId: order.id,
      amountSatang: 5000,
    });
    expect(updated.paymentStatus).toBe('unpaid');
    expect(typesOf(eventsSince(before))).toEqual([
      'payment.upserted',
      'payment.upserted',
      'order.upserted',
    ]);
    expect(
      eventsSince(before).map((e) => (e.type === 'payment.upserted' ? e.data.status : e.type)),
    ).toEqual(['cancelled', 'pending', 'order.upserted']);
    const audit = (await h.auditRows(old.id)).find((a) => a.action === 'payment.change_method');
    expect(audit).toMatchObject({
      actorId: staff.cashier.id,
      before: { method: 'promptpay', status: 'pending' },
      after: { method: 'gov_copay', paymentId: payment.id },
    });
    expect(await paymentCount(order.id)).toBe(2);
  });

  test('changing to cash records the cash as confirmed straight away', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const old = await startPayment(cashier, order.id, 'promptpay');
    const res = await call(
      'POST',
      `/v1/payments/${old.id}/change-method`,
      cashier,
      payBody('cash', { tendered: 6000 }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().payment).toMatchObject({
      method: 'cash',
      status: 'confirmed',
      changeSatang: 1000,
      confirmedByStaffId: staff.cashier.id,
    });
    expect(res.json().order.paymentStatus).toBe('paid');
  });

  test('if the new payment cannot be made, nothing changes: the old one stays pending, no events', async () => {
    const cashier = await sign('cashier');
    const room = await place(cashier, { fulfillment: 'room_delivery', roomNo: '1204' });
    const old = await startPayment(cashier, room.id, 'promptpay');
    const before = h.events.length;
    const res = await call(
      'POST',
      `/v1/payments/${old.id}/change-method`,
      cashier,
      payBody('gov_copay'),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'GOV_COPAY_UNAVAILABLE' });
    const kept = await row('select status, version from payments where id = $1', [old.id]);
    expect(kept).toEqual({ status: 'pending', version: old.version });
    expect(await paymentCount(room.id)).toBe(1);
    expect(h.events.length).toBe(before);
    expect(await auditActions(old.id)).toEqual([]);
  });

  test('is refused once the payment is claimed or confirmed, and for the same method', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const p = await startPayment(cashier, order.id, 'promptpay');
    const same = await call(
      'POST',
      `/v1/payments/${p.id}/change-method`,
      cashier,
      payBody('promptpay'),
    );
    expect(same.statusCode).toBe(422);
    expect(same.json()).toMatchObject({ code: 'METHOD_UNCHANGED' });

    await move(cashier, p.id, 'claim');
    const claimed = await call(
      'POST',
      `/v1/payments/${p.id}/change-method`,
      cashier,
      payBody('cash'),
    );
    expect(claimed.statusCode).toBe(409);
    expect(claimed.json()).toMatchObject({
      code: 'PAYMENT_NOT_PENDING',
      details: { status: 'claimed' },
    });

    await move(cashier, p.id, 'confirm');
    const confirmed = await call(
      'POST',
      `/v1/payments/${p.id}/change-method`,
      cashier,
      payBody('cash'),
    );
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json()).toMatchObject({
      code: 'PAYMENT_NOT_PENDING',
      details: { status: 'confirmed' },
    });
    expect(await paymentCount(order.id)).toBe(1);
  });

  test('is idempotent by its request id: a retry returns the same new payment, a changed body is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const old = await startPayment(cashier, order.id, 'promptpay');
    const body = payBody('platform');
    await setMethods({ cash: true, promptpay: true, platform: true, other: true });
    const first = await call('POST', `/v1/payments/${old.id}/change-method`, cashier, body);
    expect(first.statusCode).toBe(201);
    const before = h.events.length;
    const again = await call('POST', `/v1/payments/${old.id}/change-method`, cashier, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.id).toBe(first.json().payment.id);
    expect(again.json().cancelledPayment.id).toBe(old.id);
    expect(await paymentCount(order.id)).toBe(2);
    expect(h.events.length).toBe(before);
    const changed = await call('POST', `/v1/payments/${old.id}/change-method`, cashier, {
      ...body,
      method: 'other',
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('needs payment.record', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const p = await startPayment(cashier, order.id, 'promptpay');
    const res = await call(
      'POST',
      `/v1/payments/${p.id}/change-method`,
      await sign('kitchen'),
      payBody('cash'),
    );
    expect(res.statusCode).toBe(403);
    expect(
      (await call('POST', `/v1/payments/${p.id}/change-method`, undefined, payBody('cash')))
        .statusCode,
    ).toBe(401);
  });
});

describe.each(['void', 'refund'] as const)('%s (rule 9)', (action) => {
  const target = action === 'void' ? 'voided' : 'refunded';

  async function confirmedCash(token: string) {
    const order = await place(token);
    const payment = await startPayment(token, order.id, 'cash');
    return { order, payment };
  }

  test('a cashier may not; a manager needs a fresh step-up', async () => {
    const cashier = await sign('cashier');
    const { payment } = await confirmedCash(cashier);
    const forbidden = await move(cashier, payment.id, action, { reason: 'ลูกค้าคืน' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });
    const manager = await sign('manager');
    const noStepUp = await move(manager, payment.id, action, { reason: 'ลูกค้าคืน' });
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await row('select status from payments where id = $1', [payment.id]))?.status).toBe(
      'confirmed',
    );
    h.clock.advanceSeconds(301); // the step-up window is five minutes
    const stale = await steppedManager();
    h.clock.advanceSeconds(301);
    expect((await move(stale, payment.id, action, { reason: 'ลูกค้าคืน' })).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  test('needs a reason, audits it, raises a critical owner alert and fixes the order status', async () => {
    const cashier = await sign('cashier');
    const { order, payment } = await confirmedCash(cashier);
    const manager = await steppedManager();
    expect((await move(manager, payment.id, action, {})).statusCode).toBe(400);
    expect((await move(manager, payment.id, action, { reason: '   ' })).statusCode).toBe(400);

    const events = h.events.length;
    const alerts = h.alerts.length;
    const res = await move(manager, payment.id, action, { reason: 'ลูกค้าคืนสินค้า' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({
      status: target,
      reason: 'ลูกค้าคืนสินค้า',
      // The cash was confirmed by the cashier; the void does not rewrite who confirmed it.
      confirmedByStaffId: staff.cashier.id,
    });
    expect(res.json().order.paymentStatus).toBe(action === 'void' ? 'unpaid' : 'refunded');
    expect((await orderNow(manager, order.id)).paymentStatus).toBe(
      action === 'void' ? 'unpaid' : 'refunded',
    );

    const audit = (await h.auditRows(payment.id)).find((a) => a.action === `payment.${action}`);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: staff.manager.id,
      entity: 'payments',
      before: { status: 'confirmed', method: 'cash', amountSatang: 5000 },
      after: { status: target, reason: 'ลูกค้าคืนสินค้า' },
    });
    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({
        kind: `payment.${target}`,
        severity: 'critical',
        staffId: staff.manager.id,
      }),
    ]);
    expect(typesOf(eventsSince(events)).filter((t) => t !== 'alert.security')).toEqual([
      'payment.upserted',
      'order.upserted',
    ]);
  });

  test('works for the owner after step-up', async () => {
    const cashier = await sign('cashier');
    const { payment } = await confirmedCash(cashier);
    h.clock.advanceSeconds(90);
    const token = await h.steppedUpOwner(owner);
    expect((await move(token, payment.id, action, { reason: 'ทดสอบ' })).statusCode).toBe(200);
  });

  test('only a confirmed payment; a retry is a no-op; the other move is refused', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const pending = await startPayment(cashier, order.id, 'promptpay');
    const manager = await steppedManager();
    const early = await move(manager, pending.id, action, { reason: 'x' });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'INVALID_TRANSITION' });

    const { payment } = await confirmedCash(cashier);
    await move(manager, payment.id, action, { reason: 'ครั้งแรก' });
    const audits = (await h.auditRows(payment.id)).length;
    const alerts = h.alerts.length;
    const again = await move(manager, payment.id, action, { reason: 'ครั้งแรก' });
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.status).toBe(target);
    expect((await h.auditRows(payment.id)).length).toBe(audits);
    expect(h.alerts.length).toBe(alerts);

    const other = action === 'void' ? 'refund' : 'void';
    const wrong = await move(manager, payment.id, other, { reason: 'x' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

// ---------- The QR picture ----------

describe('PromptPay QR (signed link)', () => {
  async function pendingPromptpay() {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    return { cashier, order, payment };
  }
  const urlOf = async (token: string, id: string) =>
    (await call('GET', `/v1/payments/${id}/qr-url`, token)).json() as {
      url: string;
      expiresAt: string;
    };
  const fetchPng = (url: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url, headers, remoteAddress: h.nextIp() });
  const expectedPng = (id: string, amount: number) =>
    QRCode.toBuffer(promptpayPayload({ idType: 'phone', idValue: id }, satang(amount)), {
      ...QR_PNG_OPTIONS,
    });

  test('the link needs a staff session with payment.record', async () => {
    const { cashier, payment } = await pendingPromptpay();
    expect((await call('GET', `/v1/payments/${payment.id}/qr-url`, undefined)).statusCode).toBe(
      401,
    );
    expect(
      (await call('GET', `/v1/payments/${payment.id}/qr-url`, await sign('kitchen'))).statusCode,
    ).toBe(403);
    const ok = await call('GET', `/v1/payments/${payment.id}/qr-url`, cashier);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toMatch(
      new RegExp(`^/v1/payments/${payment.id}/qr\\.png\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$`),
    );
    expect(ok.json().expiresAt).toBe(new Date(h.clock.now().getTime() + 300_000).toISOString());
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(
      (await call('GET', `/v1/payments/${crypto.randomUUID()}/qr-url`, cashier)).statusCode,
    ).toBe(404);
  });

  test('the picture needs no Authorization header: the signature is the authentication', async () => {
    const { cashier, payment } = await pendingPromptpay();
    const { url } = await urlOf(cashier, payment.id);
    const res = await fetchPng(url); // no bearer, no device token
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // It is the QR of the exact order amount for the PromptPay ID in settings.
    expect(res.rawPayload.equals(await expectedPng(PHONE, 5000))).toBe(true);
    // A junk bearer does not matter either way.
    expect((await fetchPng(url, { authorization: 'Bearer junk' })).statusCode).toBe(200);
  });

  test('the picture is rebuilt from the CURRENT PromptPay ID on every serve', async () => {
    const { cashier, payment } = await pendingPromptpay();
    const { url } = await urlOf(cashier, payment.id);
    const first = await fetchPng(url);
    await setPromptpayId(OTHER_PHONE);
    const second = await fetchPng(url);
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(false);
    expect(second.rawPayload.equals(await expectedPng(OTHER_PHONE, 5000))).toBe(true);
    // With no ID configured it is a clear error, not a stale picture.
    await setPromptpayId(null);
    const gone = await fetchPng(url);
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ code: 'PROMPTPAY_NOT_CONFIGURED' });
  });

  test('a link for a claimed payment still works; confirmed, cancelled or voided ones do not', async () => {
    const { cashier, payment, order } = await pendingPromptpay();
    const { url } = await urlOf(cashier, payment.id);
    await move(cashier, payment.id, 'claim');
    expect((await fetchPng(url)).statusCode).toBe(200);
    await move(cashier, payment.id, 'confirm');
    const done = await fetchPng(url);
    expect(done.statusCode).toBe(404);
    expect((await call('GET', `/v1/payments/${payment.id}/qr-url`, cashier)).json()).toMatchObject({
      code: 'QR_NOT_AVAILABLE',
    });

    const second = await place(cashier);
    const pending = await startPayment(cashier, second.id, 'promptpay');
    const link = await urlOf(cashier, pending.id);
    await call('POST', `/v1/payments/${pending.id}/change-method`, cashier, payBody('cash'));
    expect((await fetchPng(link.url)).statusCode).toBe(404);
    expect(order.id).not.toBe(second.id);
  });

  test('cash and other methods have no QR link', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const cash = await startPayment(cashier, order.id, 'cash');
    const res = await call('GET', `/v1/payments/${cash.id}/qr-url`, cashier);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'QR_NOT_AVAILABLE' });
  });

  test('a tampered, swapped or malformed link is refused', async () => {
    const { cashier, payment } = await pendingPromptpay();
    const other = await startPayment(cashier, (await place(cashier)).id, 'promptpay');
    const { url } = await urlOf(cashier, payment.id);
    const u = new URL(url, 'http://x');
    const exp = u.searchParams.get('exp') ?? '';
    const sig = u.searchParams.get('sig') ?? '';
    const base = `/v1/payments/${payment.id}/qr.png`;
    const bad = [
      `${base}?exp=${Number(exp) + 1}&sig=${sig}`, // longer life
      `${base}?exp=${exp}&sig=${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, // one character off
      `/v1/payments/${other.id}/qr.png?exp=${exp}&sig=${sig}`, // another payment
      `${base}?exp=${exp}`, // no signature
      `${base}?sig=${sig}`, // no expiry
      `${base}?exp=abc&sig=${sig}`,
      `${base}?exp=${exp}&sig=short`,
      base,
    ];
    for (const link of bad) {
      const res = await fetchPng(link);
      expect(res.statusCode, link).toBe(403);
      expect(res.json()).toMatchObject({ code: 'QR_LINK_INVALID' });
    }
  });

  test('a link is dead after five minutes, and only a genuine one is called expired', async () => {
    const { cashier, payment } = await pendingPromptpay();
    const { url } = await urlOf(cashier, payment.id);
    h.clock.advanceSeconds(299);
    expect((await fetchPng(url)).statusCode).toBe(200);
    h.clock.advanceSeconds(2);
    const late = await fetchPng(url);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ code: 'QR_LINK_EXPIRED' });
    // The staff app asks again and gets a working one.
    expect((await fetchPng((await urlOf(cashier, payment.id)).url)).statusCode).toBe(200);
  });

  test('a link signed with another master key is refused', async () => {
    const { payment } = await pendingPromptpay();
    const exp = Math.floor(h.clock.now().getTime() / 1000) + 60;
    const forged = signQrLink(deriveAuthKeys(Buffer.alloc(32, 9)).qrUrlKey, payment.id, exp);
    const res = await fetchPng(`/v1/payments/${payment.id}/qr.png?exp=${exp}&sig=${forged}`);
    expect(res.statusCode).toBe(403);
    const real = signQrLink(h.keys.qrUrlKey, payment.id, exp);
    expect(
      (await fetchPng(`/v1/payments/${payment.id}/qr.png?exp=${exp}&sig=${real}`)).statusCode,
    ).toBe(200);
  });

  test('the public route is rate limited', async () => {
    const { payment } = await pendingPromptpay();
    const ip = '10.99.99.99';
    let last = 0;
    for (let i = 0; i < 70; i += 1) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1/payments/${payment.id}/qr.png?exp=1&sig=${'A'.repeat(43)}`,
        remoteAddress: ip,
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

// ---------- Reading ----------

describe('GET /v1/orders/:id/payments', () => {
  test('lists the order payments, oldest first, to staff with payment.record', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const first = await startPayment(cashier, order.id, 'promptpay');
    await call('POST', `/v1/payments/${first.id}/change-method`, cashier, payBody('cash'));
    const res = await call('GET', `/v1/orders/${order.id}/payments`, cashier);
    expect(res.statusCode).toBe(200);
    const payments = res.json().payments as PaymentDto[];
    expect(payments.map((p) => [p.method, p.status])).toEqual([
      ['promptpay', 'cancelled'],
      ['cash', 'confirmed'],
    ]);
    expect(JSON.stringify(res.json())).not.toContain(PHONE);
    expect(
      (await call('GET', `/v1/orders/${order.id}/payments`, await sign('kitchen'))).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/orders/${crypto.randomUUID()}/payments`, cashier)).statusCode,
    ).toBe(404);
  });
});

// ---------- Cancelling an order that has payments (rule 4 of this task) ----------

describe.each([
  [
    'POST /cancel',
    (token: string, id: string) =>
      call('POST', `/v1/orders/${id}/cancel`, token, { reason: 'ลูกค้ายกเลิก' }),
  ],
  [
    'POST /transition',
    (token: string, id: string) =>
      call('POST', `/v1/orders/${id}/transition`, token, { to: 'cancelled', reason: 'ลูกค้ายกเลิก' }),
  ],
])('order cancel through %s', (_name, cancel) => {
  test('cancels the pending payments through the machine, in the same transaction, with events', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    const before = h.events.length;
    const res = await cancel(await sign('manager'), order.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', paymentStatus: 'unpaid' });
    expect(await row('select status from payments where id = $1', [payment.id])).toEqual({
      status: 'cancelled',
    });
    expect(typesOf(eventsSince(before))).toEqual(['payment.upserted', 'order.upserted']);
    const paymentEvent = eventsSince(before)[0];
    expect(paymentEvent?.type === 'payment.upserted' && paymentEvent.data.status).toBe('cancelled');
    // The QR link of the cancelled payment is dead.
    expect((await call('GET', `/v1/payments/${payment.id}/qr-url`, cashier)).statusCode).toBe(409);
  });

  test('refuses while a payment is claimed: cancel-claimed comes first', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'promptpay');
    await move(cashier, payment.id, 'claim');
    const before = h.events.length;
    const res = await cancel(await sign('manager'), order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'ORDER_HAS_PAYMENT',
      details: { paymentId: payment.id, status: 'claimed' },
    });
    expect(await row('select status from payments where id = $1', [payment.id])).toEqual({
      status: 'claimed',
    });
    expect((await orderNow(cashier, order.id)).status).toBe('preparing');
    expect(h.events.length).toBe(before);

    await move(cashier, payment.id, 'cancel-claimed', { reason: 'ไม่พบยอด' });
    expect((await cancel(await sign('manager'), order.id)).statusCode).toBe(200);
  });

  test('refuses while a payment is confirmed: a manager void comes first', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const payment = await startPayment(cashier, order.id, 'cash');
    const manager = await steppedManager();
    const res = await cancel(manager, order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'ORDER_HAS_PAYMENT',
      details: { status: 'confirmed' },
    });
    expect((await orderNow(cashier, order.id)).status).toBe('preparing');

    await move(manager, payment.id, 'void', { reason: 'คิดเงินผิด' });
    const done = await cancel(manager, order.id);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'cancelled', paymentStatus: 'unpaid' });
  });

  test('an order with no payments cancels as before, and a cancelled payment does not block', async () => {
    const cashier = await sign('cashier');
    const plain = await place(cashier);
    expect((await cancel(await sign('manager'), plain.id)).statusCode).toBe(200);

    const withHistory = await place(cashier);
    const p = await startPayment(cashier, withHistory.id, 'promptpay');
    await call('POST', `/v1/payments/${p.id}/change-method`, cashier, payBody('platform'));
    await setMethods({ cash: true, promptpay: true, platform: true, other: true });
    // platform is pending, the promptpay one is cancelled: both end cancelled.
    const res = await cancel(await sign('manager'), withHistory.id);
    expect(res.statusCode).toBe(200);
    expect(
      await count(
        "select count(*)::int as n from payments where order_id = $1 and status = 'cancelled'",
        [withHistory.id],
      ),
    ).toBe(2);
  });
});

// ---------- Nothing secret leaves the server ----------

describe('no PromptPay ID in anything that leaves the server', () => {
  test('payment events, payment responses, audit rows and logs never hold it', async () => {
    const start = h.events.length;
    const cashier = await sign('cashier');
    const manager = await steppedManager();
    const order = await place(cashier);
    const p = await startPayment(cashier, order.id, 'promptpay');
    await call('GET', `/v1/payments/${p.id}/qr-url`, cashier);
    await move(cashier, p.id, 'claim');
    await move(cashier, p.id, 'confirm');
    await move(manager, p.id, 'refund', { reason: 'ทดสอบ' });
    const paymentEvents = eventsSince(start).filter(
      (e) => e.type === 'payment.upserted' || e.type === 'order.upserted',
    );
    expect(paymentEvents.length).toBeGreaterThan(4);
    expect(JSON.stringify(paymentEvents)).not.toContain(PHONE);
    expect(JSON.stringify(await h.auditRows(p.id))).not.toContain(PHONE);
    expect(h.logs()).not.toContain(PHONE);
    expect(h.logs()).not.toContain(OTHER_PHONE);
    expect(JSON.stringify(paymentEvents)).not.toMatch(/qr_?payload/i);
  });
});
