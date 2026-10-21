import type { StaffRole } from '@sds/shared';
import {
  cashOpeningSettingsSchema,
  cashReportSchema,
  expenseCategoriesResponseSchema,
  expenseDtoSchema,
  expenseListSchema,
  platformCommissionSettingsSchema,
  pnlReportSchema,
  settingResponseSchema,
  taxProfileResponseSchema,
  taxReportSchema,
} from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMockFinance, isMockBinary } from './mock-finance.ts';

const NOW = Date.parse('2026-10-20T05:00:00Z');
interface Caller {
  role: StaffRole;
  stepUpFresh: boolean;
}
const owner: Caller = { role: 'owner', stepUpFresh: true };
const ownerNoStepUp: Caller = { role: 'owner', stepUpFresh: false };
const manager: Caller = { role: 'manager', stepUpFresh: false };
const cashier: Caller = { role: 'cashier', stepUpFresh: false };
const q = (params: Record<string, string> = {}) => new URLSearchParams(params);
const RANGE = { from: '2026-09-24', to: '2026-10-07' };

const mock = () => createMockFinance({ now: () => NOW });
type Mock = ReturnType<typeof mock>;
const call = (
  m: Mock,
  method: string,
  path: string,
  body: unknown,
  caller: Caller = owner,
  query = q(),
) => m.handle(method, path, query, body, caller);

describe('the dev mock of the expense API', () => {
  test('lists the seeded ledger of the range with the total of the rows that are not voided', () => {
    const answer = call(mock(), 'GET', '/v1/expenses', undefined, manager, q(RANGE));
    expect(answer?.status).toBe(200);
    const list = expenseListSchema.parse(answer?.body);
    expect(list.expenses.some((e) => e.voided)).toBe(true);
    // 150 + 80 + 15 + 100 + 20 + 10 baht; the voided 999 is out.
    expect(list.totalSatang).toBe(37500);
  });

  test('a range with nothing in it is an empty list', () => {
    const list = expenseListSchema.parse(
      call(
        mock(),
        'GET',
        '/v1/expenses',
        undefined,
        owner,
        q({ from: '2030-01-01', to: '2030-01-02' }),
      )?.body,
    );
    expect(list).toEqual({ expenses: [], totalSatang: 0 });
  });

  test('cashiers cannot read or write the ledger; a bad range is a validation error', () => {
    expect(call(mock(), 'GET', '/v1/expenses', undefined, cashier, q(RANGE))?.status).toBe(403);
    expect(
      call(mock(), 'POST', '/v1/expenses', { category: 'gas', amountSatang: 100 }, cashier)?.status,
    ).toBe(403);
    expect(
      call(
        mock(),
        'GET',
        '/v1/expenses',
        undefined,
        owner,
        q({ from: '2026-10-07', to: '2026-10-01' }),
      )?.status,
    ).toBe(400);
  });

  test('a create is 201, today by default, and the same key with the same content replays with 200', () => {
    const m = mock();
    const body = {
      category: 'gas',
      amountSatang: 1234,
      clientRequestId: '0192f3a0-0000-7000-8000-00000000f001',
    };
    const first = call(m, 'POST', '/v1/expenses', body);
    expect(first?.status).toBe(201);
    expect(expenseDtoSchema.parse(first?.body)).toMatchObject({
      businessDate: '2026-10-20',
      voided: false,
      version: 1,
    });
    const again = call(m, 'POST', '/v1/expenses', body);
    expect(again?.status).toBe(200);
    expect(again?.body).toEqual(first?.body);
    const other = call(m, 'POST', '/v1/expenses', { ...body, amountSatang: 9 });
    expect(other).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  test('a future date is accepted; an unknown or switched-off category is 422', () => {
    const m = mock();
    expect(
      call(m, 'POST', '/v1/expenses', {
        category: 'gas',
        amountSatang: 100,
        businessDate: '2027-02-01',
      })?.status,
    ).toBe(201);
    expect(call(m, 'POST', '/v1/expenses', { category: 'nope', amountSatang: 100 })).toMatchObject({
      status: 422,
      body: { code: 'UNKNOWN_EXPENSE_CATEGORY' },
    });
  });

  test('a correction needs the current version; a stale one is 409 with the version', () => {
    const m = mock();
    const row = expenseDtoSchema.parse(
      call(m, 'POST', '/v1/expenses', { category: 'gas', amountSatang: 100 })?.body,
    );
    const stale = call(m, 'PATCH', `/v1/expenses/${row.id}`, {
      expectedVersion: 5,
      amountSatang: 200,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { code: 'VERSION_CONFLICT', details: { currentVersion: 1 } },
    });
    const ok = call(m, 'PATCH', `/v1/expenses/${row.id}`, {
      expectedVersion: 1,
      amountSatang: 200,
    });
    expect(expenseDtoSchema.parse(ok?.body)).toMatchObject({ amountSatang: 200, version: 2 });
  });

  test('a void keeps the row, needs a reason, and cannot be done twice or corrected after', () => {
    const m = mock();
    const row = expenseDtoSchema.parse(
      call(m, 'POST', '/v1/expenses', { category: 'gas', amountSatang: 100 })?.body,
    );
    expect(
      call(m, 'POST', `/v1/expenses/${row.id}/void`, { expectedVersion: 1, reason: ' ' })?.status,
    ).toBe(400);
    const voided = call(m, 'POST', `/v1/expenses/${row.id}/void`, {
      expectedVersion: 1,
      reason: 'ผิด',
    });
    expect(expenseDtoSchema.parse(voided?.body)).toMatchObject({
      voided: true,
      voidReason: 'ผิด',
      version: 2,
    });
    expect(
      call(m, 'POST', `/v1/expenses/${row.id}/void`, { expectedVersion: 2, reason: 'อีก' }),
    ).toMatchObject({
      status: 409,
      body: { code: 'EXPENSE_VOIDED' },
    });
    expect(
      call(m, 'PATCH', `/v1/expenses/${row.id}`, { expectedVersion: 2, amountSatang: 5 }),
    ).toMatchObject({
      status: 409,
      body: { code: 'EXPENSE_VOIDED' },
    });
    expect(
      call(m, 'POST', '/v1/expenses/0192f3a0-0000-7000-8000-00000000ffff/void', {
        expectedVersion: 1,
        reason: 'x',
      })?.status,
    ).toBe(404);
  });

  test('the categories start as the nine built-in ones at version 0, are replaced whole, and a key cannot be left out', () => {
    const m = mock();
    const read = expenseCategoriesResponseSchema.parse(
      call(m, 'GET', '/v1/expenses/categories', undefined)?.body,
    );
    expect(read.version).toBe(0);
    expect(read.value.categories).toHaveLength(9);
    const extended = [
      ...read.value.categories,
      { key: 'ice', nameTh: 'น้ำแข็ง', nameEn: null, active: true },
    ];
    const saved = call(m, 'PUT', '/v1/expenses/categories', {
      expectedVersion: 0,
      categories: extended,
    });
    expect(expenseCategoriesResponseSchema.parse(saved?.body).version).toBe(1);
    expect(
      call(m, 'PUT', '/v1/expenses/categories', { expectedVersion: 0, categories: extended })
        ?.status,
    ).toBe(409);
    expect(
      call(m, 'PUT', '/v1/expenses/categories', {
        expectedVersion: 1,
        categories: extended.slice(1),
      }),
    ).toMatchObject({
      status: 422,
      body: { code: 'EXPENSE_CATEGORY_REMOVED' },
    });
    // The new key is usable at once.
    expect(call(m, 'POST', '/v1/expenses', { category: 'ice', amountSatang: 100 })?.status).toBe(
      201,
    );
  });

  test('a switched-off category is refused for a new expense', () => {
    const m = mock();
    const read = expenseCategoriesResponseSchema.parse(
      call(m, 'GET', '/v1/expenses/categories', undefined)?.body,
    );
    const off = read.value.categories.map((c) => (c.key === 'gas' ? { ...c, active: false } : c));
    call(m, 'PUT', '/v1/expenses/categories', { expectedVersion: 0, categories: off });
    expect(call(m, 'POST', '/v1/expenses', { category: 'gas', amountSatang: 100 })?.status).toBe(
      422,
    );
  });
});

describe('the dev mock of expense receipt photos', () => {
  const PNG = {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]),
    contentType: 'image/png',
  };
  const OTHER = {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1]),
    contentType: 'image/png',
  };
  const KEY = '0192f3a0-0000-7000-8000-00000000f001';
  const withVersion = (version: number) => q({ expectedVersion: String(version) });
  const attach = (
    m: Mock,
    id: string,
    version: number,
    file = PNG,
    requestId: string | null = KEY,
    caller: Caller = manager,
  ) =>
    m.handle('POST', `/v1/expenses/${id}/receipt`, withVersion(version), undefined, caller, {
      raw: file,
      ...(requestId ? { requestId } : {}),
    });
  const fresh = (m: Mock) =>
    expenseDtoSchema.parse(
      call(m, 'POST', '/v1/expenses', { category: 'gas', amountSatang: 8000 })?.body,
    );

  test('an attach bumps the version, sets hasReceipt, and the picture can be read back', () => {
    const m = mock();
    const row = fresh(m);
    expect(row.hasReceipt).toBe(false);
    const answer = attach(m, row.id, row.version);
    expect(answer?.status).toBe(201);
    const next = expenseDtoSchema.parse(answer?.body);
    expect(next).toMatchObject({ hasReceipt: true, version: row.version + 1 });
    expect(next.rev).toBeGreaterThan(row.rev);
    const read = call(m, 'GET', `/v1/expenses/${row.id}/receipt`, undefined, manager);
    expect(read?.status).toBe(200);
    expect(isMockBinary(read?.body)).toBe(true);
    expect(isMockBinary(read?.body) && Array.from(read.body.bytes)).toEqual(Array.from(PNG.bytes));
  });

  test('the same key with the same picture replays with 200; the same key with another is 409', () => {
    const m = mock();
    const row = fresh(m);
    attach(m, row.id, row.version);
    const replay = attach(m, row.id, row.version);
    expect(replay?.status).toBe(200);
    expect(expenseDtoSchema.parse(replay?.body).version).toBe(row.version + 1);
    expect(attach(m, row.id, row.version + 1, OTHER)?.status).toBe(409);
  });

  test('a stale version is 409 with the current one; WebP is 415; empty is 422; a missing key is 400', () => {
    const m = mock();
    const row = fresh(m);
    expect(attach(m, row.id, 99, PNG, '0192f3a0-0000-7000-8000-00000000f002')).toMatchObject({
      status: 409,
      body: { code: 'VERSION_CONFLICT', details: { currentVersion: row.version } },
    });
    expect(attach(m, row.id, row.version, { ...PNG, contentType: 'image/webp' })).toMatchObject({
      status: 415,
      body: { code: 'RECEIPT_TYPE_UNSUPPORTED' },
    });
    expect(
      attach(m, row.id, row.version, { bytes: new Uint8Array(), contentType: 'image/png' })?.status,
    ).toBe(422);
    expect(attach(m, row.id, row.version, PNG, null)?.status).toBe(400);
    expect(attach(m, '0192f3a0-0000-7000-8000-00000000ffff', 1)?.status).toBe(404);
  });

  test('remove needs the version, keeps the expense, and a second remove is 404', () => {
    const m = mock();
    const row = fresh(m);
    const withPhoto = expenseDtoSchema.parse(attach(m, row.id, row.version)?.body);
    const path = `/v1/expenses/${row.id}/receipt`;
    expect(m.handle('DELETE', path, withVersion(1), undefined, manager)?.status).toBe(409);
    const gone = m.handle('DELETE', path, withVersion(withPhoto.version), undefined, manager);
    expect(gone?.status).toBe(200);
    expect(expenseDtoSchema.parse(gone?.body)).toMatchObject({
      hasReceipt: false,
      version: withPhoto.version + 1,
    });
    expect(call(m, 'GET', path, undefined, manager)?.status).toBe(404);
    expect(
      m.handle('DELETE', path, withVersion(withPhoto.version + 1), undefined, manager)?.status,
    ).toBe(404);
  });

  test('a voided expense keeps its photo for viewing but refuses changes', () => {
    const m = mock();
    const row = fresh(m);
    const withPhoto = expenseDtoSchema.parse(attach(m, row.id, row.version)?.body);
    const voided = expenseDtoSchema.parse(
      call(m, 'POST', `/v1/expenses/${row.id}/void`, {
        expectedVersion: withPhoto.version,
        reason: 'ผิด',
      })?.body,
    );
    expect(call(m, 'GET', `/v1/expenses/${row.id}/receipt`, undefined, manager)?.status).toBe(200);
    expect(
      attach(m, row.id, voided.version, OTHER, '0192f3a0-0000-7000-8000-00000000f003'),
    ).toMatchObject({ status: 409, body: { code: 'EXPENSE_VOIDED' } });
  });

  test('with photo storage off every receipt call is 503 and the rest of the expense works', () => {
    const m = mock();
    const row = fresh(m);
    m.setReceiptStorage(false);
    const path = `/v1/expenses/${row.id}/receipt`;
    for (const answer of [
      attach(m, row.id, row.version),
      call(m, 'GET', path, undefined, manager),
      m.handle('DELETE', path, withVersion(row.version), undefined, manager),
    ]) {
      expect(answer).toMatchObject({ status: 503, body: { code: 'RECEIPT_STORAGE_UNAVAILABLE' } });
    }
    expect(
      call(m, 'PATCH', `/v1/expenses/${row.id}`, {
        expectedVersion: row.version,
        amountSatang: 9000,
      })?.status,
    ).toBe(200);
    m.setReceiptStorage(true);
    expect(attach(m, row.id, row.version + 1)?.status).toBe(201);
  });

  test('cashiers are refused', () => {
    const m = mock();
    const row = fresh(m);
    expect(attach(m, row.id, row.version, PNG, KEY, cashier)?.status).toBe(403);
    expect(call(m, 'GET', `/v1/expenses/${row.id}/receipt`, undefined, cashier)?.status).toBe(403);
  });
});

describe('the dev mock of profit and loss and tax', () => {
  test('the P&L is the owner’s alone and parses with the shared schema', () => {
    const m = mock();
    expect(call(m, 'GET', '/v1/reports/pnl', undefined, manager, q(RANGE))?.status).toBe(403);
    const pnl = pnlReportSchema.parse(
      call(m, 'GET', '/v1/reports/pnl', undefined, owner, q(RANGE))?.body,
    );
    expect(pnl.complete).toBe(false);
    expect(pnl.expensesSatang).toBe(37500);
    expect(pnl.netProfitSatang).toBe(
      pnl.grossProfitSatang -
        pnl.commissionSatang -
        pnl.expensesSatang +
        pnl.foodCostNotDeductedSatang +
        pnl.platformFeesNotDeductedSatang,
    );
    expect(pnl).toMatchObject({ foodCostBasis: 'cost_of_goods', platformFeesBasis: 'commission' });
  });

  test('adding and voiding an expense moves the profit; an empty range has no month rows', () => {
    const m = mock();
    const row = expenseDtoSchema.parse(
      call(m, 'POST', '/v1/expenses', {
        category: 'gas',
        amountSatang: 1000,
        businessDate: '2026-10-05',
      })?.body,
    );
    const during = pnlReportSchema.parse(
      call(m, 'GET', '/v1/reports/pnl', undefined, owner, q(RANGE))?.body,
    );
    expect(during.expensesSatang).toBe(38500);
    call(m, 'POST', `/v1/expenses/${row.id}/void`, { expectedVersion: 1, reason: 'ผิด' });
    const after = pnlReportSchema.parse(
      call(m, 'GET', '/v1/reports/pnl', undefined, owner, q(RANGE))?.body,
    );
    expect(after.expensesSatang).toBe(37500);
    expect(after.voidedExpenseCount).toBe(2);
    const oneMonth = pnlReportSchema.parse(
      call(
        m,
        'GET',
        '/v1/reports/pnl',
        undefined,
        owner,
        q({ from: '2026-10-01', to: '2026-10-07' }),
      )?.body,
    );
    expect(oneMonth.months).toEqual([]);
  });

  test('the tax estimate is the owner’s alone; only the rules year in the mock has rules', () => {
    const m = mock();
    expect(
      call(m, 'GET', '/v1/reports/tax', undefined, manager, q({ year: '2569', period: 'half' }))
        ?.status,
    ).toBe(403);
    const half = taxReportSchema.parse(
      call(m, 'GET', '/v1/reports/tax', undefined, owner, q({ year: '2569', period: 'half' }))
        ?.body,
    );
    expect(half.form).toBe('ภ.ง.ด.94');
    expect(
      call(m, 'GET', '/v1/reports/tax', undefined, owner, q({ year: '2575', period: 'annual' })),
    ).toMatchObject({
      status: 422,
      body: { code: 'TAX_RULES_NOT_AVAILABLE' },
    });
    expect(
      call(m, 'GET', '/v1/reports/tax', undefined, owner, q({ year: '2026', period: 'annual' }))
        ?.status,
    ).toBe(400);
  });
});

describe('the dev mock of the receipts-payments report and the start amount', () => {
  const OPENING = '/v1/settings/cash-opening';
  const cashQuery = (extra: Record<string, string> = {}) => q({ ...RANGE, ...extra });

  test('the report is the owner alone and parses with the shared schema; with no start amount there is no running net', () => {
    const m = mock();
    expect(call(m, 'GET', '/v1/reports/cash', undefined, manager, cashQuery())?.status).toBe(403);
    const report = cashReportSchema.parse(
      call(m, 'GET', '/v1/reports/cash', undefined, owner, cashQuery())?.body,
    );
    expect(report.openingNotSet).toBe(true);
    expect(report.days.every((d) => d.runningNetSatang === null)).toBe(true);
    // the sample fortnight: 685.00 received, 375.00 paid (the voided 999.00 is out); goods =
    // ingredients 250.00 + packaging 20.00 (both are goods by default)
    expect(report.totals).toMatchObject({
      receiptsSatang: 68500,
      paymentsSatang: 37500,
      purchasesSatang: 27000,
      otherExpensesSatang: 10500,
    });
    expect(report.reconciliation.differenceSatang).toBe(0);
  });

  test('the start amount reads as not set, changes with the owner and a fresh step-up, and gives a running net', () => {
    const m = mock();
    const read = (caller: Caller = owner) => call(m, 'GET', OPENING, undefined, caller);
    expect(read(manager)?.status).toBe(403);
    expect(settingResponseSchema(cashOpeningSettingsSchema).parse(read()?.body)).toMatchObject({
      version: 0,
      value: { amountSatang: null, asOf: null },
    });
    const body = { expectedVersion: 0, amountSatang: 50000, asOf: '2026-09-24' };
    expect(call(m, 'PATCH', OPENING, body, manager)?.status).toBe(403);
    expect(call(m, 'PATCH', OPENING, body, ownerNoStepUp)).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(call(m, 'PATCH', OPENING, { expectedVersion: 0, amountSatang: 5 }, owner)?.status).toBe(
      400,
    );
    expect(call(m, 'PATCH', OPENING, body, owner)?.status).toBe(200);
    expect(call(m, 'PATCH', OPENING, body, owner)?.status).toBe(409);
    const report = cashReportSchema.parse(
      call(m, 'GET', '/v1/reports/cash', undefined, owner, cashQuery())?.body,
    );
    expect(report.runningStartSatang).toBe(50000);
    expect(report.runningEndSatang).toBe(81000); // 500.00 + 685.00 - 375.00
    const october = cashReportSchema.parse(
      call(
        m,
        'GET',
        '/v1/reports/cash',
        undefined,
        owner,
        q({ from: '2026-10-01', to: '2026-10-07' }),
      )?.body,
    );
    expect(october.runningStartSatang).toBe(76500);
    expect(october.runningEndSatang).toBe(81000);
  });

  test('the goods column follows the category flag (unticking packaging moves it to other expenses)', () => {
    const m = mock();
    const read = expenseCategoriesResponseSchema.parse(
      call(m, 'GET', '/v1/expenses/categories', undefined)?.body,
    );
    call(m, 'PUT', '/v1/expenses/categories', {
      expectedVersion: 0,
      categories: read.value.categories.map((c) =>
        c.key === 'packaging' ? { ...c, buyingGoods: false } : c,
      ),
    });
    const report = cashReportSchema.parse(
      call(m, 'GET', '/v1/reports/cash', undefined, owner, cashQuery())?.body,
    );
    expect(report.totals).toMatchObject({ purchasesSatang: 25000, otherExpensesSatang: 12500 });
  });

  test('empty days are listed only when asked for, and a bad range is a validation error', () => {
    const m = mock();
    const sparse = cashReportSchema.parse(
      call(m, 'GET', '/v1/reports/cash', undefined, owner, cashQuery())?.body,
    );
    const all = cashReportSchema.parse(
      call(m, 'GET', '/v1/reports/cash', undefined, owner, cashQuery({ emptyDays: 'true' }))?.body,
    );
    expect(sparse.days.length).toBeLessThan(all.days.length);
    expect(all.days).toHaveLength(14);
    expect(call(m, 'GET', '/v1/reports/cash', undefined, owner, q())?.status).toBe(400);
  });
});

describe('the dev mock of the tax profile and the commission rates', () => {
  const profile = {
    allowances: { items: [{ label: 'ประกัน', annualSatang: 100000 }] },
    methodPreference: 'flat',
  };

  test('a profile reads as the default until saved, and a save needs the owner with a fresh step-up', () => {
    const m = mock();
    const query = q({ year: '2569' });
    expect(
      taxProfileResponseSchema.parse(
        call(m, 'GET', '/v1/settings/tax-profile', undefined, owner, query)?.body,
      ),
    ).toMatchObject({ saved: false });
    expect(call(m, 'GET', '/v1/settings/tax-profile', undefined, manager, query)?.status).toBe(403);
    expect(call(m, 'PUT', '/v1/settings/tax-profile', profile, manager, query)?.status).toBe(403);
    expect(call(m, 'PUT', '/v1/settings/tax-profile', profile, ownerNoStepUp, query)).toMatchObject(
      {
        status: 403,
        body: { code: 'STEP_UP_REQUIRED' },
      },
    );
    const saved = call(m, 'PUT', '/v1/settings/tax-profile', profile, owner, query);
    expect(taxProfileResponseSchema.parse(saved?.body)).toMatchObject({
      saved: true,
      methodPreference: 'flat',
    });
    expect(
      taxProfileResponseSchema.parse(
        call(m, 'GET', '/v1/settings/tax-profile', undefined, owner, query)?.body,
      ).allowances.items,
    ).toHaveLength(1);
  });

  test('the commission rates read as "not set", change with the owner’s step-up, and are checked', () => {
    const m = mock();
    const path = '/v1/settings/platform-commission';
    const schema = settingResponseSchema(platformCommissionSettingsSchema);
    expect(schema.parse(call(m, 'GET', path, undefined, owner)?.body)).toMatchObject({
      value: { grabRateBp: null, linemanRateBp: null },
      version: 0,
    });
    expect(call(m, 'GET', path, undefined, manager)?.status).toBe(403);
    expect(call(m, 'PATCH', path, { expectedVersion: 0, grabRateBp: 2500 }, manager)?.status).toBe(
      403,
    );
    expect(
      call(m, 'PATCH', path, { expectedVersion: 0, grabRateBp: 2500 }, ownerNoStepUp)?.status,
    ).toBe(403);
    expect(call(m, 'PATCH', path, { expectedVersion: 0, grabRateBp: 10001 }, owner)?.status).toBe(
      400,
    );
    const saved = schema.parse(
      call(m, 'PATCH', path, { expectedVersion: 0, grabRateBp: 2500 }, owner)?.body,
    );
    expect(saved).toMatchObject({ value: { grabRateBp: 2500, linemanRateBp: null }, version: 1 });
    expect(call(m, 'PATCH', path, { expectedVersion: 0, linemanRateBp: 2000 }, owner)?.status).toBe(
      409,
    );
  });

  test('other paths are not its business', () => {
    expect(call(mock(), 'GET', '/v1/menu', undefined)).toBeNull();
    expect(call(mock(), 'GET', '/v1/reports/revenue', undefined)).toBeNull();
  });
});
