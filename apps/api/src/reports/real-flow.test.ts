/**
 * The reports against the REAL payment and order flow, with no state written by hand: orders are
 * placed, paid, corrected (a partial refund) and voided through the same routes the till uses, and
 * only then is /v1/reports read. This proves the report's assumptions (a partial refund leaves the
 * payment confirmed and the order paid, a void takes the order out) against the state machine.
 */
import { type OrderDto, orderDtoSchema, type RevenueReport } from '@sds/shared';
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
let managerId: string;

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  owner = await h.newOwner();
  device = await h.newDevice();
  cashierId = (await h.newStaff('cashier', '4821')).id;
  managerId = (await h.newStaff('manager', '4821')).id;
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Each test works on its own day, far in the future, so the reports see only its orders. */
let dayNo = 0;
function newDay(): string {
  dayNo += 1;
  const date = new Date(Date.UTC(2047, 2, dayNo, 3, 0, 0));
  h.clock.set(date.toISOString());
  return date.toISOString().slice(0, 10);
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, body?: unknown) =>
  h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
const as = (id: string) => h.pinSession(device.token, id, '4821');
async function ownerToken() {
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
async function payCash(token: string, orderId: string) {
  const res = await call('POST', `/v1/orders/${orderId}/payments`, token, {
    clientRequestId: crypto.randomUUID(),
    method: 'cash',
    tendered: 20000,
  });
  if (res.statusCode !== 201) throw new Error(`pay failed: ${res.statusCode} ${res.body}`);
}
const orderOf = async (token: string, id: string) =>
  orderDtoSchema.parse((await call('GET', `/v1/orders/${id}`, token)).json());

async function revenue(date: string) {
  const res = await call('GET', `/v1/reports/revenue?from=${date}&to=${date}`, await as(managerId));
  expect(res.statusCode).toBe(200);
  return res.json() as RevenueReport;
}

describe('revenue after the real payment flow', () => {
  test('a paid order counts its full amount', async () => {
    const date = newDay();
    const token = await as(cashierId);
    const order = await place(token);
    await payCash(token, order.id);
    const report = await revenue(date);
    expect(report.totals).toEqual({ revenueSatang: 7000, orderCount: 1, commissionSatang: 0 });
    expect(report.days[0]).toMatchObject({
      byMethod: { cash: 7000 },
      byChannel: { storefront: 7000 },
    });
  });

  test('a placed order that is not paid yet counts nothing', async () => {
    const date = newDay();
    await place(await as(cashierId));
    expect((await revenue(date)).totals).toEqual({
      revenueSatang: 0,
      orderCount: 0,
      commissionSatang: 0,
    });
  });

  test('the owner lowers a paid order and hands 10.00 back: revenue is the new total, on the original day', async () => {
    const date = newDay();
    const token = await as(cashierId);
    const order = await place(token);
    await payCash(token, order.id);
    const boss = await ownerToken();
    const water = order.items.find((i) => i.menuItemId === menu.water);
    const noodles = order.items.find((i) => i.menuItemId === menu.noodles);
    const res = await call('PATCH', `/v1/orders/${order.id}/correction`, boss, {
      reason: 'แก้ไขตามที่ลูกค้าแจ้ง',
      expectedVersion: (await orderOf(token, order.id)).version,
      items: [
        { orderItemId: noodles?.id, qty: 1 },
        { orderItemId: water?.id, qty: 1 },
      ],
      paymentAction: 'adjust',
      refund: { method: 'cash' },
    });
    expect(res.statusCode).toBe(200);
    // the day moves on before anyone looks: the refund still belongs to the original day
    newDayAfter(date);
    const report = await revenue(date);
    expect(report.totals).toEqual({ revenueSatang: 6000, orderCount: 1, commissionSatang: 0 });
    expect(report.days[0]?.byMethod).toEqual({ cash: 6000 });
    // and the item report follows the corrected lines: one water, not two
    const items = (
      await call('GET', `/v1/reports/items?from=${date}&to=${date}`, await as(managerId))
    ).json() as { items: { menuItemId: string; qty: number; revenueSatang: number }[] };
    const waterRow = items.items.find((i) => i.menuItemId === menu.water);
    expect(waterRow).toMatchObject({ qty: 1, revenueSatang: 1000 });
  });

  test('the owner voids a paid order and refunds it: it drops out of revenue and items', async () => {
    const date = newDay();
    const token = await as(cashierId);
    const kept = await place(token);
    await payCash(token, kept.id);
    const gone = await place(token);
    await payCash(token, gone.id);
    const res = await call('POST', `/v1/orders/${gone.id}/void`, await ownerToken(), {
      clientRequestId: crypto.randomUUID(),
      reason: 'ยกเลิก',
      expectedVersion: (await orderOf(token, gone.id)).version,
      paymentAction: 'refund',
    });
    expect(res.statusCode).toBe(201);
    const report = await revenue(date);
    expect(report.totals).toEqual({ revenueSatang: 7000, orderCount: 1, commissionSatang: 0 });
    const items = (
      await call('GET', `/v1/reports/items?from=${date}&to=${date}`, await as(managerId))
    ).json() as { items: { menuItemId: string; qty: number }[] };
    expect(items.items.find((i) => i.menuItemId === menu.noodles)?.qty).toBe(1);
  });
});

/** Moves the clock two days on, so a later read happens "after midnight". */
function newDayAfter(date: string): void {
  h.clock.set(new Date(Date.parse(`${date}T03:00:00Z`) + 2 * 86_400_000).toISOString());
}
