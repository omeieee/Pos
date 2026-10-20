/**
 * The synthetic sample the owner checks by hand (`docs/p6-hand-check-sample.md`). The orders here
 * are the rows of that worksheet, in the same order and amounts. If you change one, change the
 * other, or the owner will be checking figures that no test pins.
 */
import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { type ReportOrder, revenueByDay } from './revenue.ts';

let n = 0;
interface Row {
  no: number;
  date: string;
  channel: OrderChannel;
  status?: ReportOrder['status'];
  paymentStatus?: ReportOrder['paymentStatus'];
  total: number;
  paid?: { method: PaymentMethod; satang: number; refund?: number };
  commission?: number;
}

function toOrder(r: Row): ReportOrder {
  const paymentId = `pay-${r.no}`;
  return {
    id: `o${r.no}`,
    businessDate: r.date,
    channel: r.channel,
    status: r.status ?? 'completed',
    paymentStatus: r.paymentStatus ?? 'paid',
    totalSatang: r.total,
    platformCommissionSatang: r.commission ?? null,
    placedAt: new Date(`${r.date}T05:00:00Z`),
    payments: r.paid
      ? [{ id: paymentId, method: r.paid.method, status: 'confirmed', amountSatang: r.paid.satang }]
      : [],
    refunds: r.paid?.refund ? [{ paymentId, amountSatang: r.paid.refund }] : [],
    items: [],
  };
}

const D1 = '2026-09-14';
const D2 = '2026-09-15';
const rows: Row[] = [
  { no: ++n, date: D1, channel: 'storefront', total: 8000, paid: { method: 'cash', satang: 8000 } },
  {
    no: ++n,
    date: D1,
    channel: 'line',
    total: 12050,
    paid: { method: 'promptpay', satang: 12050 },
  },
  {
    no: ++n,
    date: D1,
    channel: 'storefront',
    total: 10000,
    paid: { method: 'cash', satang: 10000, refund: 2500 },
  },
  {
    no: ++n,
    date: D1,
    channel: 'grab',
    total: 10000,
    commission: 3000,
    paid: { method: 'platform', satang: 10000 },
  },
  {
    no: ++n,
    date: D1,
    channel: 'storefront',
    total: 10000,
    paid: { method: 'gov_copay', satang: 10000 },
  },
  { no: ++n, date: D1, channel: 'line', status: 'cancelled', paymentStatus: 'unpaid', total: 9900 },
  { no: ++n, date: D1, channel: 'storefront', paymentStatus: 'unpaid', total: 7700 },
  {
    no: ++n,
    date: D1,
    channel: 'storefront',
    paymentStatus: 'partially_paid',
    total: 9000,
    paid: { method: 'cash', satang: 4000 },
  },
  { no: ++n, date: D2, channel: 'storefront', total: 6000, paid: { method: 'cash', satang: 6000 } },
  {
    no: ++n,
    date: D2,
    channel: 'storefront',
    total: 14000,
    paid: { method: 'promptpay', satang: 14000 },
  },
  { no: ++n, date: D2, channel: 'line', total: 5555, paid: { method: 'promptpay', satang: 5555 } },
];

describe('the owner hand-check sample', () => {
  const days = revenueByDay(rows.map(toOrder));

  test('day 1 (Mon 14 Sep 2026): 5 paid orders, 475.50 baht', () => {
    expect(days[0]).toEqual({
      businessDate: D1,
      revenueSatang: 47550, // 80.00 + 120.50 + (100.00 - 25.00) + 100.00 + 100.00
      orderCount: 5,
      averageTicketSatang: 9510,
      commissionSatang: 3000,
      byChannel: { storefront: 25500, line: 12050, grab: 10000 },
      byMethod: { cash: 15500, promptpay: 12050, platform: 10000, gov_copay: 10000 },
    });
  });

  test('day 2 (Tue 15 Sep 2026): 3 paid orders, 255.55 baht', () => {
    expect(days[1]).toEqual({
      businessDate: D2,
      revenueSatang: 25555,
      orderCount: 3,
      averageTicketSatang: 8518, // 255.55 / 3 = 85.1833...
      commissionSatang: 0,
      byChannel: { storefront: 20000, line: 5555 },
      byMethod: { cash: 6000, promptpay: 19555 },
    });
  });

  test('the month so far: 731.05 baht from 8 orders, average 91.38', () => {
    const revenue = days.reduce((sum, d) => sum + d.revenueSatang, 0);
    const orders = days.reduce((sum, d) => sum + d.orderCount, 0);
    expect(revenue).toBe(73105);
    expect(orders).toBe(8);
    expect(Math.floor((2 * revenue + orders) / (2 * orders))).toBe(9138);
  });
});
