import { describe, expect, test } from 'vitest';
import { heatmap } from './heatmap.ts';
import type { ReportOrder, ReportPayment } from './revenue.ts';

let n = 0;
const cash = (amountSatang: number): ReportPayment => ({
  id: `p${++n}`,
  method: 'cash',
  status: 'confirmed',
  amountSatang,
});

const order = (
  placedAt: string,
  businessDate: string,
  amount: number,
  over: Partial<ReportOrder> = {},
): ReportOrder => ({
  id: `o${++n}`,
  businessDate,
  channel: 'storefront',
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: amount,
  platformCommissionSatang: null,
  placedAt: new Date(placedAt),
  payments: [cash(amount)],
  refunds: [],
  items: [],
  ...over,
});

describe('heatmap (weekday from business_date, hour from placed_at in Bangkok)', () => {
  test('puts an order in the cell of its Bangkok hour and its business date weekday', () => {
    // 2026-10-01 is a Thursday. 05:30Z = 12:30 in Bangkok.
    const cells = heatmap([order('2026-10-01T05:30:00Z', '2026-10-01', 7000)]);
    expect(cells).toEqual([{ weekday: 4, hour: 12, orderCount: 1, revenueSatang: 7000 }]);
  });

  test('uses the Bangkok hour, not the UTC hour (17:30Z is 00:30 the next day)', () => {
    const cells = heatmap([order('2026-10-01T17:30:00Z', '2026-10-01', 5000)]);
    expect(cells).toEqual([{ weekday: 4, hour: 0, orderCount: 1, revenueSatang: 5000 }]);
  });

  test('a 00:30 order sits under the PREVIOUS business day weekday (Thursday, not Friday)', () => {
    const cells = heatmap([order('2026-10-01T17:30:00Z', '2026-10-01', 100)]);
    expect(cells[0]?.weekday).toBe(4);
    expect(cells[0]?.hour).toBe(0);
  });

  test('adds orders of the same cell on different weeks, and sorts by weekday then hour', () => {
    const cells = heatmap([
      order('2026-10-08T05:10:00Z', '2026-10-08', 2000), // Thursday 12:10
      order('2026-10-01T05:50:00Z', '2026-10-01', 3000), // Thursday 12:50
      order('2026-10-05T03:00:00Z', '2026-10-05', 1000), // Monday 10:00
    ]);
    expect(cells).toEqual([
      { weekday: 1, hour: 10, orderCount: 1, revenueSatang: 1000 },
      { weekday: 4, hour: 12, orderCount: 2, revenueSatang: 5000 },
    ]);
  });

  test('Sunday is weekday 7 (ISO: Monday 1 ... Sunday 7)', () => {
    // 2026-10-04 is a Sunday
    expect(heatmap([order('2026-10-04T05:00:00Z', '2026-10-04', 1)])[0]?.weekday).toBe(7);
  });

  test('uses net revenue (a partial refund is subtracted) and skips orders that do not count', () => {
    const p = cash(10000);
    const cells = heatmap([
      order('2026-10-01T05:00:00Z', '2026-10-01', 10000, {
        payments: [p],
        refunds: [{ paymentId: p.id, amountSatang: 4000 }],
      }),
      order('2026-10-01T05:10:00Z', '2026-10-01', 999, { status: 'cancelled' }),
      order('2026-10-01T05:20:00Z', '2026-10-01', 999, { paymentStatus: 'unpaid' }),
    ]);
    expect(cells).toEqual([{ weekday: 4, hour: 12, orderCount: 1, revenueSatang: 6000 }]);
  });

  test('no orders gives no cells', () => {
    expect(heatmap([])).toEqual([]);
  });
});
