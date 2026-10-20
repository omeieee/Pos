/**
 * GET /v1/reports/pnl: owner only (finance.pnl), the same range rules as the other reports, voided
 * expenses left out, and figures worked out by hand to the satang. Dates are far in the future so no
 * other test's orders fall inside the range.
 */
import { ordersRepo, paymentsRepo, schema } from '@sds/db';
import { type ExpenseDto, type PnlReport, pnlReportSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
let managerId: string;
let manager: string;
let menuItemId: string;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner();
  device = await h.newDevice();
  const m = await h.newStaff('manager', '4821');
  managerId = m.id;
  manager = await h.pinSession(device.token, m.id, '4821');
  const [category] = await h.db
    .insert(schema.menuCategories)
    .values({ nameTh: 'หมวด' })
    .returning();
  const [item] = await h.db
    .insert(schema.menuItems)
    .values({
      categoryId: category?.id ?? '',
      nameTh: 'ก๋วยเตี๋ยว',
      priceSatang: 5000,
      channels: ['storefront'],
    })
    .returning();
  menuItemId = item?.id ?? '';
}, 60_000);
afterAll(async () => {
  await h.close();
});

const uid = () => crypto.randomUUID();

const call = (
  method: 'GET' | 'POST' | 'PATCH',
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
const pnl = (token: string | undefined, query: string) =>
  call('GET', `/v1/reports/pnl${query}`, token);
/** A fresh owner session each time: a TOTP code works once, so the harness clock moves on first. */
const ownerToken = async () => {
  h.clock.advanceSeconds(90);
  return h.ownerSession(owner);
};

interface Seed {
  date: string;
  channel?: 'storefront' | 'grab' | 'lineman';
  total: number;
  /** Cost snapshot per unit of the single line; leave out for "no cost entered". */
  cost?: number;
  commission?: number;
  refund?: number;
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
    placedAt: new Date(`${s.date}T03:00:00Z`),
    acceptedAt: null,
  });
  if (!order) throw new Error('order not created');
  await h.client.query(
    "update orders set status = 'completed', payment_status = 'paid', platform_commission_satang = $2 where id = $1",
    [order.id, s.commission ?? null],
  );
  await ordersRepo.insertOrderItems(h.db, order.id, [
    {
      menuItemId,
      nameThSnapshot: 'ก๋วยเตี๋ยว',
      nameEnSnapshot: null,
      unitPriceSatang: s.total,
      unitCostSatang: s.cost ?? null,
      qty: 1,
      modifiers: [],
      note: null,
      lineTotalSatang: s.total,
    },
  ]);
  const pay = await paymentsRepo.insertPayment(h.db, {
    orderId: order.id,
    method: s.channel && s.channel !== 'storefront' ? 'platform' : 'cash',
    status: 'confirmed',
    amountSatang: s.total,
    confirmedByStaffId: managerId,
    confirmedAt: new Date(`${s.date}T03:01:00Z`),
    clientRequestId: uid(),
    requestHash: uid(),
  });
  if (!pay) throw new Error('payment not created');
  if (s.refund) {
    await paymentsRepo.insertRefund(h.db, {
      orderId: order.id,
      paymentId: pay.id,
      amountSatang: s.refund,
      method: 'cash',
      reason: 'test',
      refundedByStaffId: managerId,
    });
  }
  return order.id;
}

async function expense(businessDate: string, category: string, amountSatang: number) {
  const res = await call('POST', '/v1/expenses', manager, { businessDate, category, amountSatang });
  expect(res.statusCode).toBe(201);
  return res.json() as ExpenseDto;
}

describe('GET /v1/reports/pnl access and range', () => {
  const q = '?from=2036-03-01&to=2036-03-07';

  test('owner only: no session 401, manager, cashier and kitchen 403', async () => {
    expect((await pnl(undefined, q)).statusCode).toBe(401);
    expect((await pnl(manager, q)).statusCode).toBe(403);
    for (const role of ['cashier', 'kitchen'] as const) {
      const s = await h.newStaff(role, '4821');
      expect((await pnl(await h.pinSession(device.token, s.id, '4821'), q)).statusCode).toBe(403);
    }
    const res = await pnl(await ownerToken(), q);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('refuses a missing, malformed, reversed or over-long range; 366 days is allowed', async () => {
    const token = await ownerToken();
    for (const bad of [
      '',
      '?from=2036-03-01',
      '?from=2036-3-1&to=2036-03-02',
      '?from=2036-03-05&to=2036-03-01',
      '?from=2036-01-01&to=2037-01-02',
    ]) {
      expect((await pnl(token, bad)).statusCode, bad).toBe(400);
    }
    expect((await pnl(token, '?from=2036-01-01&to=2036-12-31')).statusCode).toBe(200);
  });

  test('an empty range is zeros, complete, and parses', async () => {
    const res = await pnl(await ownerToken(), '?from=2035-06-01&to=2035-06-07');
    const body = pnlReportSchema.parse(res.json()) satisfies PnlReport;
    expect(body).toMatchObject({
      revenueSatang: 0,
      netProfitSatang: 0,
      complete: true,
      incompleteReasons: [],
      months: [],
      govCopay: { revenueSatang: 0, receivable: 'not_tracked' },
    });
  });
});

describe('GET /v1/reports/pnl figures', () => {
  const q = '?from=2036-03-25&to=2036-04-05';
  let uncostedId: string;
  let grabId: string;

  test('worked by hand: revenue, cost, commission rate not set, expenses without the voided one', async () => {
    await seed({ date: '2036-03-30', total: 10000, cost: 4000 });
    uncostedId = await seed({ date: '2036-03-30', total: 6000 });
    grabId = await seed({ date: '2036-04-02', channel: 'grab', total: 8000, cost: 2800 });
    await expense('2036-03-31', 'gas', 1500);
    const mistake = await expense('2036-04-01', 'ingredients', 99900);
    const voided = await call('POST', `/v1/expenses/${mistake.id}/void`, manager, {
      expectedVersion: mistake.version,
      reason: 'typo',
    });
    expect(voided.statusCode).toBe(200);

    const res = await pnl(await ownerToken(), q);
    expect(res.statusCode).toBe(200);
    const body = pnlReportSchema.parse(res.json());
    expect(body).toMatchObject({
      from: '2036-03-25',
      to: '2036-04-05',
      revenueSatang: 24000,
      orderCount: 3,
      costOfGoodsSatang: 6800,
      uncostedRevenueSatang: 6000,
      grossProfitSatang: 17200,
      commissionSatang: 0,
      expensesSatang: 1500,
      netProfitSatang: 15700,
      complete: false,
      incompleteReasons: ['orders_uncosted', 'commission_rate_not_set'],
      voidedExpenseCount: 1,
      foodCostBasis: 'only_one',
      platformFeesBasis: 'only_one',
      foodCostNotDeductedSatang: 0,
      platformFeesNotDeductedSatang: 0,
    });
    expect(body.missing).toEqual({
      excludedOrderIds: [],
      uncostedOrderIds: [uncostedId],
      uncostedMenuItemIds: [menuItemId],
      rateNotSetOrderIds: [grabId],
      ratesNotSet: ['grab'],
    });
    expect(body.expensesByCategory).toEqual([{ category: 'gas', totalSatang: 1500, count: 1 }]);
    expect(
      body.months.map((m) => [m.month, m.revenueSatang, m.netProfitSatang, m.complete]),
    ).toEqual([
      ['2036-03', 16000, 16000 - 4000 - 1500, false],
      ['2036-04', 8000, 8000 - 2800, false],
    ]);
  });

  test('once the Grab rate is set, the estimate is a number and only the uncosted order remains', async () => {
    h.clock.advanceSeconds(90);
    const stepped = await h.steppedUpOwner(owner);
    const set = await call('PATCH', '/v1/settings/platform-commission', stepped, {
      expectedVersion: 0,
      grabRateBp: 2500,
    });
    expect(set.statusCode).toBe(200);
    const body = pnlReportSchema.parse((await pnl(await ownerToken(), q)).json());
    expect(body).toMatchObject({
      commissionSatang: 2000,
      netProfitSatang: 13700,
      incompleteReasons: ['orders_uncosted'],
    });
    expect(body.commission).toMatchObject({ estimatedSatang: 2000, rateNotSetOrderIds: [] });
  });

  test('an order whose refunds exceed its payment is named and the answer is incomplete', async () => {
    const bad = await seed({ date: '2036-05-03', total: 5000, cost: 1000, refund: 5001 });
    await seed({ date: '2036-05-03', total: 3000, cost: 1000 });
    const body = pnlReportSchema.parse(
      (await pnl(await ownerToken(), '?from=2036-05-01&to=2036-05-07')).json(),
    );
    expect(body).toMatchObject({
      revenueSatang: 3000,
      complete: false,
      incompleteReasons: ['orders_excluded'],
    });
    expect(body.missing.excludedOrderIds).toEqual([bad]);
  });
});
