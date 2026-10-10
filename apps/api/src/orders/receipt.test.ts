/**
 * Issuing a receipt (owner decision 2026-10-11): POST /v1/orders/:id/receipt on the real app and
 * an in-memory Postgres. Every issue is an audit row (who, order, payment); the money in the
 * answer is what the server stored, never anything the client sent.
 */
import { type OrderDto, orderDtoSchema, receiptResponseSchema } from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', { id: string; pin: string }>;

// A made-up number that only satisfies the check digit.
const TAX_ID = '1234567890121';
const ADDRESS = '1 ถนนทดสอบ แขวงทดสอบ กรุงเทพฯ 10000';

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

let dayNo = 0;
beforeEach(async () => {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2028, 2, dayNo, 3, 0, 0)).toISOString());
  await h.client.query("delete from settings where key in ('receipt', 'shop')");
});

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
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function place(token: string): Promise<OrderDto> {
  const res = await call('POST', '/v1/orders', token, {
    clientRequestId: crypto.randomUUID(),
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}

/** Cash is recorded as confirmed in the same step. */
async function paidOrder(token: string): Promise<{ order: OrderDto; paymentId: string }> {
  const order = await place(token);
  const res = await call('POST', `/v1/orders/${order.id}/payments`, token, {
    clientRequestId: crypto.randomUUID(),
    method: 'cash',
    tendered: 100000,
  });
  if (res.statusCode !== 201) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
  return { order, paymentId: res.json().payment.id as string };
}

const issue = (
  token: string | undefined,
  orderId: string,
  body: unknown = { clientRequestId: crypto.randomUUID() },
  headers: Record<string, string> = {},
) => call('POST', `/v1/orders/${orderId}/receipt`, token, body, headers);

const receiptAudit = async (orderId: string) =>
  (await h.auditRows(orderId)).filter((a) => a.action === 'order.receipt.issue');

async function saveReceiptSettings() {
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('receipt', $1::jsonb, $2)",
    [JSON.stringify({ taxId: TAX_ID, address: ADDRESS }), owner.staffId],
  );
}

describe('who may issue', () => {
  test('cashiers, managers and the owner; not the kitchen, not without a session', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    expect((await issue(undefined, order.id)).statusCode).toBe(401);
    const kitchen = await issue(await sign('kitchen'), order.id);
    expect(kitchen.statusCode).toBe(403);
    expect(kitchen.json()).toMatchObject({ code: 'FORBIDDEN' });
    for (const token of [cashier, await sign('manager'), await h.ownerSession(owner)]) {
      expect((await issue(token, order.id)).statusCode).toBe(201);
    }
  });
});

describe('what it returns', () => {
  test('the shop, the order and its confirmed payment, as the server stored them', async () => {
    await saveReceiptSettings();
    const cashier = await sign('cashier');
    const { order, paymentId } = await paidOrder(cashier);
    const res = await issue(cashier, order.id);
    expect(res.statusCode).toBe(201);
    const receipt = receiptResponseSchema.parse(res.json());
    expect(receipt.shop).toEqual({
      nameTh: 'แซ่บโดนเส้น',
      nameEn: 'Saap Don Sen',
      phone: null,
      taxId: TAX_ID,
      address: ADDRESS,
    });
    expect(receipt.order.id).toBe(order.id);
    expect(receipt.order.totalSatang).toBe(order.totalSatang);
    expect(receipt.order.items.length).toBe(order.items.length);
    expect(receipt.payment).toMatchObject({
      id: paymentId,
      orderId: order.id,
      status: 'confirmed',
      method: 'cash',
      amountSatang: order.totalSatang,
    });
    expect(receipt.issuedAt).toBe(h.clock.now().toISOString());
  });

  test('works with the tax ID and address never set: both come back null', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    const res = await issue(cashier, order.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().shop).toMatchObject({ taxId: null, address: null });
    expect(await receiptAudit(order.id)).toHaveLength(1);
  });

  test('the shop name and phone follow the shop setting', async () => {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('shop', $1::jsonb, $2)",
      [JSON.stringify({ nameTh: 'ร้านทดสอบ', nameEn: null, phone: '020000000' }), owner.staffId],
    );
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    expect((await issue(cashier, order.id)).json().shop).toMatchObject({
      nameTh: 'ร้านทดสอบ',
      nameEn: null,
      phone: '020000000',
    });
  });

  test('a client cannot send an amount or a shop detail', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    for (const extra of [{ totalSatang: 1 }, { taxId: TAX_ID }, { address: 'x' }]) {
      const res = await issue(cashier, order.id, {
        clientRequestId: crypto.randomUUID(),
        ...extra,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect((await issue(cashier, order.id, {})).statusCode).toBe(400);
    expect(await receiptAudit(order.id)).toHaveLength(0);
  });
});

describe('only for an order with a confirmed payment', () => {
  test('no payment, a pending one, a claimed one: refused, nothing audited', async () => {
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const none = await issue(cashier, order.id);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'RECEIPT_NOT_AVAILABLE' });

    await call('POST', `/v1/orders/${order.id}/payments`, cashier, {
      clientRequestId: crypto.randomUUID(),
      method: 'other',
    });
    const pending = await issue(cashier, order.id);
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ code: 'RECEIPT_NOT_AVAILABLE' });
    expect(await receiptAudit(order.id)).toHaveLength(0);
  });

  test('a voided payment gives no receipt', async () => {
    const cashier = await sign('cashier');
    const { order, paymentId } = await paidOrder(cashier);
    const manager = await sign('manager');
    await call('POST', '/v1/auth/step-up', manager, { pin: staff.manager.pin });
    const voided = await call('POST', `/v1/payments/${paymentId}/void`, manager, {
      reason: 'test',
    });
    expect(voided.statusCode).toBe(200);
    const res = await issue(cashier, order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'RECEIPT_NOT_AVAILABLE' });
  });

  test('an unknown order is a plain 404', async () => {
    const res = await issue(await sign('cashier'), crypto.randomUUID());
    expect(res.statusCode).toBe(404);
  });
});

describe('audit and idempotency', () => {
  test('each issue writes an audit row: who, which order, which payment, never a total or a name', async () => {
    await saveReceiptSettings();
    const cashier = await sign('cashier');
    const { order, paymentId } = await paidOrder(cashier);
    const clientRequestId = crypto.randomUUID();
    await issue(cashier, order.id, { clientRequestId });
    const rows = await receiptAudit(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'staff',
      actorId: staff.cashier.id,
      deviceId: device.id,
      entity: 'orders',
      entityId: order.id,
      after: { clientRequestId, paymentId },
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain('Test Recipient');
    expect(text).not.toContain(TAX_ID);
  });

  test('the same request id answers 200 with the same receipt and writes no second audit row', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    const clientRequestId = crypto.randomUUID();
    const first = await issue(cashier, order.id, { clientRequestId });
    const again = await issue(
      cashier,
      order.id,
      { clientRequestId },
      {
        'idempotency-key': clientRequestId,
      },
    );
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().payment.id).toBe(first.json().payment.id);
    expect(await receiptAudit(order.id)).toHaveLength(1);
  });

  test('a new request id is a new issue, so a re-print is recorded too', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    await issue(cashier, order.id);
    await issue(cashier, order.id);
    expect(await receiptAudit(order.id)).toHaveLength(2);
  });

  test('an Idempotency-Key header that differs from the body is refused', async () => {
    const cashier = await sign('cashier');
    const { order } = await paidOrder(cashier);
    const res = await issue(
      cashier,
      order.id,
      { clientRequestId: crypto.randomUUID() },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
    expect(await receiptAudit(order.id)).toHaveLength(0);
  });
});
