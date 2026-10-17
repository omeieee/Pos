import { describe, expect, test } from 'vitest';
import { itemSales } from './items.ts';
import type { ReportItem, ReportOrder } from './revenue.ts';

let n = 0;
const item = (
  menuItemId: string,
  name: string,
  qty: number,
  lineTotalSatang: number,
): ReportItem => ({
  menuItemId,
  name,
  qty,
  lineTotalSatang,
});

const order = (items: ReportItem[], over: Partial<ReportOrder> = {}): ReportOrder => ({
  id: `o${++n}`,
  businessDate: '2026-10-01',
  channel: 'storefront',
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: items.reduce((s, i) => s + i.lineTotalSatang, 0),
  platformCommissionSatang: null,
  placedAt: new Date('2026-10-01T05:00:00Z'),
  payments: [],
  refunds: [],
  items,
  ...over,
});

describe('itemSales', () => {
  test('adds quantity and line totals per menu item across orders', () => {
    const rows = itemSales([
      order([item('a', 'ก๋วยเตี๋ยวต้มยำ', 2, 12000), item('b', 'ชาเย็น', 1, 3000)]),
      order([item('a', 'ก๋วยเตี๋ยวต้มยำ', 1, 6000)]),
    ]);
    expect(rows.map((r) => [r.menuItemId, r.qty, r.revenueSatang])).toEqual([
      ['a', 3, 18000],
      ['b', 1, 3000],
    ]);
  });

  test('counts only orders that count as revenue (paid, not cancelled)', () => {
    const rows = itemSales([
      order([item('a', 'A', 1, 5000)]),
      order([item('a', 'A', 5, 25000)], { status: 'cancelled' }),
      order([item('a', 'A', 7, 35000)], { paymentStatus: 'unpaid' }),
      order([item('a', 'A', 9, 45000)], { paymentStatus: 'partially_paid' }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ menuItemId: 'a', qty: 1, revenueSatang: 5000 }),
    ]);
  });

  test('sorts by quantity, then revenue, then name, so the order is stable', () => {
    const rows = itemSales([
      order([
        item('c', 'C', 2, 2000),
        item('b', 'B', 2, 4000),
        item('a', 'A', 2, 4000),
        item('d', 'D', 5, 100),
      ]),
    ]);
    expect(rows.map((r) => r.menuItemId)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('keeps the newest name of an item that was renamed', () => {
    const rows = itemSales([
      order([item('a', 'Old name', 1, 100)], { placedAt: new Date('2026-10-01T05:00:00Z') }),
      order([item('a', 'New name', 1, 100)], { placedAt: new Date('2026-10-02T05:00:00Z') }),
    ]);
    expect(rows[0]?.name).toBe('New name');
  });

  test('flags popular items: share of units at least 70% of an even share', () => {
    // 4 items, 100 units: an even share is 25 units, the bar is 17.5
    const rows = itemSales([
      order([
        item('a', 'A', 50, 1),
        item('b', 'B', 30, 1),
        item('c', 'C', 17, 1),
        item('d', 'D', 3, 1),
      ]),
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.menuItemId, r.popular]))).toEqual({
      a: true,
      b: true,
      c: false,
      d: false,
    });
    expect(rows.find((r) => r.menuItemId === 'a')?.unitShareBp).toBe(5000);
  });

  test('an order without items adds nothing, and no orders gives no rows', () => {
    expect(itemSales([order([])])).toEqual([]);
    expect(itemSales([])).toEqual([]);
  });

  test('refuses a fractional or negative quantity or amount', () => {
    expect(() => itemSales([order([item('a', 'A', 1.5, 100)])])).toThrow(RangeError);
    expect(() => itemSales([order([item('a', 'A', 1, -100)])])).toThrow(RangeError);
  });
});
