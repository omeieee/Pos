/**
 * Profit and loss over a period (P7, D-33). Pure: it takes the report orders (already minus the
 * inconsistent ones), the expense rows of the range, and the commission rates, and adds nothing of
 * its own to the rules: revenue is net paid (`revenueByDay`), cost is `periodMargin`, commission is
 * `platformCommission`. Money is integer satang; a loss is a negative number.
 *
 * Lines, in order:
 *   revenue            net paid of counted orders, on each order's business date (03 section 6)
 * - cost of goods      Σ unit cost snapshot × qty of the orders whose every line has a cost
 * = gross profit       revenue - cost of goods
 * - platform commission  recorded, else rate × net paid, else named as "rate not set" (no number)
 * - expenses           ledger rows by business date, voided rows left out
 * = net profit before income tax
 *
 * Nothing is guessed. An order with an uncosted line adds its revenue but no cost, and an order whose
 * platform rate is not set adds no commission, so while `complete` is false the gross and net profit
 * can only be too HIGH (every recorded expense is in). `complete` is false when any order was set
 * aside as inconsistent, any counted order is uncosted, or any platform order has no commission
 * number. A commission that is an estimate from a rate is a number and does not make it incomplete.
 *
 * `margin.grossProfitSatang` is the margin.ts figure: over costed orders only. It differs from the
 * P&L `grossProfitSatang` by exactly `uncostedRevenueSatang`.
 *
 * The `platform_fees` expense category is NOT netted against commission and the commission is not
 * inside `expensesSatang`: both are deducted, side by side. `platformFeesAlsoCommission` is true when
 * both are non-zero so the screen can ask the owner not to have typed the same fee twice.
 *
 * Gov co-pay is revenue at the full amount on the sale date (it is inside `revenueSatang`). The
 * receivable until the next-day settlement is not tracked anywhere yet: `govCopay.receivable` says so.
 */
import {
  type CommissionSummary,
  type PlatformRates,
  platformCommission,
  type RatedPlatform,
} from './commission.ts';
import { type PeriodMargin, periodMargin } from './margin.ts';
import { type ReportOrder, revenueByDay } from './revenue.ts';

export interface PnlExpense {
  id: string;
  /** ISO `YYYY-MM-DD`. */
  businessDate: string;
  category: string;
  amountSatang: number;
  voided: boolean;
}

export interface PnlInput {
  /** The requested range, ISO dates; decides whether a month breakdown is given. */
  from: string;
  to: string;
  /** Usable orders (see `splitInconsistent`); orders that do not count are ignored. */
  orders: readonly ReportOrder[];
  /** Orders set aside because their refunds exceed their payment. */
  excludedOrderIds: readonly string[];
  expenses: readonly PnlExpense[];
  rates: PlatformRates;
}

export type IncompleteReason = 'orders_excluded' | 'orders_uncosted' | 'commission_rate_not_set';

export interface PnlFigures {
  revenueSatang: number;
  orderCount: number;
  /** Costed orders only (D-32). */
  costOfGoodsSatang: number;
  /** Net paid of counted orders that have no cost: in revenue, not in cost of goods. */
  uncostedRevenueSatang: number;
  /** `revenueSatang - costOfGoodsSatang`. */
  grossProfitSatang: number;
  /** Recorded plus estimated; orders with "rate not set" are not in it. */
  commissionSatang: number;
  /** Unvoided ledger rows, every category (platform_fees included). */
  expensesSatang: number;
  /** `grossProfitSatang - commissionSatang - expensesSatang`; negative for a loss. */
  netProfitSatang: number;
  complete: boolean;
}

export interface PnlMonth extends PnlFigures {
  /** `YYYY-MM` of the business date. The first and last month of a range may be partial. */
  month: string;
}

export interface ExpenseCategoryTotal {
  category: string;
  totalSatang: number;
  count: number;
}

export interface Pnl extends PnlFigures {
  margin: PeriodMargin;
  commission: CommissionSummary;
  expensesByCategory: ExpenseCategoryTotal[];
  voidedExpenseCount: number;
  platformFeesAlsoCommission: boolean;
  govCopay: { revenueSatang: number; receivable: 'not_built' };
  missing: {
    excludedOrderIds: string[];
    uncostedOrderIds: string[];
    uncostedMenuItemIds: string[];
    rateNotSetOrderIds: string[];
    ratesNotSet: RatedPlatform[];
  };
  incompleteReasons: IncompleteReason[];
  /** One row per calendar month with data, only when the range touches more than one month. */
  months: PnlMonth[];
}

const PLATFORM_FEES = 'platform_fees';

function liveExpenses(expenses: readonly PnlExpense[]): PnlExpense[] {
  const live: PnlExpense[] = [];
  for (const e of expenses) {
    if (e.voided) continue;
    if (!Number.isSafeInteger(e.amountSatang) || e.amountSatang < 0) {
      throw new RangeError(
        `expense amount must be a whole number of satang, got ${e.amountSatang}`,
      );
    }
    live.push(e);
  }
  return live;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function figures(
  orders: readonly ReportOrder[],
  live: readonly PnlExpense[],
  rates: PlatformRates,
  excludedCount: number,
): PnlFigures & { margin: PeriodMargin; commission: CommissionSummary; govCopay: number } {
  const days = revenueByDay(orders);
  const revenue = sum(days.map((d) => d.revenueSatang));
  const margin = periodMargin(orders);
  const commission = platformCommission(orders, rates);
  const expenses = sum(live.map((e) => e.amountSatang));
  const gross = revenue - margin.costSatang;
  return {
    revenueSatang: revenue,
    orderCount: sum(days.map((d) => d.orderCount)),
    costOfGoodsSatang: margin.costSatang,
    uncostedRevenueSatang: margin.uncostedRevenueSatang,
    grossProfitSatang: gross,
    commissionSatang: commission.totalSatang,
    expensesSatang: expenses,
    netProfitSatang: gross - commission.totalSatang - expenses,
    complete:
      excludedCount === 0 &&
      margin.uncostedOrderIds.length === 0 &&
      commission.rateNotSetOrderIds.length === 0,
    margin,
    commission,
    govCopay: sum(days.map((d) => d.byMethod.gov_copay ?? 0)),
  };
}

function byCategory(live: readonly PnlExpense[]): ExpenseCategoryTotal[] {
  const totals = new Map<string, ExpenseCategoryTotal>();
  for (const e of live) {
    const row = totals.get(e.category) ?? { category: e.category, totalSatang: 0, count: 0 };
    row.totalSatang += e.amountSatang;
    row.count += 1;
    totals.set(e.category, row);
  }
  return [...totals.values()].sort(
    (a, b) => b.totalSatang - a.totalSatang || a.category.localeCompare(b.category),
  );
}

export function profitAndLoss(input: PnlInput): Pnl {
  const { orders, rates } = input;
  const live = liveExpenses(input.expenses);
  const excluded = [...input.excludedOrderIds];
  const all = figures(orders, live, rates, excluded.length);
  const { margin, commission, govCopay, ...totals } = all;

  const reasons: IncompleteReason[] = [];
  if (excluded.length > 0) reasons.push('orders_excluded');
  if (margin.uncostedOrderIds.length > 0) reasons.push('orders_uncosted');
  if (commission.rateNotSetOrderIds.length > 0) reasons.push('commission_rate_not_set');

  const feesExpense = sum(
    live.filter((e) => e.category === PLATFORM_FEES).map((e) => e.amountSatang),
  );

  const months: PnlMonth[] = [];
  if (input.from.slice(0, 7) !== input.to.slice(0, 7)) {
    const keys = new Set<string>();
    for (const o of orders) keys.add(o.businessDate.slice(0, 7));
    for (const e of live) keys.add(e.businessDate.slice(0, 7));
    for (const month of [...keys].sort()) {
      const m = figures(
        orders.filter((o) => o.businessDate.startsWith(month)),
        live.filter((e) => e.businessDate.startsWith(month)),
        rates,
        // An excluded order carries no date here, so it cannot be placed in a month: every month
        // is then incomplete rather than quietly trusted.
        excluded.length,
      );
      months.push({
        month,
        revenueSatang: m.revenueSatang,
        orderCount: m.orderCount,
        costOfGoodsSatang: m.costOfGoodsSatang,
        uncostedRevenueSatang: m.uncostedRevenueSatang,
        grossProfitSatang: m.grossProfitSatang,
        commissionSatang: m.commissionSatang,
        expensesSatang: m.expensesSatang,
        netProfitSatang: m.netProfitSatang,
        complete: m.complete,
      });
    }
  }

  return {
    ...totals,
    margin,
    commission,
    expensesByCategory: byCategory(live),
    voidedExpenseCount: input.expenses.filter((e) => e.voided).length,
    platformFeesAlsoCommission: commission.totalSatang > 0 && feesExpense > 0,
    govCopay: { revenueSatang: govCopay, receivable: 'not_built' },
    missing: {
      excludedOrderIds: excluded,
      uncostedOrderIds: margin.uncostedOrderIds,
      uncostedMenuItemIds: margin.uncostedMenuItemIds,
      rateNotSetOrderIds: commission.rateNotSetOrderIds,
      ratesNotSet: commission.ratesNotSet,
    },
    incompleteReasons: reasons,
    months,
  };
}
