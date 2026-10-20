import { describe, expect, test } from 'vitest';
import { splitInconsistent } from './consistency.ts';
import type { ReportOrder } from './revenue.ts';

const order = (id: string, payAmount: number, refunded: number[]): ReportOrder => ({
  id,
  businessDate: '2026-10-01',
  channel: 'storefront',
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: payAmount,
  platformCommissionSatang: null,
  placedAt: new Date('2026-10-01T05:00:00Z'),
  payments: [{ id: `${id}-p`, method: 'cash', status: 'confirmed', amountSatang: payAmount }],
  refunds: refunded.map((amountSatang) => ({ paymentId: `${id}-p`, amountSatang })),
  items: [],
});

describe('splitInconsistent', () => {
  test('keeps orders whose refunds fit inside their payments', () => {
    const orders = [order('a', 5000, []), order('b', 5000, [1000, 4000])];
    expect(splitInconsistent(orders)).toEqual({ usable: orders, excludedOrderIds: [] });
  });

  test('sets aside an order whose refunds exceed its payment, and names it', () => {
    const good = order('good', 5000, [500]);
    const bad = order('bad', 5000, [3000, 2001]);
    const { usable, excludedOrderIds } = splitInconsistent([good, bad]);
    expect(usable).toEqual([good]);
    expect(excludedOrderIds).toEqual(['bad']);
  });

  test('leaves alone an order that does not count (its refunds are never read)', () => {
    const open: ReportOrder = { ...order('open', 5000, [9000]), paymentStatus: 'partially_paid' };
    expect(splitInconsistent([open])).toEqual({ usable: [open], excludedOrderIds: [] });
  });
});
