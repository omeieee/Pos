/**
 * GET /v1/reports/tax and GET/PUT /v1/settings/tax-profile (P7, D-34). Owner only. The figures are
 * worked by hand in baht in the comments; the shop's year is 2569 = 2026 and the harness clock is
 * 2026-10-01 (after the ภ.ง.ด.94 window, before the end of the year).
 */
import { ordersRepo, paymentsRepo, schema } from '@sds/db';
import { en, th } from '@sds/i18n';
import { TAX_NOTE_KEYS, type TaxReport, taxReportSchema } from '@sds/shared';
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
const B = (baht: number) => baht * 100;

const call = (
  method: 'GET' | 'POST' | 'PUT',
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
const tax = (token: string | undefined, query: string) =>
  call('GET', `/v1/reports/tax${query}`, token);
const ownerToken = async () => {
  h.clock.advanceSeconds(90);
  return h.ownerSession(owner);
};
const steppedUp = async () => {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
};

async function seed(date: string, total: number, cost: number, method: 'cash' | 'promptpay') {
  const order = await ordersRepo.insertOrder(h.db, {
    orderNo: `T-${uid().slice(0, 6)}`,
    businessDate: date,
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: total,
    discountSatang: 0,
    totalSatang: total,
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
  await ordersRepo.insertOrderItems(h.db, order.id, [
    {
      menuItemId,
      nameThSnapshot: 'ก๋วยเตี๋ยว',
      nameEnSnapshot: null,
      unitPriceSatang: total,
      unitCostSatang: cost,
      qty: 1,
      modifiers: [],
      note: null,
      lineTotalSatang: total,
    },
  ]);
  await paymentsRepo.insertPayment(h.db, {
    orderId: order.id,
    method,
    status: 'confirmed',
    amountSatang: total,
    confirmedByStaffId: managerId,
    confirmedAt: new Date(`${date}T03:01:00Z`),
    clientRequestId: uid(),
    requestHash: uid(),
  });
}

async function expense(businessDate: string, category: string, amountSatang: number) {
  const res = await call('POST', '/v1/expenses', manager, { businessDate, category, amountSatang });
  expect(res.statusCode).toBe(201);
}

describe('access, validation, years without rules', () => {
  const q = '?year=2569&period=half';

  test('owner only: no session 401; manager, cashier, kitchen 403; owner 200 and never cached', async () => {
    expect((await tax(undefined, q)).statusCode).toBe(401);
    expect((await tax(manager, q)).statusCode).toBe(403);
    for (const role of ['cashier', 'kitchen'] as const) {
      const s = await h.newStaff(role, '4821');
      expect((await tax(await h.pinSession(device.token, s.id, '4821'), q)).statusCode).toBe(403);
    }
    const res = await tax(await ownerToken(), q);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('refuses a missing, Gregorian or unknown year/period with 400', async () => {
    const token = await ownerToken();
    for (const bad of [
      '',
      '?year=2569',
      '?period=half',
      '?year=2026&period=half',
      '?year=2569&period=quarter',
      '?year=abc&period=annual',
    ]) {
      expect((await tax(token, bad)).statusCode, bad).toBe(400);
    }
  });

  test('a year we have no rules for is refused, never answered with another year', async () => {
    const res = await tax(await ownerToken(), '?year=2570&period=annual');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'TAX_RULES_NOT_AVAILABLE' });
  });

  test('a year with no sales is an estimate of zero, complete, and parses', async () => {
    const body = taxReportSchema.parse((await tax(await ownerToken(), q)).json());
    expect(body).toMatchObject({
      ruleYear: 2569,
      period: 'half',
      form: 'ภ.ง.ด.94',
      range: { from: '2026-01-01', to: '2026-06-30' },
      taxPayableSatang: 0,
      pnlComplete: true,
      filing: { mustFile: false, pastDue: false },
    });
  });
});

describe('the estimate from real orders and expenses (baht, by hand)', () => {
  test('half-year Jan-Jun 2569', async () => {
    // Orders: 400,000 (cost 120,000, cash) and 200,000 (cost 60,000, PromptPay) in Jan-Jun, and
    // 100,000 (cost 30,000) in August. Expenses: rent 50,000 (Mar), ingredients 10,000 (Apr),
    // gas 5,000 (Sep), and a voided 999 that must not count.
    await seed('2026-02-10', B(400_000), B(120_000), 'cash');
    await seed('2026-05-20', B(200_000), B(60_000), 'promptpay');
    await seed('2026-08-15', B(100_000), B(30_000), 'cash');
    await expense('2026-03-01', 'rent', B(50_000));
    await expense('2026-04-01', 'ingredients', B(10_000));
    await expense('2026-09-01', 'gas', B(5_000));
    const mistake = await call('POST', '/v1/expenses', manager, {
      businessDate: '2026-03-05',
      category: 'other',
      amountSatang: 99_900,
    });
    const created = mistake.json() as { id: string; version: number };
    await call('POST', `/v1/expenses/${created.id}/void`, manager, {
      expectedVersion: created.version,
      reason: 'typo',
    });

    const res = await tax(await ownerToken(), '?year=2569&period=half');
    expect(res.statusCode).toBe(200);
    const body = taxReportSchema.parse(res.json()) satisfies TaxReport;
    // gross 600,000; actual expenses 180,000 + 0 commission + 60,000 = 240,000; net 360,000;
    // less 30,000 = 330,000; tax 7,500 + 30,000 x 10% = 10,500.
    // flat 60% = 360,000 expenses; net 240,000 - 30,000 = 210,000; 60,000 x 5% = 3,000.
    expect(body.income.assessableSatang).toBe(B(600_000));
    expect(body.methods.actual).toMatchObject({
      expenseSatang: B(240_000),
      taxableNetSatang: B(330_000),
      payableSatang: B(10_500),
    });
    expect(body.methods.flat).toMatchObject({
      expenseSatang: B(360_000),
      taxableNetSatang: B(210_000),
      payableSatang: B(3_000),
    });
    expect(body).toMatchObject({
      chosenMethod: 'actual',
      chosenBy: 'default_actual',
      cheaperMethod: 'flat',
      taxPayableSatang: B(10_500),
      halfPercent: null,
      foodCostMayBeCountedTwice: true,
      pnlComplete: true,
      incompleteReasons: [],
      filing: { mustFile: true, pastDue: true },
      watch: {
        vat: { status: 'below' },
        ePayment: { status: 'below', count: 1, totalSatang: B(200_000) },
      },
    });
    expect(body.notes).toEqual(
      expect.arrayContaining([
        'tax.note.foodCostTwice',
        'tax.note.costOfGoodsEstimated',
        'tax.note.expensesNeedRecords',
        'tax.note.filingLate',
      ]),
    );
    expect(body.sources.length).toBeGreaterThan(5);
  });

  test('annual so far: 700,000 gross, the year is not over', async () => {
    // actual: 210,000 + 65,000 = 275,000; net 425,000 - 60,000 = 365,000 -> 7,500 + 65,000 x 10% = 14,000.
    // flat: 420,000; net 280,000 - 60,000 = 220,000 -> 70,000 x 5% = 3,500.
    const body = taxReportSchema.parse(
      (await tax(await ownerToken(), '?year=2569&period=annual')).json(),
    );
    expect(body).toMatchObject({
      form: 'ภ.ง.ด.90',
      range: { from: '2026-01-01', to: '2026-12-31' },
      coversThrough: '2026-10-01',
      taxPayableSatang: B(14_000),
    });
    expect(body.methods.flat.payableSatang).toBe(B(3_500));
    expect(body.notes).toEqual(
      expect.arrayContaining(['tax.note.yearNotFinished', 'tax.note.halfYearCredit']),
    );
    expect(body.filing.pastDue).toBe(false);
  });

  test('every note and the disclaimer have a Thai and an English text', () => {
    for (const key of [...TAX_NOTE_KEYS, 'tax.disclaimer', 'tax.status.proposed']) {
      expect(th[key as keyof typeof th], key).toBeTruthy();
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
    expect(th['tax.disclaimer']).toContain('{year}');
    expect(en['tax.disclaimer']).toContain('{year}');
  });
});

describe('the tax profile', () => {
  const url = '/v1/settings/tax-profile?year=2569';
  const profile = {
    allowances: { items: [{ label: 'ประกันสุขภาพ', annualSatang: B(20_000) }] },
    methodPreference: 'flat',
  };

  test('reading: owner only, never cached; cashiers (who can read settings) cannot', async () => {
    expect((await call('GET', url, undefined)).statusCode).toBe(401);
    expect((await call('GET', url, manager)).statusCode).toBe(403);
    const s = await h.newStaff('cashier', '4821');
    expect(
      (await call('GET', url, await h.pinSession(device.token, s.id, '4821'))).statusCode,
    ).toBe(403);
    const res = await call('GET', url, await ownerToken());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      year: 2569,
      filerType: 'individual',
      allowances: { items: [] },
      methodPreference: null,
      saved: false,
    });
  });

  test('saving needs the owner with a fresh step-up; a plain owner session or a manager is refused', async () => {
    const plain = await call('PUT', url, await ownerToken(), profile);
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await call('PUT', url, manager, profile)).statusCode).toBe(403);
    expect((await call('PUT', url, undefined, profile)).statusCode).toBe(401);
  });

  test('refuses a bad year, a bad body, extra keys and a negative amount', async () => {
    const token = await steppedUp();
    expect(
      (await call('PUT', '/v1/settings/tax-profile?year=2026', token, profile)).statusCode,
    ).toBe(400);
    expect((await call('PUT', '/v1/settings/tax-profile', token, profile)).statusCode).toBe(400);
    for (const bad of [
      { ...profile, methodPreference: 'maybe' },
      { ...profile, extra: 1 },
      { allowances: { items: [{ label: 'x', annualSatang: -1 }] }, methodPreference: null },
      { allowances: { items: [{ label: 'x', annualSatang: 1.5 }] }, methodPreference: null },
      { methodPreference: null },
    ]) {
      expect((await call('PUT', url, token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  test('saved: read back, audited, and the estimate uses it', async () => {
    const put = await call('PUT', url, await steppedUp(), profile);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ year: 2569, saved: true, methodPreference: 'flat' });
    const read = await call('GET', url, await ownerToken());
    expect(read.json()).toMatchObject({ saved: true, allowances: profile.allowances });
    const audit = (await h.auditRows('2569')).filter(
      (a) => a.action === 'settings.tax_profile_update',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity).toBe('tax_profiles');

    // half-year allowance 30,000 + half of 20,000 = 40,000; flat: net 240,000 - 40,000 = 200,000
    // -> 50,000 x 5% = 2,500, and the preference makes flat the chosen method.
    const body = taxReportSchema.parse(
      (await tax(await ownerToken(), '?year=2569&period=half')).json(),
    );
    expect(body).toMatchObject({
      chosenMethod: 'flat',
      chosenBy: 'preference',
      taxPayableSatang: B(2_500),
      allowances: { personalSatang: B(30_000), totalSatang: B(40_000) },
    });
    expect(body.notes).toEqual(
      expect.arrayContaining(['tax.note.allowancesUnchecked', 'tax.note.halfYearAllowancesHalved']),
    );
  });

  test('saving again replaces the whole profile; saving the same twice is harmless', async () => {
    const empty = { allowances: { items: [] }, methodPreference: null };
    expect((await call('PUT', url, await steppedUp(), empty)).statusCode).toBe(200);
    expect((await call('PUT', url, await steppedUp(), empty)).statusCode).toBe(200);
    expect((await call('GET', url, await ownerToken())).json()).toMatchObject({
      saved: true,
      allowances: { items: [] },
      methodPreference: null,
    });
  });
});
