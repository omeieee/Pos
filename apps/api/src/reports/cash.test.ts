/**
 * Receipts and payments (D-35): GET /v1/reports/cash (owner only, finance.pnl), the start-amount
 * setting (stored as `cash_opening`) (owner, step-up, audited, never on the device feed) and /v1/reports/export/cash.csv (same
 * guards as the other exports). Figures are worked out by hand to the satang, and the totals are
 * compared with /v1/reports/revenue over the same range.
 */
import { ordersRepo, paymentsRepo } from '@sds/db';
import { type CashReport, cashReportSchema, type ExpenseDto } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
let managerId: string;
let manager: string;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner();
  device = await h.newDevice();
  const m = await h.newStaff('manager', '4821');
  managerId = m.id;
  manager = await h.pinSession(device.token, m.id, '4821');
}, 60_000);
afterAll(async () => {
  await h.close();
});

const uid = () => crypto.randomUUID();
const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  token: string | undefined,
  body?: Record<string, unknown>,
) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body ? { payload: body } : {}),
    remoteAddress: h.nextIp(),
  });
const ownerToken = async () => {
  h.clock.advanceSeconds(90);
  return h.ownerSession(owner);
};
const steppedOwner = async () => {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
};
const cash = (token: string | undefined, query: string) =>
  call('GET', `/v1/reports/cash${query}`, token);
const OPENING = '/v1/settings/cash-opening';

async function seed(date: string, method: 'cash' | 'promptpay', amount: number, refund = 0) {
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
  const pay = await paymentsRepo.insertPayment(h.db, {
    orderId: order.id,
    method,
    status: 'confirmed',
    amountSatang: amount,
    confirmedByStaffId: managerId,
    confirmedAt: new Date(`${date}T03:01:00Z`),
    clientRequestId: uid(),
    requestHash: uid(),
  });
  if (!pay) throw new Error('payment not created');
  if (refund > 0) {
    await paymentsRepo.insertRefund(h.db, {
      orderId: order.id,
      paymentId: pay.id,
      amountSatang: refund,
      method: 'cash',
      reason: 'test',
      refundedByStaffId: managerId,
    });
  }
}

async function expense(businessDate: string, category: string, amountSatang: number) {
  const res = await call('POST', '/v1/expenses', manager, { businessDate, category, amountSatang });
  expect(res.statusCode).toBe(201);
  return res.json() as ExpenseDto;
}

describe('start amount setting (cash_opening)', () => {
  test('no built-in value, readable by the owner only', async () => {
    const res = await call('GET', OPENING, await ownerToken());
    expect(res.json()).toEqual({
      value: { amountSatang: null, asOf: null },
      version: 0,
      rev: 0,
      updatedAt: null,
    });
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const s = await h.newStaff(role, '4821');
      const token = await h.pinSession(device.token, s.id, '4821');
      expect((await call('GET', OPENING, token)).statusCode, role).toBe(403);
    }
    expect((await call('GET', OPENING, undefined)).statusCode).toBe(401);
  });

  test('owner only and only after a fresh step-up', async () => {
    const body = { expectedVersion: 0, amountSatang: 50000, asOf: '2037-02-20' };
    expect((await call('PATCH', OPENING, manager, body)).statusCode).toBe(403);
    const plain = await call('PATCH', OPENING, await ownerToken(), body);
    expect(plain.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  test('the amount and the date go together; bad values are 400', async () => {
    const token = await steppedOwner();
    for (const body of [
      { expectedVersion: 0, amountSatang: 50000 },
      { expectedVersion: 0, asOf: '2037-02-20' },
      { expectedVersion: 0, amountSatang: -1, asOf: '2037-02-20' },
      { expectedVersion: 0, amountSatang: 1.5, asOf: '2037-02-20' },
      { expectedVersion: 0, amountSatang: 1, asOf: '20/02/2037' },
    ]) {
      expect((await call('PATCH', OPENING, token, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
  });

  test('saved: audited, owner alerted, never on the device feed; a stale version is refused', async () => {
    const token = await steppedOwner();
    const alerts = h.alerts.length;
    const events = h.events.length;
    const res = await call('PATCH', OPENING, token, {
      expectedVersion: 0,
      amountSatang: 100000,
      asOf: '2035-01-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 1,
      value: { amountSatang: 100000, asOf: '2035-01-01' },
    });
    const audit = (await h.auditRows('cash_opening')).find(
      (a) => a.action === 'settings.cash_opening_change',
    );
    expect(audit).toMatchObject({
      actorId: owner.staffId,
      before: { amountSatang: null },
      after: { amountSatang: 100000, asOf: '2035-01-01' },
    });
    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({ kind: 'settings.cash_opening_changed', severity: 'warn' }),
    ]);
    expect(h.events.slice(events).some((e) => e.type === 'settings.updated')).toBe(false);
    const stale = await call('PATCH', OPENING, token, {
      expectedVersion: 0,
      amountSatang: 1,
      asOf: '2035-01-01',
    });
    expect(stale.statusCode).toBe(409);
  });
});

describe('GET /v1/reports/cash', () => {
  const q = '?from=2037-03-01&to=2037-03-07';

  test('owner only: no session 401; manager, cashier, kitchen 403; no-store', async () => {
    expect((await cash(undefined, q)).statusCode).toBe(401);
    expect((await cash(manager, q)).statusCode).toBe(403);
    for (const role of ['cashier', 'kitchen'] as const) {
      const s = await h.newStaff(role, '4821');
      expect((await cash(await h.pinSession(device.token, s.id, '4821'), q)).statusCode).toBe(403);
    }
    const res = await cash(await ownerToken(), q);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('refuses a missing, malformed, reversed or over-long range', async () => {
    const token = await ownerToken();
    for (const bad of [
      '',
      '?from=2037-03-01',
      '?from=2037-3-1&to=2037-03-02',
      '?from=2037-03-05&to=2037-03-01',
      '?from=2037-01-01&to=2038-01-02',
      '?from=2037-03-01&to=2037-03-02&emptyDays=maybe',
    ]) {
      expect((await cash(token, bad)).statusCode, bad).toBe(400);
    }
  });

  test('hand-computed day: cash and transfer receipts, refund, purchases, other expenses, a voided row; start amount carried from before the range', async () => {
    // before the range (carry): +40.00 cash on 25 Feb, -5.00 gas on 26 Feb  => +35.00
    await seed('2037-02-25', 'cash', 4000);
    await expense('2037-02-26', 'gas', 500);
    // in the range
    await seed('2037-03-02', 'cash', 10000);
    await seed('2037-03-02', 'promptpay', 5000);
    await seed('2037-03-03', 'cash', 8000, 2000); // 20.00 handed back: 60.00 kept
    await expense('2037-03-02', 'ingredients', 3000);
    await expense('2037-03-04', 'gas', 1000);
    const wrong = await expense('2037-03-04', 'ingredients', 99900);
    const voided = await call('POST', `/v1/expenses/${wrong.id}/void`, manager, {
      expectedVersion: wrong.version,
      reason: 'typed wrongly',
    });
    expect(voided.statusCode).toBe(200);

    const res = await cash(await ownerToken(), q);
    expect(res.statusCode).toBe(200);
    const report = cashReportSchema.parse(res.json()) as CashReport;
    // The start amount saved above is 1000.00 as of 2035-01-01: the carry window is over 366 days
    expect(report.opening).toEqual({ amountSatang: 100000, asOf: '2035-01-01' });
    expect(report.runningStartSatang).toBe(103500); // 1000.00 + 35.00 (receipts 40.00 - gas 5.00)
    expect(
      report.days.map((d) => [
        d.businessDate,
        d.cashInSatang,
        d.receiptsSatang,
        d.purchasesSatang,
        d.otherExpensesSatang,
        d.netSatang,
        d.runningNetSatang,
      ]),
    ).toEqual([
      ['2037-03-02', 10000, 15000, 3000, 0, 12000, 115500], // 1035.00 + 150.00 - 30.00 (PromptPay counts)
      ['2037-03-03', 6000, 6000, 0, 0, 6000, 121500],
      ['2037-03-04', 0, 0, 0, 1000, -1000, 120500], // the voided 999.00 is out
    ]);
    expect(report.totals).toMatchObject({
      receiptsByMethod: { cash: 16000, promptpay: 5000, gov_copay: 0, platform: 0, other: 0 },
      receiptsSatang: 21000,
      paymentsSatang: 4000,
      receiptsMinusPaymentsSatang: 17000,
    });
    expect(report.runningEndSatang).toBe(120500); // 1035.00 + 210.00 - 40.00
    expect(report.complete).toBe(true);
    expect(report.reconciliation).toEqual({ revenueReportSatang: 21000, differenceSatang: 0 });
  });

  test('the receipts equal the revenue report of the same range, day by day', async () => {
    const token = await ownerToken();
    const cashRes = (await cash(token, `${q}&emptyDays=false`)).json() as CashReport;
    const rev = await call('GET', `/v1/reports/revenue${q}`, token);
    const revenue = rev.json() as {
      days: { businessDate: string; revenueSatang: number }[];
      totals: { revenueSatang: number };
    };
    expect(cashRes.totals.receiptsSatang).toBe(revenue.totals.revenueSatang);
    for (const d of revenue.days) {
      expect(cashRes.days.find((x) => x.businessDate === d.businessDate)?.receiptsSatang).toBe(
        d.revenueSatang,
      );
    }
  });

  test('empty days are listed only when asked for, and carry the running net', async () => {
    const token = await ownerToken();
    const sparse = (await cash(token, q)).json() as CashReport;
    const full = (await cash(token, `${q}&emptyDays=true`)).json() as CashReport;
    expect(sparse.days).toHaveLength(3);
    expect(full.days.map((d) => d.businessDate)).toEqual([
      '2037-03-01',
      '2037-03-02',
      '2037-03-03',
      '2037-03-04',
      '2037-03-05',
      '2037-03-06',
      '2037-03-07',
    ]);
    expect(full.days[0]?.runningNetSatang).toBe(103500);
    expect(full.days[6]?.runningNetSatang).toBe(120500);
  });

  test('a range that starts before the start date has no running net on those days', async () => {
    const res = (
      await cash(await ownerToken(), '?from=2034-12-30&to=2035-01-02&emptyDays=true')
    ).json() as CashReport;
    expect(res.days.map((d) => d.runningNetSatang)).toEqual([null, null, 100000, 100000]);
    expect(res.runningStartSatang).toBeNull();
  });

  test('buying goods follows the per-category flag: defaults, owner-added, switched off, old lists without it', async () => {
    const r = '?from=2037-05-01&to=2037-05-01';
    const day = async () => (await cash(await ownerToken(), r)).json() as CashReport;
    const put = (body: Record<string, unknown>) =>
      call('PUT', '/v1/expenses/categories', manager, body);
    const read = async () =>
      (await call('GET', '/v1/expenses/categories', manager)).json() as {
        value: { categories: { key: string; nameTh: string; active: boolean }[] };
        version: number;
      };
    // Nothing saved yet: the defaults, ingredients and packaging are goods, gas is not.
    await h.client.query("delete from settings where key = 'expense_categories'");
    await expense('2037-05-01', 'ingredients', 1000);
    await expense('2037-05-01', 'packaging', 200);
    await expense('2037-05-01', 'gas', 30);
    let report = (await day()).totals;
    expect([report.purchasesSatang, report.otherExpensesSatang]).toEqual([1200, 30]);

    // The owner adds two categories (one goods, one not) and unticks packaging.
    const cur = await read();
    const saved = await put({
      expectedVersion: cur.version,
      categories: [
        ...cur.value.categories.map((c) =>
          c.key === 'packaging' ? { ...c, buyingGoods: false } : c,
        ),
        { key: 'lunch_boxes', nameTh: 'กล่องข้าว', buyingGoods: true },
        { key: 'verify_fees', nameTh: 'ค่าตรวจสลิป', buyingGoods: false },
      ],
    });
    expect(saved.statusCode).toBe(200);
    await expense('2037-05-01', 'lunch_boxes', 400);
    await expense('2037-05-01', 'verify_fees', 5);
    report = (await day()).totals;
    // goods: ingredients 10.00 + lunch_boxes 4.00; other: gas 0.30 + packaging 2.00 + verify 0.05
    expect([report.purchasesSatang, report.otherExpensesSatang]).toEqual([1400, 235]);

    // An older stored list without the flag falls back to the defaults for its keys.
    await h.client.query(
      `update settings set value = jsonb_build_object('categories', jsonb_build_array(
         jsonb_build_object('key','ingredients','nameTh','a','nameEn',null,'active',true),
         jsonb_build_object('key','packaging','nameTh','b','nameEn',null,'active',true),
         jsonb_build_object('key','gas','nameTh','c','nameEn',null,'active',true),
         jsonb_build_object('key','lunch_boxes','nameTh','d','nameEn',null,'active',true),
         jsonb_build_object('key','verify_fees','nameTh','e','nameEn',null,'active',true)))
       where key = 'expense_categories'`,
    );
    report = (await day()).totals;
    // goods: ingredients 10.00 + packaging 2.00; other: gas 0.30 + lunch_boxes 4.00 + verify 0.05
    expect([report.purchasesSatang, report.otherExpensesSatang]).toEqual([1200, 435]);
    await h.client.query("delete from settings where key = 'expense_categories'");
  });

  test('opening not set: no running net, flagged, never 0', async () => {
    await h.client.query("delete from settings where key = 'cash_opening'");
    const res = (await cash(await ownerToken(), q)).json() as CashReport;
    expect(res.openingNotSet).toBe(true);
    expect(res.opening).toBeNull();
    expect(res.runningStartSatang).toBeNull();
    expect(res.runningEndSatang).toBeNull();
    expect(res.days.every((d) => d.runningNetSatang === null)).toBe(true);
    // the receipts still tie out
    expect(res.reconciliation.differenceSatang).toBe(0);
  });
});

describe('GET /v1/reports/export/cash.csv', () => {
  const q = '?from=2037-03-01&to=2037-03-07';
  const get = (token: string | undefined, query: string) =>
    call('GET', `/v1/reports/export/cash.csv${query}`, token);

  test('needs a session, the owner and a fresh step-up', async () => {
    expect((await get(undefined, q)).statusCode).toBe(401);
    expect((await get(manager, q)).statusCode).toBe(403);
    const plain = await get(await ownerToken(), q);
    expect(plain.statusCode).toBe(403);
    expect(plain.json().error?.code ?? plain.json().code).toBe('STEP_UP_REQUIRED');
  });

  test('Thai headers, exact baht, BOM, attachment name and an audit row without figures', async () => {
    await call('PATCH', OPENING, await steppedOwner(), {
      expectedVersion: (await call('GET', OPENING, await ownerToken())).json().version,
      amountSatang: 100000,
      asOf: '2037-03-01',
    });
    const res = await get(await steppedOwner(), q);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="cash-2037-03-01-2037-03-07.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]?.startsWith('﻿')).toBe(true);
    expect(lines[0]).toContain('วันที่');
    expect(lines[1]).toBe('2037-03-02,100.00,50.00,0.00,0.00,0.00,150.00,30.00,0.00,30.00,1120.00');
    expect(lines[lines.length - 2]).toBe(
      'รวม,160.00,50.00,0.00,0.00,0.00,210.00,30.00,10.00,40.00,',
    );
    const audit = (await h.auditRows('cash:2037-03-01:2037-03-07')).find(
      (a) => a.action === 'report.export',
    );
    expect(audit?.after).toMatchObject({
      kind: 'cash',
      from: '2037-03-01',
      to: '2037-03-07',
      rows: 3,
    });
    expect(JSON.stringify(audit?.after)).not.toContain('1070');
  });
});

describe('start date limits and set-aside orders in the carry', () => {
  // The harness clock starts on 2026-10-01 (business date), so 10 years back is 2016-10-01.
  const cleanUp = () => h.client.query("delete from settings where key = 'cash_opening'");
  const setOpening = async (asOf: string) =>
    call('PATCH', OPENING, await steppedOwner(), { expectedVersion: 0, amountSatang: 1000, asOf });

  test('a start date more than 10 years back is refused with 422 CASH_OPENING_TOO_OLD; exactly 10 years is fine', async () => {
    await cleanUp();
    for (const asOf of ['0001-01-01', '1999-12-31', '2016-09-30']) {
      const res = await setOpening(asOf);
      expect(res.statusCode, asOf).toBe(422);
      expect(res.json().code, asOf).toBe('CASH_OPENING_TOO_OLD');
    }
    expect(
      (await h.auditRows('cash_opening')).filter(
        (a) => a.after && JSON.stringify(a.after).includes('0001'),
      ),
    ).toEqual([]);
    const ok = await setOpening('2016-10-01');
    expect(ok.statusCode).toBe(200);
    await cleanUp();
  });

  test('clearing the start amount is still allowed', async () => {
    await cleanUp();
    expect((await setOpening('2030-01-01')).statusCode).toBe(200);
    const cleared = await call('PATCH', OPENING, await steppedOwner(), {
      expectedVersion: 1,
      amountSatang: null,
      asOf: null,
    });
    expect(cleared.statusCode).toBe(200);
    await cleanUp();
  });

  test('a stored start date that is far too old (saved before the limit) is answered with 422, never a hang', async () => {
    await cleanUp();
    await h.client.query(
      `insert into settings (key, value) values ('cash_opening', '{"amountSatang":1000,"asOf":"0001-01-01"}'::jsonb)`,
    );
    const res = await cash(await ownerToken(), '?from=2037-03-01&to=2037-03-07');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('CASH_OPENING_TOO_OLD');
    await cleanUp();
  });

  test('an order whose refunds exceed its payment is set aside in the carry window and named, once, with ids from outside the range', async () => {
    await cleanUp();
    expect((await setOpening('2036-12-01')).statusCode).toBe(200);
    // carry window (before the range): one good order and one inconsistent (refund 90.00 on 50.00)
    await seed('2037-01-10', 'cash', 5000);
    await seed('2037-01-11', 'cash', 5000, 9000);
    // inside the range: another inconsistent one
    await seed('2037-06-02', 'cash', 3000, 7000);
    await seed('2037-06-02', 'cash', 2000);
    const outside = (await h.client.query(
      "select id from orders where business_date = '2037-01-11'",
    )) as { rows: { id: string }[] };
    const inside = (await h.client.query(
      "select o.id from orders o where o.business_date = '2037-06-02' and o.total_satang = 3000",
    )) as { rows: { id: string }[] };
    const report = (
      await cash(await ownerToken(), '?from=2037-06-01&to=2037-06-07')
    ).json() as CashReport;
    expect(report.complete).toBe(false);
    expect(new Set(report.excludedOrderIds).size).toBe(report.excludedOrderIds.length);
    expect([...report.excludedOrderIds].sort()).toEqual(
      [outside.rows[0]?.id, inside.rows[0]?.id].sort(),
    );
    // the inconsistent orders add nothing to the figures; the good ones do
    expect(report.totals.receiptsSatang).toBe(2000);
    await cleanUp();
  });
});
