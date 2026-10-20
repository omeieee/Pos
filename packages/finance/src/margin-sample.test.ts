/**
 * The synthetic sample the owner checks by hand (`docs/p7-margin-sample.md`). The orders here are the
 * rows of that worksheet, in the same order and amounts. If you change one, change the other, or the
 * owner will be checking figures that no test pins. The two commission rates are examples only.
 */
import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { platformCommission } from './commission.ts';
import { itemSales } from './items.ts';
import { periodMargin } from './margin.ts';
import { type ReportItem, type ReportOrder, revenueByDay } from './revenue.ts';

// Menu: T ก๋วยเตี๋ยวต้มยำ 60.00 (cost 22.00), Y เย็นตาโฟ 70.00 (28.00), W น้ำเปล่า 10.00 (4.00),
// X ชาเย็น 25.00 (cost not entered until day 2, then 9.00).
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

const D1 = '2026-09-14';
const D2 = '2026-09-15';
const rows: Row[] = [
  {
    no: 1,
    date: D1,
    channel: 'storefront',
    paid: { method: 'cash', satang: 13000 },
    items: [line('T', 2, 12000, 2200), line('W', 1, 1000, 400)],
  },
  {
    no: 2,
    date: D1,
    channel: 'line',
    paid: { method: 'promptpay', satang: 13500 },
    items: [line('Y', 1, 7000, 2800), line('T', 1, 6500, 2500)],
  },
  {
    no: 3,
    date: D1,
    channel: 'storefront',
    paid: { method: 'cash', satang: 6000 },
    items: [line('X', 2, 5000, null), line('W', 1, 1000, 400)],
  },
  {
    no: 4,
    date: D1,
    channel: 'grab',
    paid: { method: 'platform', satang: 8000 },
    items: [line('Y', 1, 8000, 2800)],
  },
  {
    no: 5,
    date: D1,
    channel: 'line',
    status: 'cancelled',
    paymentStatus: 'unpaid',
    items: [line('T', 1, 6000, 2200)],
  },
  {
    no: 6,
    date: D1,
    channel: 'storefront',
    paid: { method: 'cash', satang: 6000, refund: 1000 },
    items: [line('T', 1, 6000, 2200)],
  },
  {
    no: 7,
    date: D1,
    channel: 'lineman',
    commission: 300,
    paid: { method: 'platform', satang: 2000 },
    items: [line('W', 2, 2000, 400)],
  },
  {
    no: 8,
    date: D2,
    channel: 'storefront',
    paid: { method: 'cash', satang: 2500 },
    items: [line('X', 1, 2500, 900)],
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

const orders = rows.map(toOrder);
const rates = { grabRateBp: 2500, linemanRateBp: 2000 }; // examples only, not real rates

describe('the owner margin sample (docs/p7-margin-sample.md)', () => {
  test('revenue: 7 paid orders, 500.00 baht (the margin does not change it)', () => {
    const revenue = revenueByDay(orders).reduce((s, d) => s + d.revenueSatang, 0);
    expect(revenue).toBe(50000);
  });

  test('per item: cost, gross profit and margin over the units that have a cost', () => {
    const byId = new Map(itemSales(orders).map((i) => [i.menuItemId, i]));
    expect(byId.get('T')).toMatchObject({
      qty: 4,
      revenueSatang: 24500,
      costedQty: 4,
      costSatang: 9100, // 2 x 22.00 + 25.00 + 22.00
      grossProfitSatang: 15400,
      marginBp: 6286, // 62.857%
    });
    expect(byId.get('Y')).toMatchObject({
      qty: 2,
      revenueSatang: 15000,
      costSatang: 5600,
      grossProfitSatang: 9400,
      marginBp: 6267, // 62.667%
    });
    expect(byId.get('W')).toMatchObject({
      qty: 4,
      revenueSatang: 4000,
      costSatang: 1600,
      grossProfitSatang: 2400,
      marginBp: 6000,
    });
    // X: 2 cups sold with no cost entered, then 1 cup after the owner entered 9.00
    expect(byId.get('X')).toMatchObject({
      qty: 3,
      revenueSatang: 7500,
      costedQty: 1,
      costedRevenueSatang: 2500,
      costSatang: 900,
      grossProfitSatang: 1600,
      marginBp: 6400,
    });
  });

  test('the period: margin over the 6 fully costed orders; order 3 is named and left out', () => {
    expect(periodMargin(orders)).toEqual({
      costedOrderCount: 6,
      costedRevenueSatang: 44000, // 130 + 135 + 80 + 50 + 20 + 25
      costSatang: 16800, // 48 + 53 + 28 + 22 + 8 + 9
      grossProfitSatang: 27200,
      marginBp: 6182, // 61.818%
      uncostedOrderIds: ['o3'],
      uncostedRevenueSatang: 6000,
      uncostedMenuItemIds: ['X'],
    });
  });

  test('commission: the recorded 3.00 wins; the Grab order is estimated at 25% of 80.00', () => {
    const result = platformCommission(orders, rates);
    expect(result).toMatchObject({
      recordedSatang: 300,
      estimatedSatang: 2000,
      totalSatang: 2300,
      rateNotSetOrderIds: [],
    });
    // Both platform orders are among the 6 costed ones, so profit after commission is:
    expect(27200 - result.totalSatang).toBe(24900);
  });

  test('with the Grab rate not set, the Grab order has no commission number and is named', () => {
    const result = platformCommission(orders, { grabRateBp: null, linemanRateBp: 2000 });
    expect(result).toMatchObject({
      totalSatang: 300,
      rateNotSetOrderIds: ['o4'],
      ratesNotSet: ['grab'],
    });
  });
});
