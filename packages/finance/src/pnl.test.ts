import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { type PnlExpense, type PnlInput, profitAndLoss } from './pnl.ts';
import type { ReportItem, ReportOrder } from './revenue.ts';

let n = 0;
const line = (qty: number, lineTotal: number, unitCost: number | null): ReportItem => ({
  menuItemId: 'm1',
  name: 'M1',
  qty,
  lineTotalSatang: lineTotal,
  unitCostSatang: unitCost,
});

function order(
  paid: number,
  items: ReportItem[],
  over: Partial<ReportOrder> & { method?: PaymentMethod } = {},
): ReportOrder {
  const id = `o${++n}`;
  const { method, ...rest } = over;
  return {
    id,
    businessDate: '2026-10-01',
    channel: 'storefront' as OrderChannel,
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: paid,
    platformCommissionSatang: null,
    placedAt: new Date('2026-10-01T05:00:00Z'),
    payments: [
      { id: `p-${id}`, method: method ?? 'cash', status: 'confirmed', amountSatang: paid },
    ],
    refunds: [],
    items,
    ...rest,
  };
}

const expense = (
  amountSatang: number,
  category = 'gas',
  over: Partial<PnlExpense> = {},
): PnlExpense => ({
  id: `e${++n}`,
  businessDate: '2026-10-01',
  category,
  amountSatang,
  voided: false,
  ...over,
});

const noRates = { grabRateBp: null, linemanRateBp: null };
const input = (over: Partial<PnlInput> = {}): PnlInput => ({
  from: '2026-10-01',
  to: '2026-10-31',
  orders: [],
  excludedOrderIds: [],
  expenses: [],
  rates: noRates,
  ...over,
});

describe('profitAndLoss', () => {
  test('an empty period is all zeros, complete, with no months', () => {
    const p = profitAndLoss(input());
    expect(p).toMatchObject({
      revenueSatang: 0,
      costOfGoodsSatang: 0,
      grossProfitSatang: 0,
      commissionSatang: 0,
      expensesSatang: 0,
      netProfitSatang: 0,
      complete: true,
      incompleteReasons: [],
      expensesByCategory: [],
      months: [],
    });
  });

  test('revenue - cost = gross profit; minus commission and expenses = net profit', () => {
    const p = profitAndLoss(
      input({
        orders: [order(10000, [line(2, 10000, 3000)])],
        expenses: [expense(1500, 'gas'), expense(500, 'other')],
      }),
    );
    expect(p).toMatchObject({
      revenueSatang: 10000,
      costOfGoodsSatang: 6000,
      grossProfitSatang: 4000,
      expensesSatang: 2000,
      netProfitSatang: 2000,
      complete: true,
    });
  });

  test('a loss is a negative number, not clamped', () => {
    const p = profitAndLoss(
      input({ orders: [order(1000, [line(1, 1000, 600)])], expenses: [expense(5000, 'rent')] }),
    );
    expect(p.grossProfitSatang).toBe(400);
    expect(p.netProfitSatang).toBe(-4600);
  });

  test('voided expenses are left out and counted', () => {
    const p = profitAndLoss(
      input({
        expenses: [expense(700, 'gas'), expense(99900, 'gas', { voided: true })],
      }),
    );
    expect(p.expensesSatang).toBe(700);
    expect(p.voidedExpenseCount).toBe(1);
    expect(p.expensesByCategory).toEqual([{ category: 'gas', totalSatang: 700, count: 1 }]);
  });

  test('expenses by category: largest first, ties by key; a switched-off key still counts', () => {
    const p = profitAndLoss(
      input({
        expenses: [
          expense(100, 'zeta'),
          expense(100, 'alpha'),
          expense(300, 'lunch_boxes'),
          expense(50, 'alpha'),
        ],
      }),
    );
    expect(p.expensesByCategory).toEqual([
      { category: 'lunch_boxes', totalSatang: 300, count: 1 },
      { category: 'alpha', totalSatang: 150, count: 2 },
      { category: 'zeta', totalSatang: 100, count: 1 },
    ]);
  });

  test('an uncosted order: revenue counts, its cost is not guessed, the answer is incomplete', () => {
    const costed = order(10000, [line(1, 10000, 4000)]);
    const uncosted = order(6000, [line(1, 6000, null)]);
    const p = profitAndLoss(input({ orders: [costed, uncosted] }));
    expect(p).toMatchObject({
      revenueSatang: 16000,
      costOfGoodsSatang: 4000,
      uncostedRevenueSatang: 6000,
      grossProfitSatang: 12000, // an upper bound: the uncosted order's cost is missing
      netProfitSatang: 12000,
      complete: false,
      incompleteReasons: ['orders_uncosted'],
    });
    expect(p.missing.uncostedOrderIds).toEqual([uncosted.id]);
    expect(p.missing.uncostedMenuItemIds).toEqual(['m1']);
    // the margin block keeps the costed basis of margin.ts
    expect(p.margin.grossProfitSatang).toBe(6000);
  });

  test('platform commission: recorded wins, a rate estimates, and an estimate is still complete', () => {
    const recorded = order(2000, [line(1, 2000, 400)], {
      channel: 'lineman',
      method: 'platform',
      platformCommissionSatang: 300,
    });
    const rated = order(8000, [line(1, 8000, 2800)], { channel: 'grab', method: 'platform' });
    const p = profitAndLoss(
      input({ orders: [recorded, rated], rates: { grabRateBp: 2500, linemanRateBp: 2000 } }),
    );
    expect(p.commissionSatang).toBe(300 + 2000);
    expect(p.commission).toMatchObject({ recordedSatang: 300, estimatedSatang: 2000 });
    expect(p.complete).toBe(true);
    expect(p.netProfitSatang).toBe(10000 - 3200 - 2300);
  });

  test('a rate that is not set: the order is named, the commission is not guessed, incomplete', () => {
    const grab = order(8000, [line(1, 8000, 2800)], { channel: 'grab', method: 'platform' });
    const p = profitAndLoss(input({ orders: [grab] }));
    expect(p.commissionSatang).toBe(0);
    expect(p.missing.rateNotSetOrderIds).toEqual([grab.id]);
    expect(p.missing.ratesNotSet).toEqual(['grab']);
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toEqual(['commission_rate_not_set']);
  });

  test('orders set aside as inconsistent make the answer incomplete and are named', () => {
    const p = profitAndLoss(input({ excludedOrderIds: ['bad-1'] }));
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toEqual(['orders_excluded']);
    expect(p.missing.excludedOrderIds).toEqual(['bad-1']);
  });

  test('platform_fees expenses and commission are separate lines and both are deducted', () => {
    const grab = order(8000, [line(1, 8000, 2800)], { channel: 'grab', method: 'platform' });
    const p = profitAndLoss(
      input({
        orders: [grab],
        rates: { grabRateBp: 2500, linemanRateBp: null },
        expenses: [expense(1500, 'platform_fees')],
      }),
    );
    expect(p.commissionSatang).toBe(2000);
    expect(p.expensesByCategory).toEqual([
      { category: 'platform_fees', totalSatang: 1500, count: 1 },
    ]);
    expect(p.expensesSatang).toBe(1500); // the commission is not inside this number
    expect(p.netProfitSatang).toBe(8000 - 2800 - 2000 - 1500);
    expect(p.platformFeesAlsoCommission).toBe(true);
  });

  test('the overlap flag is off when only one of the two is present', () => {
    expect(
      profitAndLoss(input({ expenses: [expense(1500, 'platform_fees')] }))
        .platformFeesAlsoCommission,
    ).toBe(false);
    const rec = order(2000, [line(1, 2000, 400)], {
      channel: 'lineman',
      method: 'platform',
      platformCommissionSatang: 300,
    });
    expect(profitAndLoss(input({ orders: [rec] })).platformFeesAlsoCommission).toBe(false);
  });

  test('gov co-pay: revenue on the sale date at the full amount; the receivable is not built', () => {
    const copay = order(6000, [line(1, 6000, 2200)], { method: 'gov_copay' });
    const cash = order(1000, [line(1, 1000, 400)]);
    const p = profitAndLoss(input({ orders: [copay, cash] }));
    expect(p.revenueSatang).toBe(7000);
    expect(p.govCopay).toEqual({ revenueSatang: 6000, receivable: 'not_built' });
  });

  test('a partial refund lowers revenue but not cost', () => {
    const o = order(6000, [line(1, 6000, 2200)], {
      refunds: [{ paymentId: 'p-x', amountSatang: 1000 }],
    });
    o.payments = [{ id: 'p-x', method: 'cash', status: 'confirmed', amountSatang: 6000 }];
    const p = profitAndLoss(input({ orders: [o] }));
    expect(p.revenueSatang).toBe(5000);
    expect(p.costOfGoodsSatang).toBe(2200);
    expect(p.grossProfitSatang).toBe(2800);
  });

  test('rejects an expense amount that is not a whole number of satang', () => {
    expect(() => profitAndLoss(input({ expenses: [expense(10.5)] }))).toThrow(RangeError);
    expect(() => profitAndLoss(input({ expenses: [expense(-1)] }))).toThrow(RangeError);
  });
});

describe('per-month breakdown', () => {
  const sep = order(10000, [line(1, 10000, 4000)], { businessDate: '2026-09-30' });
  const oct = order(5000, [line(1, 5000, null)], { businessDate: '2026-10-02' });
  const range = { from: '2026-09-25', to: '2026-10-05' };

  test('a range inside one calendar month has no breakdown', () => {
    expect(
      profitAndLoss(input({ orders: [oct], from: '2026-10-01', to: '2026-10-31' })).months,
    ).toEqual([]);
  });

  test('a range over two months gets one row each, oldest first, that adds up to the totals', () => {
    const p = profitAndLoss(
      input({
        ...range,
        orders: [oct, sep],
        expenses: [
          expense(700, 'gas', { businessDate: '2026-09-26' }),
          expense(300, 'gas', { businessDate: '2026-10-03' }),
          expense(5000, 'gas', { businessDate: '2026-10-03', voided: true }),
        ],
      }),
    );
    expect(p.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(p.months[0]).toMatchObject({
      revenueSatang: 10000,
      costOfGoodsSatang: 4000,
      expensesSatang: 700,
      netProfitSatang: 5300,
      complete: true,
    });
    expect(p.months[1]).toMatchObject({
      revenueSatang: 5000,
      uncostedRevenueSatang: 5000,
      expensesSatang: 300,
      netProfitSatang: 4700,
      complete: false,
    });
    for (const key of [
      'revenueSatang',
      'costOfGoodsSatang',
      'grossProfitSatang',
      'commissionSatang',
      'expensesSatang',
      'netProfitSatang',
    ] as const) {
      expect(
        p.months.reduce((s, m) => s + m[key], 0),
        key,
      ).toBe(p[key]);
    }
  });

  test('an expense in a month with no orders still gets a row; an empty month does not', () => {
    const p = profitAndLoss(
      input({
        from: '2026-08-01',
        to: '2026-10-31',
        orders: [oct],
        expenses: [expense(900, 'rent', { businessDate: '2026-08-15' })],
      }),
    );
    expect(p.months.map((m) => m.month)).toEqual(['2026-08', '2026-10']);
    expect(p.months[0]?.netProfitSatang).toBe(-900);
  });

  test('inconsistent orders have no month, so every month row is incomplete', () => {
    const p = profitAndLoss(input({ ...range, orders: [sep], excludedOrderIds: ['bad'] }));
    expect(p.months.every((m) => !m.complete)).toBe(true);
  });
});
