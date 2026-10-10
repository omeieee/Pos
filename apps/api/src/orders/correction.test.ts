/**
 * The owner's correction and void of past orders (decision 2026-10-11): owner only, step-up,
 * audit, alert, one transaction, recomputed totals, and payments retired through the machine.
 */
import { type OrderDto, orderDtoSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
let cashierId: string;
let manager: { id: string; pin: string };

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  owner = await h.newOwner();
  device = await h.newDevice();
  cashierId = (await h.newStaff('cashier', '4821')).id;
  manager = await h.newStaff('manager', '4821');
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 0;
function newDay(): void {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2029, 0, dayNo, 3, 0, 0)).toISOString());
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
  h.clock.advanceSeconds(90); // a TOTP code works once per 30-second step
  return h.steppedUpOwner(owner);
}

async function place(token: string, items?: unknown[]): Promise<OrderDto> {
  const res = await call('POST', '/v1/orders', token, {
    clientRequestId: crypto.randomUUID(),
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    items: items ?? [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}

async function finish(token: string, id: string): Promise<void> {
  for (const to of ['ready', 'completed']) {
    const res = await call('POST', `/v1/orders/${id}/transition`, token, { to });
    if (res.statusCode !== 200) throw new Error(`transition failed: ${res.statusCode}`);
  }
}

async function payCash(token: string, orderId: string): Promise<string> {
  const res = await call('POST', `/v1/orders/${orderId}/payments`, token, {
    clientRequestId: crypto.randomUUID(),
    method: 'cash',
    tendered: 20000,
  });
  if (res.statusCode !== 201) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { payment: { id: string } }).payment.id;
}

const orderOf = async (token: string, id: string) =>
  orderDtoSchema.parse((await call('GET', `/v1/orders/${id}`, token)).json());
const dbRow = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
  (await h.client.query<T>(sql, params)).rows;

const correct = (token: string, id: string, body: Record<string, unknown>) =>
  call('PATCH', `/v1/orders/${id}/correction`, token, { reason: 'แก้ไขตามที่ลูกค้าแจ้ง', ...body });
const voidIt = (token: string, id: string, body: Record<string, unknown> = {}) =>
  call('POST', `/v1/orders/${id}/void`, token, {
    clientRequestId: crypto.randomUUID(),
    reason: 'ยกเลิกตามที่เจ้าของสั่ง',
    ...body,
  });

describe('who may', () => {
  test('a manager is refused, and the owner needs a fresh step-up', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const managerToken = await h.pinSession(device.token, manager.id, manager.pin);
    for (const res of [
      await correct(managerToken, order.id, { expectedVersion: order.version, note: 'x' }),
      await voidIt(managerToken, order.id),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
    }
    h.clock.advanceSeconds(90);
    const noStepUp = await h.ownerSession(owner);
    const res = await voidIt(noStepUp, order.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('STEP_UP_REQUIRED');
    expect((await orderOf(token, order.id)).status).toBe('preparing');
  });
});

describe('correcting an order', () => {
  test('items: a saved line keeps its price, a new line is priced now, a left-out line is marked removed', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token, [
      { menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] },
      { menuItemId: menu.water, qty: 2, modifierOptionIds: [] },
    ]);
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const water = order.items.find((i) => i.menuItemId === menu.water);
    expect(order.totalSatang).toBe(5000 + 2 * 1000);
    // The menu price changes afterwards: the saved line must keep the price it was sold at.
    await h.client.query('update menu_items set price_satang = 9000 where id = $1', [menu.noodles]);
    try {
      const boss = await ownerToken();
      const res = await correct(boss, order.id, {
        expectedVersion: order.version,
        items: [
          { orderItemId: noodles?.id, qty: 2 },
          {
            menuItemId: menu.egg ? menu.noodles : menu.noodles,
            qty: 1,
            modifierOptionIds: [menu.wide],
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      const body = orderDtoSchema.parse(res.json());
      // 2 x 50.00 (saved) + 1 x 90.00 (new, today's price); the water line is gone.
      expect(body.subtotalSatang).toBe(2 * 5000 + 9000);
      expect(body.totalSatang).toBe(body.subtotalSatang);
      expect(body.items).toHaveLength(2);
      expect(body.items.some((i) => i.menuItemId === menu.water)).toBe(false);
      expect(body.version).toBeGreaterThan(order.version);
      expect(body.rev).toBeGreaterThan(order.rev);
      const kept = await dbRow<{ removed_at: string | null }>(
        'select removed_at from order_items where id = $1',
        [water?.id],
      );
      expect(kept).toHaveLength(1);
      expect(kept[0]?.removed_at).not.toBeNull();
      expect((await orderOf(token, order.id)).items).toHaveLength(2);
    } finally {
      await h.client.query('update menu_items set price_satang = 5000 where id = $1', [
        menu.noodles,
      ]);
    }
  });

  test('audits before and after with the reason, alerts the owner and publishes the order', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const boss = await ownerToken();
    const alerts = h.alerts.length;
    const marker = h.events.length;
    const res = await correct(boss, order.id, {
      expectedVersion: order.version,
      note: 'ไม่ใส่ผัก',
    });
    expect(res.statusCode).toBe(200);
    const audit = (await h.auditRows(order.id)).filter((a) => a.action === 'order.correct');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({ note: null, totalSatang: 5000 });
    expect(audit[0]?.after).toMatchObject({ note: 'ไม่ใส่ผัก', reason: 'แก้ไขตามที่ลูกค้าแจ้ง' });
    expect(h.alerts.slice(alerts).some((a) => a.kind === 'order.correct')).toBe(true);
    expect(h.events.slice(marker).some((e) => e.type === 'order.upserted')).toBe(true);
  });

  test('a stale version is a 409, a foreign line id is a 422, and nothing changes', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const boss = await ownerToken();
    const stale = await correct(boss, order.id, { expectedVersion: order.version + 5, note: 'x' });
    expect(stale.statusCode).toBe(409);
    const foreign = await correct(boss, order.id, {
      expectedVersion: order.version,
      items: [{ orderItemId: crypto.randomUUID(), qty: 1 }],
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().code).toBe('UNKNOWN_ORDER_ITEM');
    expect((await orderOf(token, order.id)).version).toBe(order.version);
  });

  test('a finished and paid order: a note edit leaves the payment alone', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await payCash(token, order.id);
    await finish(token, order.id);
    const now = await orderOf(token, order.id);
    const boss = await ownerToken();
    const res = await correct(boss, order.id, { expectedVersion: now.version, note: 'จดไว้' });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
      note: 'จดไว้',
    });
  });

  test('a changed total with a confirmed payment needs an explicit void or refund, then retires the payment', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const paymentId = await payCash(token, order.id);
    await finish(token, order.id);
    const now = await orderOf(token, order.id);
    const boss = await ownerToken();
    const items = [{ orderItemId: order.items[0]?.id, qty: 2 }];

    const refused = await correct(boss, order.id, { expectedVersion: now.version, items });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('PAYMENT_ACTION_REQUIRED');
    expect((await orderOf(token, order.id)).totalSatang).toBe(5000);

    const alerts = h.alerts.length;
    const res = await correct(boss, order.id, {
      expectedVersion: now.version,
      items,
      paymentAction: 'refund',
    });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      totalSatang: 10000,
      paymentStatus: 'refunded',
    });
    const [payment] = await dbRow<{ status: string; void_reason: string | null }>(
      'select status, void_reason from payments where id = $1',
      [paymentId],
    );
    expect(payment).toMatchObject({ status: 'refunded', void_reason: 'แก้ไขตามที่ลูกค้าแจ้ง' });
    expect(h.alerts.slice(alerts).some((a) => a.kind === 'payment.refunded')).toBe(true);
    const paymentAudit = (await h.auditRows(paymentId)).filter(
      (a) => a.action === 'payment.refund',
    );
    expect(paymentAudit).toHaveLength(1);
  });

  test('a changed total cancels a pending payment so the QR can never show a stale amount', async () => {
    newDay();
    const token = await cashier();
    await h.client.query("delete from settings where key = 'promptpay'");
    const order = await place(token);
    await h.client.query(
      `insert into payments (order_id, method, status, amount_satang, client_request_id)
       values ($1, 'gov_copay', 'pending', $2, gen_random_uuid())`,
      [order.id, order.totalSatang],
    );
    const boss = await ownerToken();
    const res = await correct(boss, order.id, {
      expectedVersion: order.version,
      items: [{ orderItemId: order.items[0]?.id, qty: 3 }],
    });
    expect(res.statusCode).toBe(200);
    const rows = await dbRow<{ status: string }>(
      'select status from payments where order_id = $1',
      [order.id],
    );
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
  });

  test('a voided order cannot be corrected', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const boss = await ownerToken();
    expect((await voidIt(boss, order.id)).statusCode).toBe(201);
    const now = await orderOf(token, order.id);
    const res = await correct(boss, order.id, { expectedVersion: now.version, note: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ORDER_CLOSED');
  });
});

describe('voiding an order', () => {
  test('an unpaid order in progress becomes cancelled with the reason', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const boss = await ownerToken();
    const res = await voidIt(boss, order.id);
    expect(res.statusCode).toBe(201);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      status: 'cancelled',
      cancelReason: 'ยกเลิกตามที่เจ้าของสั่ง',
    });
    expect(h.alerts.some((a) => a.kind === 'order.void' && a.severity === 'critical')).toBe(true);
  });

  test('a finished, paid order needs paymentAction; then the payment is voided in the same transaction', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const paymentId = await payCash(token, order.id);
    await finish(token, order.id);
    const boss = await ownerToken();
    const requestId = crypto.randomUUID();

    const refused = await voidIt(boss, order.id, { clientRequestId: requestId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('PAYMENT_ACTION_REQUIRED');
    expect((await orderOf(token, order.id)).status).toBe('completed');

    const res = await voidIt(boss, order.id, { clientRequestId: requestId, paymentAction: 'void' });
    expect(res.statusCode).toBe(201);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'unpaid',
    });
    const [payment] = await dbRow<{ status: string }>('select status from payments where id = $1', [
      paymentId,
    ]);
    expect(payment?.status).toBe('voided');
    const audit = (await h.auditRows(order.id)).filter((a) => a.action === 'order.void');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({ status: 'completed', paymentStatus: 'paid' });

    // The same request again answers 200 with the order; nothing is written twice.
    const marker = h.events.length;
    const again = await voidIt(boss, order.id, {
      clientRequestId: requestId,
      paymentAction: 'void',
    });
    expect(again.statusCode).toBe(200);
    expect((await h.auditRows(order.id)).filter((a) => a.action === 'order.void')).toHaveLength(1);
    expect(h.events.slice(marker)).toHaveLength(0);
    // A different request for an order that is already cancelled is refused.
    const other = await voidIt(boss, order.id, { paymentAction: 'void' });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('INVALID_TRANSITION');
  });

  test('needs a reason', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    const boss = await ownerToken();
    const res = await voidIt(boss, order.id, { reason: '  ' });
    expect(res.statusCode).toBe(400);
  });

  test('a voided order is cancelled with no confirmed payment, so the paid-only reporting rule leaves it out', async () => {
    newDay();
    const token = await cashier();
    const order = await place(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    expect((await voidIt(boss, order.id, { paymentAction: 'void' })).statusCode).toBe(201);
    const rows = await dbRow<{ n: number }>(
      `select count(*)::int n from orders o where o.id = $1 and o.status <> 'cancelled' and o.payment_status = 'paid'`,
      [order.id],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
