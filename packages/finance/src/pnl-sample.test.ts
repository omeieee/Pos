/**
 * The synthetic two-week sample the owner checks by hand (`docs/p7-pnl-sample.md`). The rows here are
 * the rows of that worksheet, in the same order and amounts. If you change one, change the other, or
 * the owner will be checking figures that no test pins. The two commission rates are examples only.
 */
import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { type PnlExpense, profitAndLoss } from './pnl.ts';
import type { ReportItem, ReportOrder } from './revenue.ts';
import { estimateTax } from './tax.ts';
import { thPit2569 } from './tax-rules/th-pit-2569.ts';

// Menu: T ก๋วยเตี๋ยวต้มยำ 60.00 (cost 22.00), Y เย็นตาโฟ 70.00 (28.00), W น้ำเปล่า 10.00 (4.00),
// X ชาเย็น 25.00 (cost not entered until 1 Oct, then 9.00).
const line = (
  id: 'T' | 'Y' | 'W' | 'X',
  qty: number,
  lineTotal: number,
  unitCost: number | null,
): ReportItem => ({
  menuItemId: id,
  name: id,
  qty,
  lineTotalSatang: lineTotal,
  unitCostSatang: unitCost,
});

interface Row {
  no: number;
  date: string;
  channel: OrderChannel;
  status?: ReportOrder['status'];
  paymentStatus?: ReportOrder['paymentStatus'];
  paid?: { method: PaymentMethod; satang: number; refund?: number };
  commission?: number;
  items: ReportItem[];
}

const rows: Row[] = [
  {
    no: 1,
    date: '2026-09-24',
    channel: 'storefront',
    paid: { method: 'cash', satang: 13000 },
    items: [line('T', 2, 12000, 2200), line('W', 1, 1000, 400)],
  },
  {
    no: 2,
    date: '2026-09-25',
    channel: 'line',
    paid: { method: 'promptpay', satang: 13000 },
    items: [line('Y', 1, 7000, 2800), line('T', 1, 6000, 2200)],
  },
  {
    no: 3,
    date: '2026-09-26',
    channel: 'storefront',
    paid: { method: 'cash', satang: 6000 },
    items: [line('X', 2, 5000, null), line('W', 1, 1000, 400)],
  },
  {
    no: 4,
    date: '2026-09-27',
    channel: 'grab',
    paid: { method: 'platform', satang: 8000 },
    items: [line('Y', 1, 8000, 2800)],
  },
  {
    no: 5,
    date: '2026-09-28',
    channel: 'storefront',
    paid: { method: 'cash', satang: 6000, refund: 1000 },
    items: [line('T', 1, 6000, 2200)],
  },
  {
    no: 6,
    date: '2026-09-29',
    channel: 'lineman',
    commission: 300,
    paid: { method: 'platform', satang: 2000 },
    items: [line('W', 2, 2000, 400)],
  },
  {
    no: 7,
    date: '2026-09-30',
    channel: 'storefront',
    paid: { method: 'gov_copay', satang: 6000 },
    items: [line('T', 1, 6000, 2200)],
  },
  {
    no: 8,
    date: '2026-09-30',
    channel: 'line',
    status: 'cancelled',
    paymentStatus: 'unpaid',
    items: [line('T', 1, 6000, 2200)],
  },
  {
    no: 9,
    date: '2026-10-01',
    channel: 'storefront',
    paid: { method: 'cash', satang: 2500 },
    items: [line('X', 1, 2500, 900)],
  },
  {
    no: 10,
    date: '2026-10-03',
    channel: 'grab',
    paid: { method: 'platform', satang: 9000 },
    items: [line('Y', 1, 9000, 2800)],
  },
  {
    no: 11,
    date: '2026-10-05',
    channel: 'line',
    paid: { method: 'promptpay', satang: 12000 },
    items: [line('T', 2, 12000, 2200)],
  },
  {
    no: 12,
    date: '2026-10-07',
    channel: 'storefront',
    paid: { method: 'cash', satang: 3000 },
    items: [line('W', 3, 3000, 400)],
  },
];

function toOrder(r: Row): ReportOrder {
  const paymentId = `pay-${r.no}`;
  return {
    id: `o${r.no}`,
    businessDate: r.date,
    channel: r.channel,
    status: r.status ?? 'completed',
    paymentStatus: r.paymentStatus ?? 'paid',
    totalSatang: r.items.reduce((s, i) => s + i.lineTotalSatang, 0),
    platformCommissionSatang: r.commission ?? null,
    placedAt: new Date(`${r.date}T05:00:00Z`),
    payments: r.paid
      ? [{ id: paymentId, method: r.paid.method, status: 'confirmed', amountSatang: r.paid.satang }]
      : [],
    refunds: r.paid?.refund ? [{ paymentId, amountSatang: r.paid.refund }] : [],
    items: r.items,
  };
}

const exp = (
  no: number,
  businessDate: string,
  category: string,
  amountSatang: number,
  voided = false,
): PnlExpense => ({ id: `e${no}`, businessDate, category, amountSatang, voided });

const expenses: PnlExpense[] = [
  exp(1, '2026-09-24', 'ingredients', 15000),
  exp(2, '2026-09-26', 'gas', 8000),
  exp(3, '2026-09-28', 'platform_fees', 1500),
  exp(4, '2026-09-29', 'ingredients', 99900, true), // entered by mistake, voided
  exp(5, '2026-10-02', 'ingredients', 10000),
  exp(6, '2026-10-04', 'packaging', 2000),
  exp(7, '2026-10-06', 'other', 1000),
];

const orders = rows.map(toOrder);
const base = { from: '2026-09-24', to: '2026-10-07', orders, excludedOrderIds: [], expenses };
const rates = { grabRateBp: 2500, linemanRateBp: 2000 }; // examples only, not real rates

describe('the owner P&L sample (docs/p7-pnl-sample.md)', () => {
  test('the whole fortnight with both rates set: net 368.50, incomplete only because of order 3', () => {
    const p = profitAndLoss({ ...base, rates });
    expect(p).toMatchObject({
      revenueSatang: 79500,
      orderCount: 11,
      costOfGoodsSatang: 27100,
      uncostedRevenueSatang: 6000,
      grossProfitSatang: 52400,
      commissionSatang: 4550, // 3.00 recorded + 20.00 + 22.50 estimated
      expensesSatang: 37500, // raw: 375.00, of which ingredients 250.00 and platform_fees 15.00
      // 271.00 cost of goods > 250.00 ingredients, 45.50 commission > 15.00 platform_fees: the smaller
      // of each pair is not deducted. 524.00 - 45.50 - 375.00 + 250.00 + 15.00
      foodCostBasis: 'cost_of_goods',
      foodCostNotDeductedSatang: 25000,
      ingredientsExpensesSatang: 25000,
      platformFeesBasis: 'commission',
      platformFeesNotDeductedSatang: 1500,
      platformFeesExpensesSatang: 1500,
      netProfitSatang: 36850,
      complete: false,
      incompleteReasons: ['orders_uncosted'],
      voidedExpenseCount: 1,
      govCopay: { revenueSatang: 6000, receivable: 'not_tracked' },
    });
    expect(p.commission).toMatchObject({ recordedSatang: 300, estimatedSatang: 4250 });
    expect(p.margin).toMatchObject({
      costedRevenueSatang: 73500,
      costSatang: 27100,
      grossProfitSatang: 46400,
      marginBp: 6313, // 63.129%
    });
    expect(p.missing).toEqual({
      excludedOrderIds: [],
      uncostedOrderIds: ['o3'],
      uncostedMenuItemIds: ['X'],
      rateNotSetOrderIds: [],
      ratesNotSet: [],
    });
    expect(p.expensesByCategory).toEqual([
      { category: 'ingredients', totalSatang: 25000, count: 2 },
      { category: 'gas', totalSatang: 8000, count: 1 },
      { category: 'packaging', totalSatang: 2000, count: 1 },
      { category: 'platform_fees', totalSatang: 1500, count: 1 },
      { category: 'other', totalSatang: 1000, count: 1 },
    ]);
  });

  test('month by month: September (incomplete) and October (complete)', () => {
    const p = profitAndLoss({ ...base, rates });
    expect(p.months).toEqual([
      {
        month: '2026-09',
        revenueSatang: 53000,
        orderCount: 7,
        costOfGoodsSatang: 17800,
        uncostedRevenueSatang: 6000,
        grossProfitSatang: 35200,
        commissionSatang: 2300,
        expensesSatang: 24500,
        // 178.00 cost of goods > 150.00 ingredients; 23.00 commission > 15.00 platform_fees
        foodCostNotDeductedSatang: 15000,
        platformFeesNotDeductedSatang: 1500,
        netProfitSatang: 24900,
        complete: false,
      },
      {
        month: '2026-10',
        revenueSatang: 26500,
        orderCount: 4,
        costOfGoodsSatang: 9300,
        uncostedRevenueSatang: 0,
        grossProfitSatang: 17200,
        commissionSatang: 2250,
        expensesSatang: 13000,
        // October alone: 100.00 ingredients > 93.00 cost of goods, so the cost of goods is the one
        // left out. The two months therefore add to 361.50, not to the 368.50 of the whole range.
        foodCostNotDeductedSatang: 9300,
        platformFeesNotDeductedSatang: 0,
        netProfitSatang: 11250,
        complete: true,
      },
    ]);
  });

  test('with the Grab rate not set, both Grab orders are named; the 3.00 commission is now the smaller side', () => {
    const p = profitAndLoss({ ...base, rates: { grabRateBp: null, linemanRateBp: 2000 } });
    expect(p.commissionSatang).toBe(300);
    // 3.00 commission < 15.00 platform_fees: the fees expense is deducted instead.
    // 524.00 - 3.00 - 375.00 + 250.00 (food overlap) + 3.00 = 399.00
    expect(p.platformFeesBasis).toBe('platform_fees_expenses');
    expect(p.platformFeesNotDeductedSatang).toBe(300);
    expect(p.netProfitSatang).toBe(39900);
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toEqual(['orders_uncosted', 'commission_rate_not_set']);
    expect(p.missing.rateNotSetOrderIds).toEqual(['o4', 'o10']);
    expect(p.missing.ratesNotSet).toEqual(['grab']);
    expect(p.months[1]).toMatchObject({ complete: false, netProfitSatang: 13500 });
  });

  test('the tax estimate fed from this P&L deducts exactly what the P&L deducts (net 368.50)', () => {
    const p = profitAndLoss({ ...base, rates });
    const e = estimateTax({
      rules: thPit2569,
      period: 'half',
      range: { from: '2026-01-01', to: '2026-06-30' },
      asOf: '2026-10-20',
      grossIncomeSatang: p.revenueSatang,
      expenses: {
        costOfGoodsSatang: p.costOfGoodsSatang,
        commissionSatang: p.commissionSatang,
        ledgerSatang: p.expensesSatang,
        ingredientsLedgerSatang: p.ingredientsExpensesSatang,
        platformFeesLedgerSatang: p.platformFeesExpensesSatang,
      },
      pnlComplete: p.complete,
      allowanceItems: [],
      methodPreference: null,
      incomingTransfers: null,
    });
    expect(e.methods.actual.netBeforeAllowancesSatang).toBe(p.netProfitSatang);
    expect(e.methods.actual.expenseSatang).toBe(p.revenueSatang - p.netProfitSatang);
    expect(e.foodCostBasis).toBe(p.foodCostBasis);
    expect(e.platformFeesBasis).toBe(p.platformFeesBasis);
  });
});
