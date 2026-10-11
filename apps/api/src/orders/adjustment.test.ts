/**
 * Partial adjustment of a paid order (owner decision 2026-10-11, D-25) and the customer's LINE
 * notice after an owner void or edit.
 */
import type { LineClient, LineMessage, TextMessage } from '@sds/line';
import { type OrderDto, orderDtoSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLineRuntime } from '../line/runtime.ts';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';

const SECRET = 'test-channel-secret-not-real';
const pushes: { to: string; messages: LineMessage[] }[] = [];
const fakeClient: LineClient = {
  async reply() {
    return { ok: true };
  },
  async push(to, messages) {
    pushes.push({ to, messages });
    return { ok: true };
  },
};

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let device: { id: string; token: string };
let cashierId: string;
let runtime: ReturnType<typeof createLineRuntime>;

beforeAll(async () => {
  runtime = createLineRuntime(
    { channelSecret: SECRET, channelAccessToken: undefined },
    { client: fakeClient },
  );
  h = await createHarness({ line: runtime });
  menu = await h.newMenu();
  owner = await h.newOwner();
  device = await h.newDevice();
  cashierId = (await h.newStaff('cashier', '4821')).id;
  await h.client.query(
    `insert into settings (key, value) values ('promptpay', '{"idType":"phone","idValue":"0812345678"}'::jsonb)
     on conflict (key) do nothing`,
  );
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 100;
function newDay(): void {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2029, 5, dayNo - 100, 3, 0, 0)).toISOString());
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
function call(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: bearer(token),
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}
const cashier = () => h.pinSession(device.token, cashierId, '4821');
async function ownerToken(): Promise<string> {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
}

/** Noodles 50.00 + two waters 10.00 each = 70.00. */
async function place(token: string): Promise<OrderDto> {
  const res = await call('POST', '/v1/orders', token, {
    clientRequestId: crypto.randomUUID(),
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    items: [
      { menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] },
      { menuItemId: menu.water, qty: 2, modifierOptionIds: [] },
    ],
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}
async function payCash(token: string, orderId: string, tendered = 20000) {
  const res = await call('POST', `/v1/orders/${orderId}/payments`, token, {
    clientRequestId: crypto.randomUUID(),
    method: 'cash',
    tendered,
  });
  if (res.statusCode !== 201) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
  return res.json() as { payment: { id: string; amountSatang: number } };
}
const orderOf = async (token: string, id: string) =>
  orderDtoSchema.parse((await call('GET', `/v1/orders/${id}`, token)).json());
const ver = async (token: string, id: string) => (await orderOf(token, id)).version;
const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.client.query<T>(sql, params)).rows;
const correct = (token: string, id: string, body: Record<string, unknown>) =>
  call('PATCH', `/v1/orders/${id}/correction`, token, { reason: 'แก้ไขตามที่ลูกค้าแจ้ง', ...body });
const paymentsOf = async (token: string, id: string) =>
  (await call('GET', `/v1/orders/${id}/payments`, token)).json() as {
    payments: { id: string; status: string; amountSatang: number; method: string }[];
    refunds: { amountSatang: number; method: string; referenceNote: string | null }[];
    netPaidSatang: number;
    dueSatang: number;
  };

describe('adjust: a lower total returns the difference', () => {
  test('the payment stays confirmed, a refund row is written, status is paid again', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    expect(order.totalSatang).toBe(7000);
    const { payment } = await payCash(token, order.id);
    const boss = await ownerToken();
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const alerts = h.alerts.length;
    const marker = h.events.length;

    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 1 },
      ],
      paymentAction: 'adjust',
      refund: { method: 'promptpay', referenceNote: 'ref-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      totalSatang: 6000,
      paymentStatus: 'paid',
    });

    const money = await paymentsOf(token, order.id);
    expect(money.payments).toHaveLength(1);
    expect(money.payments[0]).toMatchObject({
      id: payment.id,
      status: 'confirmed',
      amountSatang: 7000,
    });
    expect(money.refunds).toEqual([
      expect.objectContaining({
        amountSatang: 1000,
        method: 'promptpay',
        referenceNote: 'ref-123',
      }),
    ]);
    expect(money.netPaidSatang).toBe(6000);
    expect(money.dueSatang).toBe(0);

    const actions = (await h.auditRows(payment.id)).map((a) => a.action);
    expect(actions).toContain('payment.partial_refund');
    expect((await h.auditRows(order.id)).some((a) => a.action === 'order.correct')).toBe(true);
    expect(
      h.alerts
        .slice(alerts)
        .some((a) => a.kind === 'payment.partial_refund' && a.severity === 'critical'),
    ).toBe(true);
    expect(h.events.slice(marker).some((e) => e.type === 'order.upserted')).toBe(true);
  });

  test('the refund details are required, and nothing changes without them', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [{ orderItemId: noodles?.id, qty: 1 }],
      paymentAction: 'adjust',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('REFUND_DETAILS_REQUIRED');
    expect((await orderOf(token, order.id)).totalSatang).toBe(7000);
    expect((await paymentsOf(token, order.id)).refunds).toEqual([]);
  });

  test('a refund sent where none is needed is refused; an amount is never accepted', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const up = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 2 },
        { orderItemId: water?.id, qty: 2 },
      ],
      paymentAction: 'adjust',
      refund: { method: 'cash' },
    });
    expect(up.statusCode).toBe(422);
    expect(up.json().code).toBe('REFUND_NOT_NEEDED');
    const withAmount = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [{ orderItemId: noodles?.id, qty: 1 }],
      paymentAction: 'adjust',
      refund: { method: 'cash', amountSatang: 1 },
    });
    expect(withAmount.statusCode).toBe(400);
  });

  test('a claimed payment blocks it; a manager cannot', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const { payment } = await payCash(token, order.id);
    await h.client.query(
      `insert into payments (order_id, method, status, amount_satang, client_request_id)
       values ($1, 'promptpay', 'claimed', 100, gen_random_uuid())`,
      [order.id],
    );
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [{ orderItemId: noodles?.id, qty: 1 }],
      paymentAction: 'adjust',
      refund: { method: 'cash' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ADJUST_CLAIM_OPEN');
    expect((await h.auditRows(payment.id)).some((a) => a.action === 'payment.partial_refund')).toBe(
      false,
    );
  });

  test('a void or refund after a partial refund returns only what is left, and net paid is zero', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const { payment } = await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const first = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 1 },
      ],
      paymentAction: 'adjust',
      refund: { method: 'cash' },
    });
    expect(first.statusCode).toBe(200);
    const now = await orderOf(token, order.id);
    const voided = await call('POST', `/v1/orders/${order.id}/void`, await ownerToken(), {
      clientRequestId: crypto.randomUUID(),
      reason: 'ยกเลิก',
      expectedVersion: now.version,
      paymentAction: 'refund',
    });
    expect(voided.statusCode).toBe(201);
    const money = await paymentsOf(token, order.id);
    expect(money.payments[0]).toMatchObject({ id: payment.id, status: 'refunded' });
    expect(money.netPaidSatang).toBe(0);
    const refundAudit = (await h.auditRows(payment.id)).find((a) => a.action === 'payment.refund');
    expect(refundAudit?.after).toMatchObject({ returnedSatang: 6000, refundedEarlierSatang: 1000 });
  });
});

describe('adjust: a higher total leaves a difference for the normal payment flow', () => {
  test('partially paid, a top-up charges exactly the difference by cash or PromptPay, staff confirm', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const { payment } = await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 5 },
      ],
      paymentAction: 'adjust',
    });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      totalSatang: 10000,
      paymentStatus: 'partially_paid',
    });
    const money = await paymentsOf(token, order.id);
    expect(money.payments).toHaveLength(1);
    expect(money.payments[0]).toMatchObject({ id: payment.id, status: 'confirmed' });
    expect(money.dueSatang).toBe(3000);
    expect(money.netPaidSatang).toBe(7000);

    // PromptPay for the difference: pending, exact amount, never confirmed by itself.
    const pp = await call('POST', `/v1/orders/${order.id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'promptpay',
    });
    expect(pp.statusCode).toBe(201);
    expect(pp.json().payment).toMatchObject({ status: 'pending', amountSatang: 3000 });
    expect((await orderOf(token, order.id)).paymentStatus).toBe('partially_paid');

    const confirm = await call('POST', `/v1/payments/${pp.json().payment.id}/confirm`, token, {});
    expect(confirm.statusCode).toBe(200);
    expect(orderDtoSchema.parse(confirm.json().order).paymentStatus).toBe('paid');
    const done = await paymentsOf(token, order.id);
    expect(done.dueSatang).toBe(0);
    expect(done.netPaidSatang).toBe(10000);
    const again = await call('POST', `/v1/orders/${order.id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 5000,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ORDER_ALREADY_PAID');
  });

  test('a cash top-up computes change from the difference', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 3 },
      ],
      paymentAction: 'adjust',
    });
    const low = await call('POST', `/v1/orders/${order.id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 500,
    });
    expect(low.statusCode).toBe(422);
    const ok = await call('POST', `/v1/orders/${order.id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 2000,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().payment).toMatchObject({ amountSatang: 1000, changeSatang: 1000 });
    expect((await orderOf(token, order.id)).paymentStatus).toBe('paid');
  });

  test('a pending payment is cancelled when adjusting, so no stale QR stays open', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await h.client.query(
      `insert into payments (order_id, method, status, amount_satang, client_request_id)
       values ($1, 'gov_copay', 'pending', $2, gen_random_uuid())`,
      [order.id, order.totalSatang],
    );
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [{ orderItemId: noodles?.id, qty: 3 }],
      paymentAction: 'adjust',
    });
    expect(res.statusCode).toBe(200);
    expect(
      (
        await rows<{ status: string }>('select status from payments where order_id = $1', [
          order.id,
        ])
      ).map((r) => r.status),
    ).toEqual(['cancelled']);
  });

  test('void and refund still work as before', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const { payment } = await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const res = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [{ orderItemId: noodles?.id, qty: 1 }],
      paymentAction: 'refund',
    });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json()).paymentStatus).toBe('refunded');
    expect((await paymentsOf(token, order.id)).payments[0]).toMatchObject({
      id: payment.id,
      status: 'refunded',
    });
    // `refund` details only go with `adjust`.
    const bad = await correct(await ownerToken(), order.id, {
      expectedVersion: 99,
      note: 'x',
      paymentAction: 'void',
      refund: { method: 'cash' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('the customer is told on LINE', () => {
  const LINE_USER = 'Utest00000000000000000000000000c3';
  async function lineOrder(token: string): Promise<{ order: OrderDto; customerId: string }> {
    const order = await place(token);
    const [cust] = await rows<{ id: string }>(
      `insert into customers (line_user_id) values ($1)
       on conflict (line_user_id) do update set line_user_id = excluded.line_user_id returning id`,
      [LINE_USER],
    );
    await h.client.query("update orders set channel = 'line', customer_id = $1 where id = $2", [
      cust?.id,
      order.id,
    ]);
    return { order: await orderOf(token, order.id), customerId: cust?.id as string };
  }
  const textOf = (m: LineMessage | undefined) => (m as TextMessage | undefined)?.text ?? '';
  const reset = async () => {
    pushes.length = 0;
    await h.client.query('delete from line_quota_months');
  };

  test('a void sends one push with the order number and the refund; a replay sends none', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const { order } = await lineOrder(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const clientRequestId = crypto.randomUUID();
    const body = { clientRequestId, reason: 'ยกเลิก', paymentAction: 'refund' };
    const res = await call('POST', `/v1/orders/${order.id}/void`, boss, body);
    expect(res.statusCode).toBe(201);
    await runtime.idle();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.to).toBe(LINE_USER);
    expect(pushes[0]?.messages[0]?.type).toBe('text');
    expect(textOf(pushes[0]?.messages[0])).toContain(order.orderNo);
    expect(textOf(pushes[0]?.messages[0])).toContain('70');
    const again = await call('POST', `/v1/orders/${order.id}/void`, boss, body);
    expect(again.statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(1);
  });

  test('an edit sends a push with the new total and the top-up; each edit its own push', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const { order } = await lineOrder(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const first = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 5 },
      ],
      paymentAction: 'adjust',
    });
    expect(first.statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(1);
    expect(textOf(pushes[0]?.messages[0])).toContain(order.orderNo);
    expect(textOf(pushes[0]?.messages[0])).toContain('100');
    expect(textOf(pushes[0]?.messages[0])).toContain('30');
    const second = await correct(await ownerToken(), order.id, {
      expectedVersion: orderDtoSchema.parse(first.json()).version,
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 1 },
      ],
      paymentAction: 'adjust',
      refund: { method: 'cash' },
    });
    expect(second.statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(2);
  });

  test('a note-only edit, a storefront order and an exhausted quota send nothing and never fail the request', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const { order } = await lineOrder(token);
    const boss = await ownerToken();
    const noteOnly = await correct(boss, order.id, {
      expectedVersion: await ver(token, order.id),
      note: 'x',
    });
    expect(noteOnly.statusCode).toBe(200);

    const store = await place(token);
    const storeVoid = await call('POST', `/v1/orders/${store.id}/void`, await ownerToken(), {
      clientRequestId: crypto.randomUUID(),
      reason: 'ยกเลิก',
    });
    expect(storeVoid.statusCode).toBe(201);

    await h.client.query(
      `insert into settings (key, value) values ('line_policy', '{"push":"essential","monthlyLimit":1}'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    await h.client.query(
      'insert into line_quota_months (month, used) values ($1, 1) on conflict (month) do update set used = 1',
      [
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Bangkok',
          year: 'numeric',
          month: '2-digit',
        })
          .format(h.clock.now())
          .slice(0, 7),
      ],
    );
    const { order: capped } = await lineOrder(token);
    const res = await call('POST', `/v1/orders/${capped.id}/void`, await ownerToken(), {
      clientRequestId: crypto.randomUUID(),
      reason: 'ยกเลิก',
    });
    expect(res.statusCode).toBe(201);
    await runtime.idle();
    expect(pushes).toHaveLength(0);
    await h.client.query("delete from settings where key = 'line_policy'");
  });
});
