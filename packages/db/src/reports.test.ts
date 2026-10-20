import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as ordersRepo from './orders.ts';
import * as paymentsRepo from './payments.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as reportsRepo from './reports.ts';
import { menuCategories, menuItems, orders, staff } from './schema.ts';

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

interface Seed {
  businessDate: string;
  channel?: 'storefront' | 'line' | 'grab';
  status?: 'completed' | 'cancelled' | 'preparing';
  paymentStatus?: 'paid' | 'unpaid' | 'partially_paid' | 'refunded';
  totalSatang: number;
  commission?: number;
  pays?: {
    method: 'cash' | 'promptpay' | 'platform';
    status: 'confirmed' | 'voided';
    amount: number;
  }[];
}

async function seedOrder(s: Seed) {
  const order = await ordersRepo.insertOrder(db, {
    orderNo: `S-${unique().slice(0, 6)}`,
    businessDate: s.businessDate,
    channel: s.channel ?? 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: s.totalSatang,
    discountSatang: 0,
    totalSatang: s.totalSatang,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: unique(),
    requestHash: unique(),
    placedAt: new Date(`${s.businessDate}T03:00:00Z`),
    acceptedAt: null,
  });
  if (!order) throw new Error('order not created');
  await db
    .update(orders)
    .set({
      status: s.status ?? 'completed',
      paymentStatus: s.paymentStatus ?? 'paid',
      platformCommissionSatang: s.commission ?? null,
    })
    .where(eq(orders.id, order.id));
  const payments = [];
  for (const p of s.pays ?? []) {
    const row = await paymentsRepo.insertPayment(db, {
      orderId: order.id,
      method: p.method,
      status: p.status,
      amountSatang: p.amount,
      confirmedByStaffId: staffId,
      confirmedAt: new Date(`${s.businessDate}T03:01:00Z`),
      clientRequestId: unique(),
      requestHash: unique(),
    });
    if (!row) throw new Error('payment not created');
    payments.push(row);
  }
  return { order, payments };
}

describe('reports repo: listReportOrders', () => {
  test('returns paid, not-cancelled orders in the date range with their payments and refunds', async () => {
    const a = await seedOrder({
      businessDate: '2031-03-01',
      totalSatang: 10000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 10000 }],
    });
    const first = a.payments[0];
    await paymentsRepo.insertRefund(db, {
      orderId: a.order.id,
      paymentId: first?.id ?? '',
      amountSatang: 2500,
      method: 'cash',
      reason: 'wrong dish',
      refundedByStaffId: staffId,
    });
    await seedOrder({
      businessDate: '2031-03-02',
      channel: 'grab',
      totalSatang: 8000,
      commission: 1500,
      pays: [{ method: 'platform', status: 'confirmed', amount: 8000 }],
    });

    const rows = await reportsRepo.listReportOrders(db, '2031-03-01', '2031-03-02');
    expect(rows).toHaveLength(2);
    const byDate = Object.fromEntries(rows.map((r) => [r.businessDate, r]));
    expect(byDate['2031-03-01']).toMatchObject({
      id: a.order.id,
      channel: 'storefront',
      status: 'completed',
      paymentStatus: 'paid',
      totalSatang: 10000,
      platformCommissionSatang: null,
      payments: [{ id: first?.id, method: 'cash', status: 'confirmed', amountSatang: 10000 }],
      refunds: [{ paymentId: first?.id, amountSatang: 2500 }],
    });
    expect(byDate['2031-03-02']).toMatchObject({
      channel: 'grab',
      platformCommissionSatang: 1500,
      refunds: [],
    });
  });

  test('leaves out cancelled, unpaid and part-paid orders, and orders outside the range', async () => {
    const day = '2031-04-10';
    await seedOrder({ businessDate: day, status: 'cancelled', totalSatang: 100, pays: [] });
    await seedOrder({ businessDate: day, paymentStatus: 'unpaid', totalSatang: 200, pays: [] });
    await seedOrder({
      businessDate: day,
      paymentStatus: 'partially_paid',
      totalSatang: 300,
      pays: [],
    });
    await seedOrder({
      businessDate: '2031-04-09',
      totalSatang: 400,
      pays: [{ method: 'cash', status: 'confirmed', amount: 400 }],
    });
    const kept = await seedOrder({
      businessDate: day,
      totalSatang: 500,
      pays: [{ method: 'cash', status: 'confirmed', amount: 500 }],
    });
    const rows = await reportsRepo.listReportOrders(db, day, day);
    expect(rows.map((r) => r.id)).toEqual([kept.order.id]);
  });

  test('keeps voided payments on the order so the report can ignore them', async () => {
    const day = '2031-05-05';
    const { order } = await seedOrder({
      businessDate: day,
      totalSatang: 6000,
      pays: [
        { method: 'promptpay', status: 'voided', amount: 6000 },
        { method: 'cash', status: 'confirmed', amount: 6000 },
      ],
    });
    const [row] = await reportsRepo.listReportOrders(db, day, day);
    expect(row?.id).toBe(order.id);
    expect(row?.payments.map((p) => p.status).sort()).toEqual(['confirmed', 'voided']);
  });

  test('refuses a start date after the end date', async () => {
    await expect(reportsRepo.listReportOrders(db, '2031-06-02', '2031-06-01')).rejects.toThrow(
      RangeError,
    );
  });

  test('returns the lines still on the order with their snapshot name, and not removed ones', async () => {
    const day = '2031-07-07';
    const [category] = await db.insert(menuCategories).values({ nameTh: 'หมวด' }).returning();
    const [menuItem] = await db
      .insert(menuItems)
      .values({
        categoryId: category?.id ?? '',
        nameTh: 'ก๋วยเตี๋ยว',
        priceSatang: 5000,
        estCostSatang: 2000,
        channels: ['storefront'],
      })
      .returning();
    const { order } = await seedOrder({
      businessDate: day,
      totalSatang: 15000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 15000 }],
    });
    const line = {
      menuItemId: menuItem?.id ?? '',
      nameEnSnapshot: null,
      unitPriceSatang: 5000,
      unitCostSatang: 2000,
      modifiers: [],
      note: null,
    };
    const [kept, removed] = await ordersRepo.insertOrderItems(db, order.id, [
      { ...line, nameThSnapshot: 'ก๋วยเตี๋ยวต้มยำ', qty: 2, lineTotalSatang: 10000 },
      { ...line, nameThSnapshot: 'ก๋วยเตี๋ยวเนื้อ', qty: 1, lineTotalSatang: 5000 },
    ]);
    await ordersRepo.markOrderItemsRemoved(db, [removed?.id ?? ''], new Date());
    const [row] = await reportsRepo.listReportOrders(db, day, day);
    expect(row?.placedAt).toEqual(new Date(`${day}T03:00:00Z`));
    expect(row?.items).toEqual([
      {
        menuItemId: menuItem?.id,
        name: 'ก๋วยเตี๋ยวต้มยำ',
        qty: 2,
        lineTotalSatang: 10000,
        unitCostSatang: 2000,
      },
    ]);
    expect(kept?.id).toBeDefined();
  });

  test('carries the cost snapshot, and null for a line sold with no cost entered (D-32)', async () => {
    const day = '2031-07-08';
    const [category] = await db.insert(menuCategories).values({ nameTh: 'หมวด' }).returning();
    const [menuItem] = await db
      .insert(menuItems)
      .values({
        categoryId: category?.id ?? '',
        nameTh: 'ชาเย็น',
        priceSatang: 2500,
        estCostSatang: null,
        channels: ['storefront'],
      })
      .returning();
    expect(menuItem?.estCostSatang).toBeNull();
    const { order } = await seedOrder({
      businessDate: day,
      totalSatang: 5000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 5000 }],
    });
    await ordersRepo.insertOrderItems(db, order.id, [
      {
        menuItemId: menuItem?.id ?? '',
        nameThSnapshot: 'ชาเย็น',
        nameEnSnapshot: null,
        unitPriceSatang: 2500,
        unitCostSatang: null,
        qty: 2,
        modifiers: [],
        note: null,
        lineTotalSatang: 5000,
      },
    ]);
    const [row] = await reportsRepo.listReportOrders(db, day, day);
    expect(row?.items[0]?.unitCostSatang).toBeNull();
  });
});
