/**
 * GET /v1/reports/revenue: guarded by report.view, validated range, and totals that match a
 * synthetic week worked out by hand (03-data-model §6). Dates are far in the future so no other
 * test's orders fall inside the range.
 */
import { ordersRepo, paymentsRepo, schema } from '@sds/db';
import {
  heatmapReportSchema,
  itemsReportSchema,
  type RevenueReport,
  revenueReportSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
let managerId: string;
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
  managerId = (await h.newStaff('manager', '4821')).id;
}, 60_000);
afterAll(async () => {
  await h.close();
});

const uid = () => crypto.randomUUID();

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

const report = (token: string | undefined, query: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/reports/revenue${query}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: h.nextIp(),
  });

interface Seed {
  date: string;
  channel?: 'storefront' | 'line' | 'grab';
  status?: 'completed' | 'cancelled';
  paymentStatus?: 'paid' | 'unpaid' | 'partially_paid' | 'refunded';
  total: number;
  commission?: number;
  placedAt?: string;
  lines?: { menuItemId: string; name: string; qty: number; total: number }[];
  pays?: {
    method: 'cash' | 'promptpay' | 'gov_copay' | 'platform';
    status: 'confirmed' | 'voided';
    amount: number;
    refund?: number;
  }[];
}

async function seed(s: Seed) {
  const order = await ordersRepo.insertOrder(h.db, {
    orderNo: `S-${uid().slice(0, 6)}`,
    businessDate: s.date,
    channel: s.channel ?? 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: s.total,
    discountSatang: 0,
    totalSatang: s.total,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: uid(),
    requestHash: uid(),
    placedAt: new Date(s.placedAt ?? `${s.date}T03:00:00Z`),
    acceptedAt: null,
  });
  if (!order) throw new Error('order not created');
  await h.client.query(
    'update orders set status = $2, payment_status = $3, platform_commission_satang = $4 where id = $1',
    [order.id, s.status ?? 'completed', s.paymentStatus ?? 'paid', s.commission ?? null],
  );
  if (s.lines?.length) {
    await ordersRepo.insertOrderItems(
      h.db,
      order.id,
      s.lines.map((l) => ({
        menuItemId: l.menuItemId,
        nameThSnapshot: l.name,
        nameEnSnapshot: null,
        unitPriceSatang: Math.round(l.total / l.qty),
        unitCostSatang: 0,
        qty: l.qty,
        modifiers: [],
        note: null,
        lineTotalSatang: l.total,
      })),
    );
  }
  for (const p of s.pays ?? []) {
    const pay = await paymentsRepo.insertPayment(h.db, {
      orderId: order.id,
      method: p.method,
      status: p.status,
      amountSatang: p.amount,
      confirmedByStaffId: managerId,
      confirmedAt: new Date(`${s.date}T03:01:00Z`),
      clientRequestId: uid(),
      requestHash: uid(),
    });
    if (!pay) throw new Error('payment not created');
    if (p.refund) {
      await paymentsRepo.insertRefund(h.db, {
        orderId: order.id,
        paymentId: pay.id,
        amountSatang: p.refund,
        method: 'cash',
        reason: 'test',
        refundedByStaffId: managerId,
      });
    }
  }
}

describe('GET /v1/reports/revenue', () => {
  test('needs a session, and report.view (cashier and kitchen are refused)', async () => {
    const q = '?from=2032-01-01&to=2032-01-07';
    expect((await report(undefined, q)).statusCode).toBe(401);
    expect((await report(await as('cashier'), q)).statusCode).toBe(403);
    expect((await report(await as('kitchen'), q)).statusCode).toBe(403);
    expect((await report(await as('manager'), q)).statusCode).toBe(200);
  });

  test('refuses a missing, malformed, reversed or over-long range', async () => {
    const token = await as('manager');
    for (const q of [
      '',
      '?from=2032-01-01',
      '?from=2032-1-1&to=2032-01-02',
      '?from=2032-02-30&to=2032-03-01',
      '?from=2032-01-05&to=2032-01-01',
      '?from=2032-01-01&to=2033-01-02',
    ]) {
      expect((await report(token, q)).statusCode, q).toBe(400);
    }
    // 366 days is the longest allowed (2032 is a leap year).
    expect((await report(token, '?from=2032-01-01&to=2032-12-31')).statusCode).toBe(200);
  });

  test('totals match a synthetic week worked out by hand, to the satang', async () => {
    // 2033-02-01: cash 8,000 + LINE PromptPay 12,050 + a cash order with 2,500 refunded
    await seed({
      date: '2033-02-01',
      total: 8000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 8000 }],
    });
    await seed({
      date: '2033-02-01',
      channel: 'line',
      total: 12050,
      pays: [{ method: 'promptpay', status: 'confirmed', amount: 12050 }],
    });
    await seed({
      date: '2033-02-01',
      total: 10000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 10000, refund: 2500 }],
    });
    // ignored on 2033-02-01: cancelled, unpaid, part-paid, and a voided payment beside a paid one
    await seed({ date: '2033-02-01', status: 'cancelled', total: 999, pays: [] });
    await seed({ date: '2033-02-01', paymentStatus: 'unpaid', total: 777, pays: [] });
    await seed({ date: '2033-02-01', paymentStatus: 'partially_paid', total: 555, pays: [] });
    // 2033-02-02: Grab 10,000 (commission 3,000) and a co-pay order 10,000
    await seed({
      date: '2033-02-02',
      channel: 'grab',
      total: 10000,
      commission: 3000,
      pays: [{ method: 'platform', status: 'confirmed', amount: 10000 }],
    });
    await seed({
      date: '2033-02-02',
      total: 10000,
      pays: [
        { method: 'promptpay', status: 'voided', amount: 10000 },
        { method: 'gov_copay', status: 'confirmed', amount: 10000 },
      ],
    });
    // 2033-02-08 is outside the requested range
    await seed({
      date: '2033-02-08',
      total: 4000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 4000 }],
    });

    const res = await report(await as('manager'), '?from=2033-02-01&to=2033-02-07');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = revenueReportSchema.parse(res.json()) satisfies RevenueReport;
    expect(body.from).toBe('2033-02-01');
    expect(body.to).toBe('2033-02-07');
    expect(body.days).toEqual([
      {
        businessDate: '2033-02-01',
        revenueSatang: 8000 + 12050 + 7500,
        orderCount: 3,
        averageTicketSatang: 9183, // 27,550 / 3 = 9,183.33
        commissionSatang: 0,
        byChannel: { storefront: 15500, line: 12050 },
        byMethod: { cash: 15500, promptpay: 12050 },
      },
      {
        businessDate: '2033-02-02',
        revenueSatang: 20000,
        orderCount: 2,
        averageTicketSatang: 10000,
        commissionSatang: 3000,
        byChannel: { grab: 10000, storefront: 10000 },
        byMethod: { platform: 10000, gov_copay: 10000 },
      },
    ]);
    expect(body.totals).toEqual({ revenueSatang: 47550, orderCount: 5, commissionSatang: 3000 });
  });

  test('a range with no sales gives empty days and zero totals', async () => {
    const res = await report(await as('manager'), '?from=2034-06-01&to=2034-06-07');
    expect(res.json()).toEqual({
      from: '2034-06-01',
      to: '2034-06-07',
      days: [],
      totals: { revenueSatang: 0, orderCount: 0, commissionSatang: 0 },
    });
  });
});

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

const reportGet = (token: string, path: string, query: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/reports/${path}${query}`,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: h.nextIp(),
  });

describe('GET /v1/reports/items and /heatmap', () => {
  test('both need report.view and the same valid range', async () => {
    for (const path of ['items', 'heatmap']) {
      const q = '?from=2035-01-01&to=2035-01-07';
      expect((await reportGet(await as('cashier'), path, q)).statusCode, path).toBe(403);
      expect(
        (await reportGet(await as('manager'), path, '?from=2035-01-07&to=2035-01-01')).statusCode,
        path,
      ).toBe(400);
      expect((await reportGet(await as('manager'), path, q)).statusCode, path).toBe(200);
    }
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/reports/items?from=2035-01-01&to=2035-01-01',
    });
    expect(res.statusCode).toBe(401);
  });

  test('items: units and line totals per item over counted orders only, best seller first', async () => {
    const tom = await menuItem('ต้มยำ');
    const tea = await menuItem('ชาเย็น');
    const cashPay = (amount: number) => [
      { method: 'cash' as const, status: 'confirmed' as const, amount },
    ];
    await seed({
      date: '2036-03-02',
      total: 15000,
      lines: [
        { menuItemId: tom, name: 'ต้มยำ', qty: 2, total: 12000 },
        { menuItemId: tea, name: 'ชาเย็น', qty: 1, total: 3000 },
      ],
      pays: cashPay(15000),
    });
    await seed({
      date: '2036-03-03',
      total: 6000,
      lines: [{ menuItemId: tom, name: 'ต้มยำ', qty: 1, total: 6000 }],
      pays: cashPay(6000),
    });
    // does not count: cancelled, and unpaid
    await seed({
      date: '2036-03-03',
      status: 'cancelled',
      total: 9000,
      lines: [{ menuItemId: tea, name: 'ชาเย็น', qty: 9, total: 9000 }],
      pays: [],
    });
    await seed({
      date: '2036-03-03',
      paymentStatus: 'unpaid',
      total: 9000,
      lines: [{ menuItemId: tea, name: 'ชาเย็น', qty: 9, total: 9000 }],
      pays: [],
    });
    const res = await reportGet(await as('manager'), 'items', '?from=2036-03-01&to=2036-03-07');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = itemsReportSchema.parse(res.json());
    expect(body.items).toEqual([
      {
        menuItemId: tom,
        name: 'ต้มยำ',
        qty: 3,
        revenueSatang: 18000,
        unitShareBp: 7500,
        popular: true,
      },
      {
        menuItemId: tea,
        name: 'ชาเย็น',
        qty: 1,
        revenueSatang: 3000,
        unitShareBp: 2500,
        popular: false,
      },
    ]);
  });

  test('heatmap: Bangkok hour of placing, weekday of the business date, net revenue', async () => {
    const pay = (amount: number) => [
      { method: 'cash' as const, status: 'confirmed' as const, amount },
    ];
    // 2037-06-04 is a Thursday. 05:30Z is 12:30 in Bangkok.
    await seed({
      date: '2037-06-04',
      placedAt: '2037-06-04T05:30:00Z',
      total: 7000,
      pays: pay(7000),
    });
    await seed({
      date: '2037-06-04',
      placedAt: '2037-06-04T05:50:00Z',
      total: 10000,
      pays: [{ method: 'cash', status: 'confirmed', amount: 10000, refund: 4000 }],
    });
    // 17:30Z is 00:30 the next day in Bangkok, but the order is still Thursday's business day
    await seed({
      date: '2037-06-04',
      placedAt: '2037-06-04T17:30:00Z',
      total: 5000,
      pays: pay(5000),
    });
    const res = await reportGet(await as('manager'), 'heatmap', '?from=2037-06-01&to=2037-06-07');
    const body = heatmapReportSchema.parse(res.json());
    expect(body.cells).toEqual([
      { weekday: 4, hour: 0, orderCount: 1, revenueSatang: 5000 },
      { weekday: 4, hour: 12, orderCount: 2, revenueSatang: 13000 },
    ]);
  });
});
