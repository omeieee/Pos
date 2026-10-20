import type { OrderChannel } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { platformCommission } from './commission.ts';
import type { ReportOrder } from './revenue.ts';

let n = 0;
function order(channel: OrderChannel, paid: number, over: Partial<ReportOrder> = {}): ReportOrder {
  const id = `o${++n}`;
  return {
    id,
    businessDate: '2026-10-01',
    channel,
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: paid,
    platformCommissionSatang: null,
    placedAt: new Date('2026-10-01T05:00:00Z'),
    payments: [{ id: `p-${id}`, method: 'platform', status: 'confirmed', amountSatang: paid }],
    refunds: [],
    items: [],
    ...over,
  };
}
const noRates = { grabRateBp: null, linemanRateBp: null };

describe('platformCommission', () => {
  test('a platform order with a rate set is estimated: net paid x rate, half up', () => {
    const result = platformCommission([order('grab', 10050), order('lineman', 8000)], {
      grabRateBp: 2500,
      linemanRateBp: 1000,
    });
    expect(result).toMatchObject({
      recordedSatang: 0,
      estimatedSatang: 2513 + 800, // 25.125 -> 25.13 (half up), and 8.00
      totalSatang: 3313,
      estimatedOrderCount: 2,
      rateNotSetOrderIds: [],
      ratesNotSet: [],
    });
  });

  test('a commission recorded on the order wins over the rate', () => {
    const result = platformCommission([order('lineman', 8000, { platformCommissionSatang: 300 })], {
      grabRateBp: null,
      linemanRateBp: 2000,
    });
    expect(result).toMatchObject({
      recordedSatang: 300,
      estimatedSatang: 0,
      totalSatang: 300,
      recordedOrderCount: 1,
    });
  });

  test('a recorded 0 is a recorded value, not a gap', () => {
    const result = platformCommission(
      [order('grab', 8000, { platformCommissionSatang: 0 })],
      noRates,
    );
    expect(result).toMatchObject({
      recordedOrderCount: 1,
      rateNotSetOrderIds: [],
      ratesNotSet: [],
    });
  });

  test('with no rate and nothing recorded: no number, the orders and the platform are named', () => {
    const a = order('grab', 8000);
    const b = order('grab', 1000);
    const c = order('lineman', 500);
    const result = platformCommission([a, b, c], { grabRateBp: null, linemanRateBp: 1500 });
    expect(result).toMatchObject({
      estimatedSatang: 75, // only the LINE MAN order has a rate
      totalSatang: 75,
      rateNotSetOrderIds: [a.id, b.id],
      ratesNotSet: ['grab'],
    });
  });

  test('a rate of 0 is a rate that is set (a platform that takes nothing)', () => {
    const result = platformCommission([order('grab', 8000)], {
      grabRateBp: 0,
      linemanRateBp: null,
    });
    expect(result).toMatchObject({ estimatedSatang: 0, estimatedOrderCount: 1, ratesNotSet: [] });
  });

  test('the estimate is on what the platform order kept after a partial refund', () => {
    const o = order('grab', 10000);
    o.refunds = [{ paymentId: o.payments[0]?.id ?? '', amountSatang: 2000 }];
    const result = platformCommission([o], { grabRateBp: 3000, linemanRateBp: null });
    expect(result.estimatedSatang).toBe(2400); // 30% of 80.00
  });

  test('storefront and LINE orders are never estimated; orders that do not count are ignored', () => {
    const result = platformCommission(
      [
        order('storefront', 5000),
        order('line', 5000),
        order('grab', 5000, { status: 'cancelled', paymentStatus: 'unpaid' }),
      ],
      { grabRateBp: 3000, linemanRateBp: 3000 },
    );
    expect(result).toMatchObject({
      totalSatang: 0,
      estimatedOrderCount: 0,
      rateNotSetOrderIds: [],
    });
  });
});
