import { businessDate, type OrderChannel, type PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { type ReportOrder, type ReportPayment, revenueByDay } from './revenue.ts';

let n = 0;
const pay = (
  method: PaymentMethod,
  amountSatang: number,
  status: ReportPayment['status'] = 'confirmed',
): ReportPayment => ({ id: `p${++n}`, method, status, amountSatang });

const order = (o: Partial<ReportOrder> & Pick<ReportOrder, 'payments'>): ReportOrder => ({
  id: `o${++n}`,
  businessDate: '2026-10-01',
  channel: 'storefront' as OrderChannel,
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: o.payments.reduce((s, p) => s + p.amountSatang, 0),
  platformCommissionSatang: null,
  placedAt: new Date('2026-10-01T05:00:00Z'),
  refunds: [],
  items: [],
  ...o,
});

const day = (orders: ReportOrder[], d = '2026-10-01') => {
  const row = revenueByDay(orders).find((r) => r.businessDate === d);
  if (!row) throw new Error(`no row for ${d}`);
  return row;
};

describe('revenueByDay (03-data-model §6)', () => {
  test('a paid order counts its confirmed payments, split by channel and method', () => {
    const rows = revenueByDay([
      order({ payments: [pay('cash', 8000)] }),
      order({ channel: 'line', payments: [pay('promptpay', 12050)] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      businessDate: '2026-10-01',
      revenueSatang: 20050,
      orderCount: 2,
      averageTicketSatang: 10025,
      commissionSatang: 0,
      byChannel: { storefront: 8000, line: 12050 },
      byMethod: { cash: 8000, promptpay: 12050 },
    });
  });

  test('average ticket rounds half up to one satang, and no orders gives no rows', () => {
    const r = day([
      order({ payments: [pay('cash', 100)] }),
      order({ payments: [pay('cash', 101)] }),
    ]);
    expect(r.averageTicketSatang).toBe(101); // 201 / 2 = 100.5
    expect(revenueByDay([])).toEqual([]);
  });

  test('a partly paid order counts nothing (paid orders only)', () => {
    const r = day([
      order({ payments: [pay('cash', 5000)] }),
      order({
        paymentStatus: 'partially_paid',
        totalSatang: 9000,
        payments: [pay('cash', 4000)],
      }),
    ]);
    expect(r.revenueSatang).toBe(5000);
    expect(r.orderCount).toBe(1);
  });

  test('unpaid and awaiting-confirmation orders count nothing', () => {
    const rows = revenueByDay([
      order({ paymentStatus: 'unpaid', totalSatang: 7000, payments: [] }),
      order({
        paymentStatus: 'awaiting_confirmation',
        totalSatang: 7000,
        payments: [pay('promptpay', 7000, 'claimed')],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test('a cancelled order is excluded', () => {
    const r = day([
      order({ payments: [pay('cash', 6000)] }),
      order({ status: 'cancelled', payments: [pay('cash', 9999, 'voided')] }),
    ]);
    expect(r.revenueSatang).toBe(6000);
    expect(r.orderCount).toBe(1);
  });

  test('a voided payment counts nothing, even beside a confirmed one', () => {
    const r = day([
      order({
        totalSatang: 5000,
        payments: [pay('promptpay', 5000, 'voided'), pay('cash', 5000)],
      }),
    ]);
    expect(r.revenueSatang).toBe(5000);
    expect(r.byMethod).toEqual({ cash: 5000 });
  });

  test('a payment refunded whole counts nothing', () => {
    const p = pay('promptpay', 5000, 'refunded');
    const rows = revenueByDay([
      order({
        paymentStatus: 'refunded',
        payments: [p],
        refunds: [{ paymentId: p.id, amountSatang: 5000 }],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test('a partial refund is subtracted and counts on the ORIGINAL order business day', () => {
    const p = pay('cash', 10000);
    const rows = revenueByDay([
      order({
        businessDate: '2026-10-01',
        payments: [p],
        // refunded on 2026-10-02, but the row has no date: it belongs to the order's day
        refunds: [{ paymentId: p.id, amountSatang: 2500 }],
      }),
      order({ businessDate: '2026-10-02', payments: [pay('cash', 3000)] }),
    ]);
    expect(rows.map((r) => [r.businessDate, r.revenueSatang])).toEqual([
      ['2026-10-01', 7500],
      ['2026-10-02', 3000],
    ]);
    expect(rows[0]?.byMethod).toEqual({ cash: 7500 });
  });

  test('a refund of a payment that is not counted is ignored', () => {
    const r = day([
      order({ payments: [pay('cash', 4000)] }),
      order({
        status: 'cancelled',
        payments: [pay('cash', 1000, 'voided')],
        refunds: [{ paymentId: 'unknown', amountSatang: 1000 }],
      }),
    ]);
    expect(r.revenueSatang).toBe(4000);
  });

  test('a platform order counts the platform price and records the commission separately', () => {
    const r = day([
      order({
        channel: 'grab',
        platformCommissionSatang: 3000,
        payments: [pay('platform', 10000)],
      }),
      order({ payments: [pay('cash', 5000)] }),
    ]);
    expect(r.revenueSatang).toBe(15000);
    expect(r.commissionSatang).toBe(3000);
    expect(r.byChannel).toEqual({ grab: 10000, storefront: 5000 });
  });

  test('a co-pay order counts the full order total (government share and customer share)', () => {
    const r = day([order({ totalSatang: 10000, payments: [pay('gov_copay', 10000)] })]);
    expect(r.revenueSatang).toBe(10000);
    expect(r.byMethod).toEqual({ gov_copay: 10000 });
  });

  test('groups by the stored business date: a 00:30 order belongs to the previous day', () => {
    const placed = new Date('2026-10-01T17:30:00Z'); // 00:30 on 2026-10-02 in Bangkok
    const d = businessDate(placed); // default 04:00 cutoff
    expect(d).toBe('2026-10-01');
    const rows = revenueByDay([
      order({ businessDate: d, payments: [pay('cash', 4000)] }),
      order({ businessDate: '2026-10-02', payments: [pay('cash', 1000)] }),
    ]);
    expect(rows.map((r) => [r.businessDate, r.revenueSatang])).toEqual([
      ['2026-10-01', 4000],
      ['2026-10-02', 1000],
    ]);
  });

  test('rows come back sorted by business date', () => {
    const rows = revenueByDay([
      order({ businessDate: '2026-10-03', payments: [pay('cash', 1)] }),
      order({ businessDate: '2026-10-01', payments: [pay('cash', 1)] }),
    ]);
    expect(rows.map((r) => r.businessDate)).toEqual(['2026-10-01', '2026-10-03']);
  });

  test('a refund larger than its payment is refused instead of making revenue negative', () => {
    const p = pay('cash', 1000);
    expect(() =>
      revenueByDay([order({ payments: [p], refunds: [{ paymentId: p.id, amountSatang: 1500 }] })]),
    ).toThrow(RangeError);
  });
});
