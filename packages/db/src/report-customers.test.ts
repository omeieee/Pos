import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as ordersRepo from './orders.ts';
import * as paymentsRepo from './payments.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as reportsRepo from './reports.ts';
import { customers, menuCategories, menuItems, orders, staff } from './schema.ts';

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
const day = (d: string) => new Date(`${d}T05:00:00Z`);

async function newCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db.insert(customers).values(over).returning();
  if (!row) throw new Error('customer not created');
  return row;
}

async function menuItem(nameTh: string): Promise<string> {
  const [category] = await db.insert(menuCategories).values({ nameTh: 'หมวด' }).returning();
  const [item] = await db
    .insert(menuItems)
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

/** A paid (or cancelled) order of one customer, with lines `[menuItemId, qty]`. */
async function place(
  customerId: string,
  status: 'completed' | 'cancelled',
  lines: [string, number][],
) {
  const order = await ordersRepo.insertOrder(db, {
    orderNo: `S-${unique().slice(0, 6)}`,
    businessDate: '2041-01-01',
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
    clientRequestId: unique(),
    requestHash: unique(),
    placedAt: day('2041-01-01'),
    acceptedAt: null,
  });
  if (!order) throw new Error('order not created');
  await db.update(orders).set({ status, paymentStatus: 'paid' }).where(eq(orders.id, order.id));
  const payment = await paymentsRepo.insertPayment(db, {
    orderId: order.id,
    method: 'cash',
    status: 'confirmed',
    amountSatang: 1000,
    confirmedByStaffId: staffId,
    confirmedAt: day('2041-01-01'),
    clientRequestId: unique(),
    requestHash: unique(),
  });
  const items = await ordersRepo.insertOrderItems(
    db,
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
  return { items, orderId: order.id, paymentId: payment?.id ?? '' };
}

describe('reports repo: customers', () => {
  test('lists the best name and building, newest order first, leaving out anonymised customers', async () => {
    const named = await newCustomer({
      fullName: 'สมชาย ใจดี',
      nickname: 'ชาย',
      displayName: 'LINE X',
      memberBuilding: 'B2',
      lastOrderAt: day('2040-02-02'),
    });
    const line = await newCustomer({ displayName: 'LINE Only', lastOrderAt: day('2040-03-03') });
    const never = await newCustomer({ nickname: 'ไม่เคยสั่ง' });
    const gone = await newCustomer({ displayName: 'Gone', anonymizedAt: day('2040-01-01') });
    const tea = await menuItem('ชาเย็น');
    await place(named.id, 'completed', [[tea, 1]]);
    await place(named.id, 'completed', [[tea, 2]]);
    await place(named.id, 'cancelled', [[tea, 9]]);
    const ids = [named.id, line.id, never.id, gone.id];
    const mine = (await reportsRepo.listReportCustomers(db)).filter((r) => ids.includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([line.id, named.id, never.id]);
    expect(mine.find((r) => r.id === named.id)).toMatchObject({
      name: 'สมชาย ใจดี',
      building: 'B2',
      // two paid orders of 10.00; the cancelled one is not counted
      orderCount: 2,
      totalSpentSatang: 2000,
    });
    expect(mine.find((r) => r.id === line.id)?.name).toBe('LINE Only');
    expect(mine.find((r) => r.id === never.id)).toMatchObject({
      name: 'ไม่เคยสั่ง',
      lastOrderAt: null,
    });
    // PDPA: only these fields leave the database (no phone, no LINE id, no note)
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual([
      'building',
      'firstSeenAt',
      'id',
      'lastOrderAt',
      'name',
      'orderCount',
      'totalSpentSatang',
    ]);
  });

  test('sums item units per customer over paid, live lines of customers that are not anonymised', async () => {
    const tom = await menuItem('ต้มยำ');
    const tea = await menuItem('ชาเย็น');
    const a = await newCustomer({ displayName: 'A' });
    const b = await newCustomer({ displayName: 'B', anonymizedAt: new Date() });
    await place(a.id, 'completed', [
      [tom, 2],
      [tea, 1],
    ]);
    await place(a.id, 'completed', [[tom, 1]]);
    await place(a.id, 'cancelled', [[tea, 9]]);
    const lines = await place(a.id, 'completed', [
      [tom, 1],
      [tea, 5],
    ]);
    await ordersRepo.markOrderItemsRemoved(db, [lines.items[1]?.id ?? ''], new Date());
    await place(b.id, 'completed', [[tom, 7]]);

    const rows = (await reportsRepo.listCustomerItemUnits(db)).filter((r) =>
      [a.id, b.id].includes(r.customerId),
    );
    const byItem = Object.fromEntries(rows.map((r) => [r.menuItemId, r]));
    expect(rows).toHaveLength(2);
    expect(byItem[tom]).toEqual({ customerId: a.id, menuItemId: tom, name: 'ต้มยำ', qty: 4 });
    expect(byItem[tea]).toEqual({ customerId: a.id, menuItemId: tea, name: 'ชาเย็น', qty: 1 });
  });

  test('orders and spending come from paid orders, net of partial refunds, not from the counters on the row', async () => {
    const tea = await menuItem('ชาเย็น');
    const c = await newCustomer({
      displayName: 'Counters lie',
      // what the old counters would say: never trusted by the report
      orderCount: 99,
      totalSpentSatang: 99999,
    });
    const first = await place(c.id, 'completed', [[tea, 1]]);
    await place(c.id, 'completed', [[tea, 1]]);
    await place(c.id, 'cancelled', [[tea, 1]]);
    await paymentsRepo.insertRefund(db, {
      orderId: first.orderId,
      paymentId: first.paymentId,
      amountSatang: 300,
      method: 'cash',
      reason: 'test',
      refundedByStaffId: staffId,
    });
    const row = (await reportsRepo.listReportCustomers(db)).find((r) => r.id === c.id);
    expect(row).toMatchObject({ orderCount: 2, totalSpentSatang: 1700 });
  });
});
