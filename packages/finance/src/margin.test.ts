import type { OrderChannel } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { itemSales } from './items.ts';
import { orderCost, periodMargin } from './margin.ts';
import type { ReportItem, ReportOrder } from './revenue.ts';

let n = 0;
/** A line: `unitCostSatang` is the cost snapshot per unit, null = no cost was entered. */
const line = (
  menuItemId: string,
  qty: number,
  lineTotalSatang: number,
  unitCostSatang: number | null,
): ReportItem => ({
  menuItemId,
  name: menuItemId.toUpperCase(),
  qty,
  lineTotalSatang,
  unitCostSatang,
});

/** A counted order paid in cash (net paid = `paid`), unless overridden. */
function order(items: ReportItem[], paid: number, over: Partial<ReportOrder> = {}): ReportOrder {
  const id = `o${++n}`;
  return {
    id,
    businessDate: '2026-10-01',
    channel: 'storefront' as OrderChannel,
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: paid,
    platformCommissionSatang: null,
    placedAt: new Date('2026-10-01T05:00:00Z'),
    payments: [{ id: `p-${id}`, method: 'cash', status: 'confirmed', amountSatang: paid }],
    refunds: [],
    items,
    ...over,
  };
}

describe('itemSales: cost, gross profit and margin per item', () => {
  test('cost is the sum of unit cost x qty; gross profit is revenue minus cost', () => {
    const [row] = itemSales([
      order([line('a', 2, 12000, 2200)], 12000),
      order([line('a', 1, 6500, 2500)], 6500), // sold with an extra, so its snapshot is higher
    ]);
    expect(row).toMatchObject({
      qty: 3,
      revenueSatang: 18500,
      costedQty: 3,
      costedRevenueSatang: 18500,
      costSatang: 6900, // 2 x 22.00 + 25.00
      grossProfitSatang: 11600,
      marginBp: 6270, // 11600 / 18500 = 62.70%
    });
  });

  test('a line with no cost entered is left out of the margin and not counted as costed', () => {
    const [row] = itemSales([
      order([line('a', 2, 5000, null)], 5000),
      order([line('a', 1, 2500, 900)], 2500),
    ]);
    expect(row).toMatchObject({
      qty: 3,
      revenueSatang: 7500,
      costedQty: 1,
      costedRevenueSatang: 2500,
      costSatang: 900,
      grossProfitSatang: 1600,
      marginBp: 6400,
    });
  });

  test('an item with no cost on any line has null cost, profit and margin', () => {
    const [row] = itemSales([order([line('a', 2, 5000, null)], 5000)]);
    expect(row).toMatchObject({
      qty: 2,
      revenueSatang: 5000,
      costedQty: 0,
      costedRevenueSatang: 0,
    });
    expect(row?.costSatang).toBeNull();
    expect(row?.grossProfitSatang).toBeNull();
    expect(row?.marginBp).toBeNull();
  });

  test('a cost of 0 is a real cost: full margin, not "no cost entered"', () => {
    const [row] = itemSales([order([line('a', 1, 1000, 0)], 1000)]);
    expect(row).toMatchObject({
      costedQty: 1,
      costSatang: 0,
      grossProfitSatang: 1000,
      marginBp: 10000,
    });
  });

  test('a loss is a negative gross profit and a negative margin', () => {
    const [row] = itemSales([order([line('a', 1, 1000, 1500)], 1000)]);
    expect(row).toMatchObject({ costSatang: 1500, grossProfitSatang: -500, marginBp: -5000 });
  });

  test('a free costed line (price 0) has a loss but no margin to state', () => {
    const [row] = itemSales([order([line('a', 1, 0, 300)], 0)]);
    expect(row).toMatchObject({ costedRevenueSatang: 0, costSatang: 300, grossProfitSatang: -300 });
    expect(row?.marginBp).toBeNull();
  });

  test('refuses a cost that is not a whole non-negative number of satang', () => {
    expect(() => itemSales([order([line('a', 1, 1000, 1.5)], 1000)])).toThrow(RangeError);
    expect(() => itemSales([order([line('a', 1, 1000, -1)], 1000)])).toThrow(RangeError);
  });

  test('orders that do not count add no cost either', () => {
    const [row] = itemSales([
      order([line('a', 1, 1000, 400)], 1000),
      order([line('a', 9, 9000, 3600)], 0, { status: 'cancelled', paymentStatus: 'unpaid' }),
    ]);
    expect(row).toMatchObject({ qty: 1, costSatang: 400 });
  });
});

describe('orderCost', () => {
  test('sums unit cost x qty when every line has a cost', () => {
    expect(orderCost(order([line('a', 2, 0, 250), line('b', 1, 0, 100)], 0))).toEqual({
      costed: true,
      costSatang: 600,
      uncostedMenuItemIds: [],
    });
  });

  test('is not costed when any line lacks a cost, and names those items once', () => {
    const result = orderCost(
      order([line('a', 2, 0, 250), line('b', 1, 0, null), line('b', 3, 0, null)], 0),
    );
    expect(result).toEqual({ costed: false, costSatang: 0, uncostedMenuItemIds: ['b'] });
  });

  test('an order with no lines cannot be costed', () => {
    expect(orderCost(order([], 0))).toEqual({
      costed: false,
      costSatang: 0,
      uncostedMenuItemIds: [],
    });
  });
});

describe('periodMargin', () => {
  test('margin is over whole orders whose every line has a cost; revenue is net paid', () => {
    const second = order([line('a', 1, 10000, 4000)], 10000);
    // paid 100.00, 25.00 handed back: revenue 75.00, but the food was still made (cost 40.00)
    second.refunds = [{ paymentId: second.payments[0]?.id ?? '', amountSatang: 2500 }];
    const result = periodMargin([order([line('a', 1, 10000, 4000)], 10000), second]);
    expect(result).toMatchObject({
      costedOrderCount: 2,
      costedRevenueSatang: 17500,
      costSatang: 8000,
      grossProfitSatang: 9500,
      marginBp: 5429, // 9500 / 17500 = 54.2857%
      uncostedOrderIds: [],
      uncostedMenuItemIds: [],
    });
  });

  test('leaves out an order with one uncosted line, names it, and reports what it leaves out', () => {
    const costed = order([line('a', 1, 10000, 4000)], 10000);
    const partly = order([line('a', 1, 5000, 2000), line('x', 1, 5000, null)], 10000);
    const result = periodMargin([costed, partly]);
    expect(result).toMatchObject({
      costedOrderCount: 1,
      costedRevenueSatang: 10000,
      costSatang: 4000,
      grossProfitSatang: 6000,
      marginBp: 6000,
      uncostedOrderIds: [partly.id],
      uncostedMenuItemIds: ['x'],
      uncostedRevenueSatang: 10000,
    });
  });

  test('an order discount lowers revenue but not cost (net paid, not line totals)', () => {
    const discounted = order([line('a', 1, 10000, 4000)], 9000); // 10.00 baht off
    expect(periodMargin([discounted])).toMatchObject({
      costedRevenueSatang: 9000,
      grossProfitSatang: 5000,
    });
  });

  test('ignores orders that do not count; no costed order = null profit and margin', () => {
    const result = periodMargin([
      order([line('a', 1, 1000, 400)], 0, { paymentStatus: 'unpaid' }),
      order([line('b', 1, 1000, null)], 1000),
    ]);
    expect(result.costedOrderCount).toBe(0);
    expect(result.grossProfitSatang).toBeNull();
    expect(result.marginBp).toBeNull();
    expect(result.uncostedOrderIds).toHaveLength(1);
    expect(periodMargin([])).toMatchObject({
      costedOrderCount: 0,
      costSatang: 0,
      uncostedOrderIds: [],
    });
  });

  test('cost and profit equal the plain sums over random lines (seeded)', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      const lines: ReportItem[] = [];
      let revenue = 0;
      let cost = 0;
      const count = (next() % 4) + 1;
      for (let j = 0; j < count; j++) {
        const qty = (next() % 5) + 1;
        const unit = next() % 5000;
        const price = next() % 9000;
        lines.push(line(`i${next() % 3}`, qty, qty * price, unit));
        revenue += qty * price;
        cost += qty * unit;
      }
      const result = periodMargin([order(lines, revenue)]);
      expect(result.costSatang).toBe(cost);
      expect(result.grossProfitSatang).toBe(revenue - cost);
    }
  });
});
