/**
 * Receipts and payments report (รายงานเงินสดรับ-จ่าย, P7, D-35). Pure: it takes the report orders
 * (already minus the inconsistent ones), the expense rows of the range and the owner's start amount,
 * and returns one row per business date. Money is integer satang.
 *
 * It is the working record behind the Revenue Department's "รายงานเงินสดรับ-จ่าย" form (Director-General
 * announcement on income tax No. 161, 21 Dec 2549, rd.go.th/33300.html): date, receipts, payments split
 * into "buying goods" and "other expenses". The form has no balance column; the running net here is an
 * extra working column.
 *
 * The shop has no cash drawer: every sale is paid by transfer into the owner's own account (owner
 * answer 2026-10-21). So nothing here is a drawer balance or a bank balance.
 *
 * Receipts (the form's receipts column, ALL methods):
 * - The same rule as the revenue report (03-data-model section 6, `keptPayments`): paid, not cancelled
 *   orders on their own `business_date`, each confirmed payment minus its own partial refunds. So the
 *   method columns add up to the revenue of that day, to the satang (`reconciliation` says so). If
 *   cash payments ever appear they are receipts like any other (their column stays).
 * - A co-pay or platform receipt is shown on the sale date, as revenue is, though the money arrives at
 *   the settlement or payout (not tracked). An order that is not fully paid counts nothing yet.
 *
 * Payments:
 * - Unvoided expenses on their own `business_date`. `purchaseCategories` (the categories flagged
 *   "buying goods" in the owner's list, `buyingGoodsKeys`) go in "buying goods", every other category
 *   in "other expenses". The platform commission is not a payment unless it was entered as an expense.
 * - Expenses have no payment method, so ALL of them are assumed paid from the same account.
 *
 * Running net: the start amount is the figure at the START of its as-of business day. A day before it
 * has no figure (null), and its activity is not in it. The figure of a day = start amount + (receipts
 * minus payments) from the as-of day to that day. `broughtForwardSatang` is that net from the as-of day
 * up to the day before `from`, worked out by the caller with this same function. No start amount set =
 * no running figure anywhere, never 0. It is NOT a bank statement: platform payouts and co-pay arrive
 * later and settlement is not tracked.
 */
import { DEFAULT_BUYING_GOODS_KEYS, PAYMENT_METHODS, type PaymentMethod } from '@sds/shared';
import type { PnlExpense } from './pnl.ts';
import { isCounted, keptPayments, type ReportOrder, revenueByDay } from './revenue.ts';

/**
 * Expense categories shown as "buying goods" (ซื้อสินค้า) when the caller gives none: the seeded
 * defaults. The real set is the owner's per-category flag (`buyingGoodsKeys` in `@sds/shared`).
 */
export const DEFAULT_PURCHASE_CATEGORIES: readonly string[] = DEFAULT_BUYING_GOODS_KEYS;

export interface CashOpening {
  /** The owner's start amount for the running net, at the start of `asOf`. */
  amountSatang: number;
  /** ISO business date. */
  asOf: string;
}

export interface CashInput {
  from: string;
  to: string;
  orders: readonly ReportOrder[];
  excludedOrderIds: readonly string[];
  expenses: readonly PnlExpense[];
  opening: CashOpening | null;
  /** Net (receipts minus payments) from `opening.asOf` to the day before `from`; 0 when `from` is not after it. */
  broughtForwardSatang?: number;
  includeEmptyDays?: boolean;
  purchaseCategories?: readonly string[];
}

export type ReceiptsByMethod = Record<PaymentMethod, number>;

export interface CashFigures {
  receiptsByMethod: ReceiptsByMethod;
  /** All methods; equals the revenue of the same orders. */
  receiptsSatang: number;
  /** The cash column of `receiptsByMethod` (0 while every sale is a transfer). */
  cashInSatang: number;
  purchasesSatang: number;
  otherExpensesSatang: number;
  paymentsSatang: number;
}

export interface CashDay extends CashFigures {
  businessDate: string;
  orderCount: number;
  expenseCount: number;
  /** Receipts minus payments of the day. */
  netSatang: number;
  /** Start amount + net from the as-of day to the end of this day; null before it or with no start amount set. */
  runningNetSatang: number | null;
}

export interface CashMonth extends CashFigures {
  month: string;
}

export interface CashReport {
  from: string;
  to: string;
  opening: CashOpening | null;
  openingNotSet: boolean;
  /** Running net at the start of `from`; null unless the start day is on or before `from`. */
  runningStartSatang: number | null;
  /** Running net at the end of `to`; null unless the start day is on or before `to`. */
  runningEndSatang: number | null;
  days: CashDay[];
  totals: CashFigures & {
    orderCount: number;
    expenseCount: number;
    /** Receipts minus payments: the "summary" line of the Revenue Department form. */
    receiptsMinusPaymentsSatang: number;
  };
  months: CashMonth[];
  excludedOrderIds: string[];
  /** False when any order was set aside as inconsistent: the figures can then be short. */
  complete: boolean;
  /** The revenue report's total for the same orders, and how far the receipts are from it (always 0). */
  reconciliation: { revenueReportSatang: number; differenceSatang: number };
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` moved by whole days (UTC midnight, so no daylight-saving drift). */
export function addIsoDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function assertSatang(value: number, label: string): void {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be an integer, got ${value}`);
}

const emptyMethods = (): ReceiptsByMethod => ({
  cash: 0,
  promptpay: 0,
  gov_copay: 0,
  platform: 0,
  other: 0,
});

interface Acc {
  methods: ReceiptsByMethod;
  purchases: number;
  other: number;
  orders: number;
  expenses: number;
}

const emptyAcc = (): Acc => ({
  methods: emptyMethods(),
  purchases: 0,
  other: 0,
  orders: 0,
  expenses: 0,
});

function figuresOf(acc: Acc): CashFigures {
  let receipts = 0;
  for (const m of PAYMENT_METHODS) receipts += acc.methods[m];
  return {
    receiptsByMethod: { ...acc.methods },
    receiptsSatang: receipts,
    cashInSatang: acc.methods.cash,
    purchasesSatang: acc.purchases,
    otherExpensesSatang: acc.other,
    paymentsSatang: acc.purchases + acc.other,
  };
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addIsoDays(d, 1)) out.push(d);
  return out;
}

export function cashReport(input: CashInput): CashReport {
  const purchaseCategories = new Set(input.purchaseCategories ?? DEFAULT_PURCHASE_CATEGORIES);
  const byDate = new Map<string, Acc>();
  const at = (date: string): Acc => {
    let acc = byDate.get(date);
    if (!acc) {
      acc = emptyAcc();
      byDate.set(date, acc);
    }
    return acc;
  };

  for (const order of input.orders) {
    if (!isCounted(order)) continue;
    const acc = at(order.businessDate);
    acc.orders += 1;
    for (const p of keptPayments(order)) acc.methods[p.method] += p.kept;
  }
  for (const e of input.expenses) {
    if (e.voided) continue;
    assertSatang(e.amountSatang, 'expense amount');
    if (e.amountSatang < 0) throw new RangeError('expense amount must not be negative');
    const acc = at(e.businessDate);
    acc.expenses += 1;
    if (purchaseCategories.has(e.category)) acc.purchases += e.amountSatang;
    else acc.other += e.amountSatang;
  }

  const { opening } = input;
  if (opening) assertSatang(opening.amountSatang, 'opening cash');
  const carry = input.broughtForwardSatang ?? 0;
  assertSatang(carry, 'brought forward');

  const dates = input.includeEmptyDays
    ? datesBetween(input.from, input.to)
    : [...byDate.keys()].sort();
  const startBalance = opening && opening.asOf <= input.from ? opening.amountSatang + carry : null;

  let running: number | null = null;
  const days: CashDay[] = dates.map((businessDate) => {
    const acc = byDate.get(businessDate) ?? emptyAcc();
    const f = figuresOf(acc);
    const net = f.receiptsSatang - f.paymentsSatang;
    let balance: number | null = null;
    if (opening && businessDate >= opening.asOf) {
      running ??= startBalance ?? opening.amountSatang;
      running += net;
      balance = running;
    }
    return {
      businessDate,
      ...f,
      orderCount: acc.orders,
      expenseCount: acc.expenses,
      netSatang: net,
      runningNetSatang: balance,
    };
  });

  const total = emptyAcc();
  for (const acc of byDate.values()) {
    for (const m of PAYMENT_METHODS) total.methods[m] += acc.methods[m];
    total.purchases += acc.purchases;
    total.other += acc.other;
    total.orders += acc.orders;
    total.expenses += acc.expenses;
  }
  const totalFigures = figuresOf(total);

  const months: CashMonth[] = [];
  if (input.from.slice(0, 7) !== input.to.slice(0, 7)) {
    const keys = new Set([...byDate.keys()].map((d) => d.slice(0, 7)));
    for (const month of [...keys].sort()) {
      const acc = emptyAcc();
      for (const [date, a] of byDate) {
        if (!date.startsWith(month)) continue;
        for (const m of PAYMENT_METHODS) acc.methods[m] += a.methods[m];
        acc.purchases += a.purchases;
        acc.other += a.other;
      }
      months.push({ month, ...figuresOf(acc) });
    }
  }

  let closing: number | null = null;
  if (opening && opening.asOf <= input.to) {
    // Days before the start day are not in the running net; the empty-days mode and the sparse mode
    // both end on the same figure because a day with no activity moves nothing.
    closing = running ?? startBalance ?? opening.amountSatang;
  }

  const revenue = revenueByDay(input.orders).reduce((s, d) => s + d.revenueSatang, 0);
  return {
    from: input.from,
    to: input.to,
    opening,
    openingNotSet: opening === null,
    runningStartSatang: startBalance,
    runningEndSatang: closing,
    days,
    totals: {
      ...totalFigures,
      orderCount: total.orders,
      expenseCount: total.expenses,
      receiptsMinusPaymentsSatang: totalFigures.receiptsSatang - totalFigures.paymentsSatang,
    },
    months,
    excludedOrderIds: [...input.excludedOrderIds],
    complete: input.excludedOrderIds.length === 0,
    reconciliation: {
      revenueReportSatang: revenue,
      differenceSatang: totalFigures.receiptsSatang - revenue,
    },
  };
}
