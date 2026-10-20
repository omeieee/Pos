/**
 * A made-up expense, profit-and-loss, tax and commission API for `pnpm dev` with the mock backend
 * (reached only through mock-shop.ts and `enable.ts`, which is dev-only), shaped like apps/api so
 * the real client's schemas accept every answer:
 *
 * - `/v1/expenses` (+ `/categories`): `expense.edit` (owner, manager). Seeded with the ledger of
 *   `docs/p7-pnl-sample.md`. A create takes an idempotency key, a correction names the version,
 *   a void keeps the row, and a category can be switched off but never left out.
 * - `/v1/reports/pnl` and `/v1/reports/tax`: owner only (`finance.pnl`). NOT computed: the revenue
 *   side is the sample fortnight whatever range is asked, only the expense side follows the ledger
 *   (so adding or voiding an expense moves the profit). The tax answer is worksheet A of
 *   `docs/p7-tax-sample.md`; only rule year 2569 exists (any other year is 422), like a real shop
 *   before a rules file is added.
 * - `/v1/reports/cash`: owner only. The sample fortnight's receipts (`SAMPLE_RECEIPTS`) plus the live
 *   ledger, worked out with the same rules as `cashReport`; `/v1/settings/cash-opening` sets the
 *   start amount (owner, fresh step-up). The CSV export is not mocked (as for the P6 files).
 * - `/v1/settings/tax-profile` and `/v1/settings/platform-commission`: owner only to change, and
 *   a change needs a fresh step-up (403 STEP_UP_REQUIRED), as on the server. Neither goes on the feed.
 *
 * Nothing here is persisted and nothing here is real shop data.
 */
import {
  buyingGoodsKeys,
  type CashReport,
  cashOpeningPatchInputSchema,
  cashOpeningSettingsSchema,
  cashReportQuerySchema,
  createExpenseInputSchema,
  DEFAULT_CASH_OPENING,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_PLATFORM_COMMISSION,
  type ExpenseCategoryEntry,
  type ExpenseDto,
  expenseCategoriesSchema,
  listExpensesQuerySchema,
  missingCategoryKeys,
  PAYMENT_METHODS,
  type PaymentMethod,
  type Permission,
  type PnlReport,
  patchExpenseInputSchema,
  platformCommissionPatchInputSchema,
  platformCommissionSettingsSchema,
  putExpenseCategoriesInputSchema,
  putTaxProfileInputSchema,
  ROLE_PERMISSIONS,
  type StaffRole,
  satang,
  type TaxProfileResponse,
  taxProfileValueSchema,
  taxReportQuerySchema,
  voidExpenseInputSchema,
} from '@sds/shared';
import { SAMPLE_EXPENSES, SAMPLE_PNL, SAMPLE_RECEIPTS, sampleTax } from './mock-finance-data.ts';

interface Answer {
  status: number;
  body: unknown;
}
/** The slice of the mock caller this file needs. */
interface Caller {
  role: StaffRole;
  stepUpFresh?: boolean;
}

const error = (status: number, code: string, details: Record<string, unknown> = {}): Answer => ({
  status,
  body: { code, message: 'mock server error', details },
});
const ok = (body: unknown, status = 200): Answer => ({ status, body });

const bangkokDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
const RULE_YEAR = 2569;

export function createMockFinance(deps: { now: () => number }) {
  const rows = new Map<string, ExpenseDto>(SAMPLE_EXPENSES.map((e) => [e.id, e]));
  const createdBy = new Map<string, { hash: string; id: string }>();
  let nextRow = 8000;
  let rev = 10;

  let categories: { list: ExpenseCategoryEntry[]; version: number } = {
    list: [...DEFAULT_EXPENSE_CATEGORIES.categories],
    version: 0,
  };
  const profiles = new Map<number, TaxProfileResponse>();
  let commission = { value: DEFAULT_PLATFORM_COMMISSION, version: 0, rev: 0 };
  let opening = { value: DEFAULT_CASH_OPENING, version: 0, rev: 0 };

  const has = (caller: Caller, permission: Permission) =>
    ROLE_PERMISSIONS[caller.role].has(permission);
  const nowIso = () => new Date(deps.now()).toISOString();
  const categoryAnswer = () => ({
    value: { categories: categories.list },
    version: categories.version,
    rev: categories.version === 0 ? 0 : rev,
    updatedAt: categories.version === 0 ? null : nowIso(),
  });
  const inRange = (e: ExpenseDto, from: string, to: string) =>
    e.businessDate >= from && e.businessDate <= to;
  const ledger = (from: string, to: string) =>
    [...rows.values()]
      .filter((e) => inRange(e, from, to))
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.id.localeCompare(b.id));
  const sum = (list: readonly ExpenseDto[]) =>
    list.reduce((total, e) => (e.voided ? total : total + e.amountSatang), 0);

  // ---------- Expenses ----------

  function list(query: URLSearchParams): Answer {
    const range = listExpensesQuerySchema.safeParse(Object.fromEntries(query));
    if (!range.success) return error(400, 'VALIDATION_ERROR');
    const found = ledger(range.data.from, range.data.to);
    return ok({ expenses: found, totalSatang: satang(sum(found)) });
  }

  function create(body: unknown): Answer {
    const input = createExpenseInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const { clientRequestId, ...content } = input.data;
    const hash = JSON.stringify(content);
    const seen = clientRequestId ? createdBy.get(clientRequestId) : undefined;
    if (seen) {
      return seen.hash === hash ? ok(rows.get(seen.id), 200) : error(409, 'IDEMPOTENCY_KEY_REUSED');
    }
    if (!categories.list.some((c) => c.key === input.data.category && c.active)) {
      return error(422, 'UNKNOWN_EXPENSE_CATEGORY');
    }
    nextRow += 1;
    rev += 1;
    const row: ExpenseDto = {
      id: `0192f3a0-0000-7000-8000-${String(nextRow).padStart(12, '0')}`,
      businessDate: input.data.businessDate ?? bangkokDate.format(deps.now()),
      category: input.data.category,
      amountSatang: input.data.amountSatang,
      vendor: input.data.vendor ?? null,
      note: input.data.note ?? null,
      receiptImageKey: null,
      createdByStaffId: null,
      voided: false,
      voidedAt: null,
      voidReason: null,
      version: 1,
      rev,
    };
    rows.set(row.id, row);
    if (clientRequestId) createdBy.set(clientRequestId, { hash, id: row.id });
    return ok(row, 201);
  }

  /** The row a PATCH or void names, after the version and "already voided" checks the server makes. */
  function target(id: string, expectedVersion: number): ExpenseDto | Answer {
    const row = rows.get(id);
    if (!row) return error(404, 'NOT_FOUND');
    if (row.version !== expectedVersion) {
      return error(409, 'VERSION_CONFLICT', { currentVersion: row.version });
    }
    if (row.voided) return error(409, 'EXPENSE_VOIDED');
    return row;
  }
  const isAnswer = (value: ExpenseDto | Answer): value is Answer => 'body' in value;

  function patch(id: string, body: unknown): Answer {
    const input = patchExpenseInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const row = target(id, input.data.expectedVersion);
    if (isAnswer(row)) return row;
    const { expectedVersion: _version, ...fields } = input.data;
    if (
      fields.category !== undefined &&
      !categories.list.some((c) => c.key === fields.category && c.active)
    ) {
      return error(422, 'UNKNOWN_EXPENSE_CATEGORY');
    }
    rev += 1;
    const next: ExpenseDto = {
      ...row,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      version: row.version + 1,
      rev,
    };
    rows.set(id, next);
    return ok(next);
  }

  function voidRow(id: string, body: unknown): Answer {
    const input = voidExpenseInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const row = target(id, input.data.expectedVersion);
    if (isAnswer(row)) return row;
    rev += 1;
    const next: ExpenseDto = {
      ...row,
      voided: true,
      voidedAt: nowIso(),
      voidReason: input.data.reason,
      version: row.version + 1,
      rev,
    };
    rows.set(id, next);
    return ok(next);
  }

  function putCategories(body: unknown): Answer {
    const input = putExpenseCategoriesInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    if (input.data.expectedVersion !== categories.version) {
      return error(409, 'VERSION_CONFLICT', { currentVersion: categories.version });
    }
    const next = expenseCategoriesSchema.parse({ categories: input.data.categories });
    const removed = missingCategoryKeys(categories.list, next.categories);
    if (removed.length > 0) return error(422, 'EXPENSE_CATEGORY_REMOVED', { keys: removed });
    rev += 1;
    categories = { list: next.categories, version: categories.version + 1 };
    return ok(categoryAnswer());
  }

  // ---------- Reports ----------

  function pnl(query: URLSearchParams): Answer {
    const range = listExpensesQuerySchema.safeParse(Object.fromEntries(query));
    if (!range.success) return error(400, 'VALIDATION_ERROR');
    const { from, to } = range.data;
    const found = ledger(from, to);
    const kept = found.filter((e) => !e.voided);
    const byCategory = new Map<string, { totalSatang: number; count: number }>();
    for (const e of kept) {
      const so = byCategory.get(e.category) ?? { totalSatang: 0, count: 0 };
      byCategory.set(e.category, {
        totalSatang: so.totalSatang + e.amountSatang,
        count: so.count + 1,
      });
    }
    const expensesSatang = sum(found);
    // Same rule as @sds/finance `overlap.ts` (not imported: this mock only needs the shape). Tie: first side.
    const inLedger = (key: string) => sum(kept.filter((e) => e.category === key));
    const ingredients = inLedger('ingredients');
    const feesExpense = inLedger('platform_fees');
    const cog = SAMPLE_PNL.costOfGoodsSatang;
    const commission = SAMPLE_PNL.commissionSatang;
    const foodBoth = cog > 0 && ingredients > 0;
    const feesBoth = commission > 0 && feesExpense > 0;
    const foodLeft = foodBoth ? Math.min(cog, ingredients) : 0;
    const feesLeft = feesBoth ? Math.min(commission, feesExpense) : 0;
    const months = from.slice(0, 7) === to.slice(0, 7) ? [] : SAMPLE_PNL.months;
    const answer: PnlReport = {
      ...SAMPLE_PNL,
      from,
      to,
      expensesSatang: satang(expensesSatang),
      foodCostNotDeductedSatang: satang(foodLeft),
      platformFeesNotDeductedSatang: satang(feesLeft),
      netProfitSatang: satang(
        SAMPLE_PNL.grossProfitSatang - commission - expensesSatang + foodLeft + feesLeft,
      ),
      expensesByCategory: [...byCategory.entries()]
        .map(([category, v]) => ({ category, totalSatang: satang(v.totalSatang), count: v.count }))
        .sort((a, b) => b.totalSatang - a.totalSatang || a.category.localeCompare(b.category)),
      voidedExpenseCount: found.length - kept.length,
      foodCostBasis: !foodBoth
        ? 'only_one'
        : cog >= ingredients
          ? 'cost_of_goods'
          : 'ingredients_expenses',
      ingredientsExpensesSatang: satang(ingredients),
      platformFeesBasis: !feesBoth
        ? 'only_one'
        : commission >= feesExpense
          ? 'commission'
          : 'platform_fees_expenses',
      platformFeesExpensesSatang: satang(feesExpense),
      months: months.map((m) => {
        const monthExpenses = sum(found.filter((e) => e.businessDate.startsWith(m.month)));
        return {
          ...m,
          expensesSatang: satang(monthExpenses),
          // The month rows of the mock keep the sample's own overlap figures (not recomputed).
          netProfitSatang: satang(
            m.grossProfitSatang -
              m.commissionSatang -
              monthExpenses +
              m.foodCostNotDeductedSatang +
              m.platformFeesNotDeductedSatang,
          ),
        };
      }),
    };
    return ok(answer);
  }

  function tax(query: URLSearchParams): Answer {
    const parsed = taxReportQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) return error(400, 'VALIDATION_ERROR');
    if (parsed.data.year !== RULE_YEAR) {
      return error(422, 'TAX_RULES_NOT_AVAILABLE', { year: parsed.data.year });
    }
    return ok(sampleTax(parsed.data.period, parsed.data.year));
  }

  /** Same rules as `@sds/finance` `cashReport`, on the sample receipts and the live ledger (dev only). */
  function cash(query: URLSearchParams): Answer {
    const parsed = cashReportQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) return error(400, 'VALIDATION_ERROR');
    const { from, to } = parsed.data;
    interface Figures {
      methods: Record<PaymentMethod, number>;
      purchases: number;
      other: number;
      orders: number;
      expenses: number;
    }
    const blank = (): Figures => ({
      methods: { cash: 0, promptpay: 0, gov_copay: 0, platform: 0, other: 0 },
      purchases: 0,
      other: 0,
      orders: 0,
      expenses: 0,
    });
    const goods = new Set(buyingGoodsKeys(categories.list));
    const byDate = new Map<string, Figures>();
    const at = (date: string) => {
      const found = byDate.get(date) ?? blank();
      byDate.set(date, found);
      return found;
    };
    for (const r of SAMPLE_RECEIPTS) {
      const f = at(r.date);
      f.methods[r.method] += r.satang;
      f.orders += 1;
    }
    for (const e of rows.values()) {
      if (e.voided) continue;
      const f = at(e.businessDate);
      f.expenses += 1;
      if (goods.has(e.category)) f.purchases += e.amountSatang;
      else f.other += e.amountSatang;
    }
    const receipts = (f: Figures) => PAYMENT_METHODS.reduce((n, m) => n + f.methods[m], 0);
    const brandedMethods = (f: Figures) =>
      Object.fromEntries(
        PAYMENT_METHODS.map((m) => [m, satang(f.methods[m])]),
      ) as CashReport['totals']['receiptsByMethod'];
    const figures = (f: Figures) => ({
      receiptsByMethod: brandedMethods(f),
      receiptsSatang: satang(receipts(f)),
      cashInSatang: satang(f.methods.cash),
      purchasesSatang: satang(f.purchases),
      otherExpensesSatang: satang(f.other),
      paymentsSatang: satang(f.purchases + f.other),
    });
    const net = (f: Figures) => receipts(f) - f.purchases - f.other;

    const { asOf, amountSatang: base } = opening.value;
    const isSet = asOf !== null && base !== null;
    // The net from the start day up to the day before `from` is the carry.
    let carry = 0;
    if (isSet) for (const [date, f] of byDate) if (date >= asOf && date < from) carry += net(f);
    const runningStart = isSet && asOf <= from ? base + carry : null;

    const dates: string[] = [];
    if (parsed.data.emptyDays === 'true') {
      for (
        let d = Date.parse(`${from}T00:00:00Z`);
        d <= Date.parse(`${to}T00:00:00Z`);
        d += 86_400_000
      ) {
        dates.push(new Date(d).toISOString().slice(0, 10));
      }
    } else {
      for (const date of [...byDate.keys()].sort())
        if (date >= from && date <= to) dates.push(date);
    }
    let running: number | null = null;
    const days = dates.map((businessDate) => {
      const f = byDate.get(businessDate) ?? blank();
      let runningNet: number | null = null;
      if (isSet && businessDate >= asOf) {
        running ??= runningStart ?? base;
        running += net(f);
        runningNet = running;
      }
      return {
        businessDate,
        ...figures(f),
        orderCount: f.orders,
        expenseCount: f.expenses,
        netSatang: satang(net(f)),
        runningNetSatang: runningNet === null ? null : satang(runningNet),
      };
    });

    const inRange = [...byDate].filter(([date]) => date >= from && date <= to);
    const sumOf = (list: readonly (readonly [string, Figures])[]) => {
      const total = blank();
      for (const [, f] of list) {
        for (const m of PAYMENT_METHODS) total.methods[m] += f.methods[m];
        total.purchases += f.purchases;
        total.other += f.other;
        total.orders += f.orders;
        total.expenses += f.expenses;
      }
      return total;
    };
    const total = sumOf(inRange);
    const months =
      from.slice(0, 7) === to.slice(0, 7)
        ? []
        : [...new Set(inRange.map(([date]) => date.slice(0, 7)))].sort().map((month) => ({
            month,
            ...figures(sumOf(inRange.filter(([date]) => date.startsWith(month)))),
          }));
    const answer: CashReport = {
      from,
      to,
      opening: isSet ? { amountSatang: satang(base), asOf } : null,
      openingNotSet: !isSet,
      runningStartSatang: runningStart === null ? null : satang(runningStart),
      runningEndSatang: isSet && asOf <= to ? satang(running ?? runningStart ?? base) : null,
      days,
      totals: {
        ...figures(total),
        orderCount: total.orders,
        expenseCount: total.expenses,
        receiptsMinusPaymentsSatang: satang(receipts(total) - total.purchases - total.other),
      },
      months,
      excludedOrderIds: [],
      complete: true,
      reconciliation: { revenueReportSatang: satang(receipts(total)), differenceSatang: satang(0) },
    };
    return ok(answer);
  }

  // ---------- Settings ----------

  function taxProfile(method: string, query: URLSearchParams, body: unknown, caller: Caller) {
    const year = taxReportQuerySchema.pick({ year: true }).safeParse(Object.fromEntries(query));
    if (method === 'GET') {
      if (!has(caller, 'finance.pnl')) return error(403, 'FORBIDDEN');
      if (!year.success) return error(400, 'VALIDATION_ERROR');
      return ok(
        profiles.get(year.data.year) ?? {
          year: year.data.year,
          filerType: 'individual',
          allowances: { items: [] },
          methodPreference: null,
          saved: false,
        },
      );
    }
    if (!has(caller, 'settings.tax_profile')) return error(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return error(403, 'STEP_UP_REQUIRED');
    if (!year.success) return error(400, 'VALIDATION_ERROR');
    const input = putTaxProfileInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const saved: TaxProfileResponse = {
      year: year.data.year,
      filerType: 'individual',
      ...taxProfileValueSchema.parse(input.data),
      saved: true,
    };
    profiles.set(year.data.year, saved);
    return ok(saved);
  }

  function platformCommission(method: string, body: unknown, caller: Caller): Answer {
    const answer = () => ({
      value: commission.value,
      version: commission.version,
      rev: commission.rev,
      updatedAt: commission.version === 0 ? null : nowIso(),
    });
    if (method === 'GET') {
      // Owner only (D-31 amendment): the rates are not for managers or cashiers.
      return has(caller, 'finance.pnl') ? ok(answer()) : error(403, 'FORBIDDEN');
    }
    if (!has(caller, 'settings.platform_commission')) return error(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return error(403, 'STEP_UP_REQUIRED');
    const input = platformCommissionPatchInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    if (input.data.expectedVersion !== commission.version) {
      return error(409, 'VERSION_CONFLICT', { currentVersion: commission.version });
    }
    const { expectedVersion: _version, ...given } = input.data;
    rev += 1;
    commission = {
      value: platformCommissionSettingsSchema.parse({
        ...commission.value,
        ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
      }),
      version: commission.version + 1,
      rev,
    };
    return ok(answer());
  }

  function cashOpening(method: string, body: unknown, caller: Caller): Answer {
    const answer = () => ({
      value: opening.value,
      version: opening.version,
      rev: opening.rev,
      updatedAt: opening.version === 0 ? null : nowIso(),
    });
    if (method === 'GET') {
      return has(caller, 'finance.pnl') ? ok(answer()) : error(403, 'FORBIDDEN');
    }
    if (!has(caller, 'settings.cash_opening')) return error(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return error(403, 'STEP_UP_REQUIRED');
    const input = cashOpeningPatchInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    if (input.data.expectedVersion !== opening.version) {
      return error(409, 'VERSION_CONFLICT', { currentVersion: opening.version });
    }
    const { expectedVersion: _version, ...given } = input.data;
    const next = cashOpeningSettingsSchema.safeParse({
      ...opening.value,
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
    });
    if (!next.success) return error(400, 'VALIDATION_ERROR');
    rev += 1;
    opening = { value: next.data, version: opening.version + 1, rev };
    return ok(answer());
  }

  /** Answers the routes of this file, or null for any other path. */
  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    caller: Caller,
  ): Answer | null {
    if (path === '/v1/settings/tax-profile' && (method === 'GET' || method === 'PUT')) {
      return taxProfile(method, query, body, caller);
    }
    if (path === '/v1/settings/platform-commission' && (method === 'GET' || method === 'PATCH')) {
      return platformCommission(method, body, caller);
    }
    if (path === '/v1/settings/cash-opening' && (method === 'GET' || method === 'PATCH')) {
      return cashOpening(method, body, caller);
    }
    if (
      method === 'GET' &&
      (path === '/v1/reports/pnl' || path === '/v1/reports/tax' || path === '/v1/reports/cash')
    ) {
      if (!has(caller, 'finance.pnl')) return error(403, 'FORBIDDEN');
      if (path === '/v1/reports/cash') return cash(query);
      return path === '/v1/reports/pnl' ? pnl(query) : tax(query);
    }
    if (path !== '/v1/expenses' && !path.startsWith('/v1/expenses/')) return null;
    if (!has(caller, 'expense.edit')) return error(403, 'FORBIDDEN');
    if (path === '/v1/expenses') {
      if (method === 'GET') return list(query);
      if (method === 'POST') return create(body);
      return null;
    }
    if (path === '/v1/expenses/categories') {
      if (method === 'GET') return ok(categoryAnswer());
      if (method === 'PUT') return putCategories(body);
      return null;
    }
    const one = /^\/v1\/expenses\/([^/]+)(\/void)?$/.exec(path);
    if (!one) return null;
    if (method === 'PATCH' && !one[2]) return patch(one[1] ?? '', body);
    if (method === 'POST' && one[2]) return voidRow(one[1] ?? '', body);
    return null;
  }

  return { handle };
}
