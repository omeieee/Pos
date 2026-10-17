/**
 * GET /v1/reports/customers: owner only (customer.report, PDPA), segments and favourites worked
 * out by hand, anonymised customers left out, and no phone or LINE id in the answer.
 */
import { ordersRepo, paymentsRepo, schema } from '@sds/db';
import { customersReportSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
let staffId: string;
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
  staffId = (await h.newStaff('manager', '4821')).id;
}, 60_000);
afterAll(async () => {
  await h.close();
});

const uid = () => crypto.randomUUID();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const get = (token: string | undefined) =>
  h.app.inject({
    method: 'GET',
    url: '/v1/reports/customers',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: h.nextIp(),
  });

async function customer(over: Partial<typeof schema.customers.$inferInsert>) {
  const [row] = await h.db.insert(schema.customers).values(over).returning();
  if (!row) throw new Error('customer not created');
  return row;
}

async function menuItem(nameTh: string): Promise<string> {
  const [category] = await h.db
    .insert(schema.menuCategories)
    .values({ nameTh: 'หมวด' })
    .returning();
  const [item] = await h.db
    .insert(schema.menuItems)
    .values({
      categoryId: category?.id ?? '',
      nameTh,
      priceSatang: 5000,
      estCostSatang: 0,
      channels: ['storefront'],
    })
    .returning();
  return item?.id ?? '';
}

async function paidOrder(customerId: string, lines: [string, number][]) {
  const order = await ordersRepo.insertOrder(h.db, {
    orderNo: `S-${uid().slice(0, 6)}`,
    businessDate: '2042-01-01',
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId,
    status: 'preparing',
    subtotalSatang: 1000,
    discountSatang: 0,
    totalSatang: 1000,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: uid(),
    requestHash: uid(),
    placedAt: ago(1),
    acceptedAt: null,
  });
  if (!order) throw new Error('order not created');
  await h.client.query(
    "update orders set status = 'completed', payment_status = 'paid' where id = $1",
    [order.id],
  );
  await paymentsRepo.insertPayment(h.db, {
    orderId: order.id,
    method: 'cash',
    status: 'confirmed',
    amountSatang: 1000,
    confirmedByStaffId: staffId,
    confirmedAt: ago(1),
    clientRequestId: uid(),
    requestHash: uid(),
  });
  await ordersRepo.insertOrderItems(
    h.db,
    order.id,
    lines.map(([menuItemId, qty]) => ({
      menuItemId,
      nameThSnapshot: 'x',
      nameEnSnapshot: null,
      unitPriceSatang: 500,
      unitCostSatang: 0,
      qty,
      modifiers: [],
      note: null,
      lineTotalSatang: 500 * qty,
    })),
  );
}

describe('GET /v1/reports/customers', () => {
  test('only the owner may read it: no session 401, cashier and manager 403', async () => {
    const owner = await h.newOwner();
    const manager = await h.newStaff('manager', '4821');
    const cashier = await h.newStaff('cashier', '4821');
    expect((await get(undefined)).statusCode).toBe(401);
    expect((await get(await h.pinSession(device.token, cashier.id, '4821'))).statusCode).toBe(403);
    expect((await get(await h.pinSession(device.token, manager.id, '4821'))).statusCode).toBe(403);
    expect((await get(await h.ownerSession(owner))).statusCode).toBe(200);
  });

  test('segments, favourites and spending, with personal data kept to what the list needs', async () => {
    const tom = await menuItem('ต้มยำ');
    const tea = await menuItem('ชาเย็น');
    const egg = await menuItem('ไข่ดาว');
    const water = await menuItem('น้ำเปล่า');

    const regular = await customer({
      fullName: 'สมชาย ใจดี',
      phone: '0812345678',
      lineUserId: 'U-secret-line-id',
      memberBuilding: 'B2',
      // the row's own counters are not what the report shows: it works from paid orders
      orderCount: 99,
      totalSpentSatang: 99999,
      firstSeenAt: ago(120),
      lastOrderAt: ago(2),
    });
    await paidOrder(regular.id, [
      [tom, 4],
      [tea, 3],
    ]);
    await paidOrder(regular.id, [
      [egg, 2],
      [water, 1],
      [tea, 1],
    ]);
    const fresh = await customer({
      nickname: 'น้องใหม่',
      firstSeenAt: ago(5),
      lastOrderAt: ago(5),
    });
    await paidOrder(fresh.id, [[tea, 1]]);
    const lapsed = await customer({
      displayName: 'LINE เก่า',
      firstSeenAt: ago(200),
      lastOrderAt: ago(61),
    });
    await paidOrder(lapsed.id, [[tom, 1]]);
    await paidOrder(lapsed.id, [[tom, 1]]);
    await paidOrder(lapsed.id, [[tom, 1]]);
    const gone = await customer({ displayName: 'Erased', anonymizedAt: new Date() });

    const token = await h.ownerSession(await h.newOwner());
    const res = await get(token);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = customersReportSchema.parse(res.json());
    const byId = Object.fromEntries(body.customers.map((c) => [c.id, c]));

    expect(byId[gone.id]).toBeUndefined();
    expect(byId[regular.id]).toMatchObject({
      name: 'สมชาย ใจดี',
      building: 'B2',
      segment: 'regular',
      // two paid orders of 10.00 each
      orderCount: 2,
      totalSpentSatang: 2000,
    });
    expect(byId[regular.id]?.favourites).toEqual([
      { menuItemId: tea, name: 'ชาเย็น', qty: 4 },
      { menuItemId: tom, name: 'ต้มยำ', qty: 4 },
      { menuItemId: egg, name: 'ไข่ดาว', qty: 2 },
    ]);
    expect(byId[fresh.id]).toMatchObject({
      name: 'น้องใหม่',
      segment: 'new',
      orderCount: 1,
      totalSpentSatang: 1000,
    });
    // three paid orders, but the last order is 61 days old: lapsed whatever the count
    expect(byId[lapsed.id]).toMatchObject({ name: 'LINE เก่า', segment: 'lapsed', orderCount: 3 });
    expect(body.summary.regular).toBeGreaterThanOrEqual(1);
    expect(body.summary.new).toBeGreaterThanOrEqual(1);
    expect(body.summary.lapsed).toBeGreaterThanOrEqual(1);
    expect(body.summary.new + body.summary.regular + body.summary.lapsed).toBe(
      body.customers.length,
    );

    // PDPA: the phone number and the LINE id never leave the server
    expect(res.body).not.toContain('0812345678');
    expect(res.body).not.toContain('U-secret-line-id');
  });
});
