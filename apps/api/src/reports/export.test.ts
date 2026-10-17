/**
 * CSV exports (P6, B5): owner only through `data.export`, which needs a fresh step-up, and every
 * export writes an audit row. Thai text, the byte order mark and the formula guard are checked on
 * the real file.
 */
import { ordersRepo, paymentsRepo, schema } from '@sds/db';
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

const get = (token: string | undefined, path: string, query: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/reports/export/${path}${query}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: h.nextIp(),
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

async function paidOrder(
  date: string,
  amount: number,
  line?: { menuItemId: string; name: string },
) {
  const order = await ordersRepo.insertOrder(h.db, {
    orderNo: `S-${uid().slice(0, 6)}`,
    businessDate: date,
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: amount,
    discountSatang: 0,
    totalSatang: amount,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: uid(),
    requestHash: uid(),
    placedAt: new Date(`${date}T03:00:00Z`),
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
    amountSatang: amount,
    confirmedByStaffId: staffId,
    confirmedAt: new Date(`${date}T03:01:00Z`),
    clientRequestId: uid(),
    requestHash: uid(),
  });
  if (line) {
    await ordersRepo.insertOrderItems(h.db, order.id, [
      {
        menuItemId: line.menuItemId,
        nameThSnapshot: line.name,
        nameEnSnapshot: null,
        unitPriceSatang: amount,
        unitCostSatang: 0,
        qty: 1,
        modifiers: [],
        note: null,
        lineTotalSatang: amount,
      },
    ]);
  }
}

describe('GET /v1/reports/export/{revenue,items}.csv', () => {
  test('needs a session, the owner, and a fresh step-up', async () => {
    const manager = await h.newStaff('manager', '4821');
    const q = '?from=2043-01-01&to=2043-01-07';
    for (const path of ['revenue.csv', 'items.csv']) {
      expect((await get(undefined, path, q)).statusCode, path).toBe(401);
      const managerToken = await h.pinSession(device.token, manager.id, '4821');
      expect((await get(managerToken, path, q)).statusCode, path).toBe(403);
      // the owner without a step-up is told to step up
      const plain = await get(await h.ownerSession(await h.newOwner()), path, q);
      expect(plain.statusCode, path).toBe(403);
      expect(plain.json().error?.code ?? plain.json().code, path).toBe('STEP_UP_REQUIRED');
      expect(
        (await get(await h.steppedUpOwner(await h.newOwner()), path, q)).statusCode,
        path,
      ).toBe(200);
    }
  });

  test('revenue.csv: Thai headers, exact baht, BOM, attachment name, and an audit row', async () => {
    await paidOrder('2044-02-01', 12050);
    await paidOrder('2044-02-01', 8000);
    await paidOrder('2044-02-02', 5001);
    const owner = await h.newOwner();
    const token = await h.steppedUpOwner(owner);
    const res = await get(token, 'revenue.csv', '?from=2044-02-01&to=2044-02-07');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="revenue-2044-02-01-2044-02-07.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('﻿')).toBe(true);
    const lines = res.body.slice(1).trimEnd().split('\r\n');
    expect(lines[0]?.startsWith('วันที่ทำการ,จำนวนออเดอร์,ยอดขาย (บาท),')).toBe(true);
    expect(lines[0]?.split(',')).toHaveLength(15);
    // 2044-02-01: two orders, 200.50 baht, average 100.25, all cash, all storefront
    expect(lines[1]).toBe(
      '2044-02-01,2,200.50,100.25,0.00,200.50,0.00,0.00,0.00,0.00,200.50,0.00,0.00,0.00,0.00',
    );
    expect(lines[2]).toBe(
      '2044-02-02,1,50.01,50.01,0.00,50.01,0.00,0.00,0.00,0.00,50.01,0.00,0.00,0.00,0.00',
    );
    expect(lines[3]).toBe(
      'รวม,3,250.51,83.50,0.00,250.51,0.00,0.00,0.00,0.00,250.51,0.00,0.00,0.00,0.00',
    );
    expect(lines).toHaveLength(4);

    const audit = await h.auditRows('revenue:2044-02-01:2044-02-07');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'report.export',
      entity: 'report_export',
      actorType: 'staff',
      after: { kind: 'revenue', from: '2044-02-01', to: '2044-02-07', rows: 2 },
    });
  });

  test('items.csv: names with commas and formulas are made safe, units and baht are exact', async () => {
    const safe = await menuItem('ต้มยำ, เผ็ด');
    const evil = await menuItem('=HYPERLINK("http://x")');
    await paidOrder('2045-03-01', 6000, { menuItemId: safe, name: 'ต้มยำ, เผ็ด' });
    await paidOrder('2045-03-01', 3000, { menuItemId: evil, name: '=HYPERLINK("http://x")' });
    const token = await h.steppedUpOwner(await h.newOwner());
    const res = await get(token, 'items.csv', '?from=2045-03-01&to=2045-03-01');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="items-2045-03-01-2045-03-01.csv"',
    );
    const lines = res.body.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('เมนู,จำนวนที่ขาย,ยอดขาย (บาท),สัดส่วนจำนวน (%)');
    expect(lines[1]).toBe('"ต้มยำ, เผ็ด",1,60.00,50.00');
    expect(lines[2]).toBe('"\'=HYPERLINK(""http://x"")",1,30.00,50.00');
    expect(lines).toHaveLength(3);
    expect(await h.auditRows('items:2045-03-01:2045-03-01')).toHaveLength(1);
  });

  test('a bad range is refused before anything is written to the audit log', async () => {
    const token = await h.steppedUpOwner(await h.newOwner());
    const res = await get(token, 'revenue.csv', '?from=2046-01-05&to=2046-01-01');
    expect(res.statusCode).toBe(400);
    expect(await h.auditRows('revenue:2046-01-05:2046-01-01')).toHaveLength(0);
  });
});
