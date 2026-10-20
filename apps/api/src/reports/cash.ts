/**
 * Receipts and payments (P7, D-35). Owner only. The maths is `cashReport` in `@sds/finance`; this
 * loads the orders (minus inconsistent ones), the expense rows, the owner's start amount (setting
 * `cash_opening`) and the categories flagged "buying goods". When the range starts after the start
 * day, the net (receipts minus payments) from the start day up to the day before the range is worked
 * out with the same pure function, in windows of at most 366 days (the report range limit), so there
 * is one rule and no second implementation in SQL.
 */
import { type Db, expensesRepo } from '@sds/db';
import { addIsoDays, cashReport as buildCashReport, type CashOpening } from '@sds/finance';
import {
  type CashReport,
  type CashReportQuery,
  cashReportSchema,
  REPORT_MAX_DAYS,
} from '@sds/shared';
import { currentBuyingGoodsKeys } from '../expenses/categories.ts';
import { currentCashOpening } from '../settings/service.ts';
import { loadReportOrders } from './service.ts';

const toExpense = (e: Awaited<ReturnType<typeof expensesRepo.listExpenses>>[number]) => ({
  id: e.id,
  businessDate: e.businessDate,
  category: e.category,
  amountSatang: e.amountSatang,
  voided: e.voidedAt !== null,
});

/** Net (receipts minus payments) from `opening.asOf` to the day before `from`, and any orders set aside. */
async function broughtForward(
  db: Db,
  opening: CashOpening,
  from: string,
  purchaseCategories: readonly string[],
): Promise<{ netSatang: number; excludedOrderIds: string[] }> {
  let netSatang = 0;
  const excludedOrderIds: string[] = [];
  const last = addIsoDays(from, -1);
  for (let start = opening.asOf; start <= last; ) {
    const end =
      addIsoDays(start, REPORT_MAX_DAYS - 1) < last ? addIsoDays(start, REPORT_MAX_DAYS - 1) : last;
    const [{ usable, excludedOrderIds: excluded }, rows] = await Promise.all([
      loadReportOrders(db, { from: start, to: end }),
      expensesRepo.listExpenses(db, start, end),
    ]);
    const window = buildCashReport({
      from: start,
      to: end,
      orders: usable,
      excludedOrderIds: excluded,
      expenses: rows.map(toExpense),
      opening: null,
      purchaseCategories,
    });
    netSatang += window.totals.receiptsMinusPaymentsSatang;
    excludedOrderIds.push(...excluded);
    start = addIsoDays(end, 1);
  }
  return { netSatang, excludedOrderIds };
}

export async function cashReport(db: Db, query: CashReportQuery): Promise<CashReport> {
  const setting = await currentCashOpening(db);
  const opening: CashOpening | null =
    setting.amountSatang !== null && setting.asOf !== null
      ? { amountSatang: setting.amountSatang, asOf: setting.asOf }
      : null;
  const purchaseCategories = await currentBuyingGoodsKeys(db);
  const [{ usable, excludedOrderIds }, rows, carry] = await Promise.all([
    loadReportOrders(db, query),
    expensesRepo.listExpenses(db, query.from, query.to),
    opening && opening.asOf < query.from
      ? broughtForward(db, opening, query.from, purchaseCategories)
      : Promise.resolve({ netSatang: 0, excludedOrderIds: [] as string[] }),
  ]);
  const report = buildCashReport({
    from: query.from,
    to: query.to,
    orders: usable,
    excludedOrderIds: [...excludedOrderIds, ...carry.excludedOrderIds],
    expenses: rows.map(toExpense),
    opening,
    broughtForwardSatang: carry.netSatang,
    includeEmptyDays: query.emptyDays === 'true',
    purchaseCategories,
  });
  return cashReportSchema.parse(report);
}
