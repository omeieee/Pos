import { describe, expect, test } from 'vitest';
import type { PaymentMethod, PaymentStatus } from './enums.ts';
import { satang } from './money.ts';
import { adjustRefundInputSchema, netPaid, planAdjustment } from './payment-adjustment.ts';
import { derivePaymentStatus } from './payment-machine.ts';

const p = (
  id: string,
  status: PaymentStatus,
  amount: number,
  refunded = 0,
  method: PaymentMethod = 'cash',
) => ({ id, method, status, amount: satang(amount), refunded: satang(refunded) });

describe('netPaid', () => {
  test('confirmed minus what was partly refunded; nothing else counts', () => {
    expect(netPaid([])).toBe(0);
    expect(netPaid([p('a', 'confirmed', 10000, 2500), p('b', 'confirmed', 3000)])).toBe(10500);
    expect(
      netPaid([
        p('a', 'pending', 5000),
        p('b', 'claimed', 5000),
        p('c', 'cancelled', 5000),
        p('d', 'voided', 5000, 1000),
        p('e', 'refunded', 5000, 1000),
      ]),
    ).toBe(0);
  });
});

describe('derivePaymentStatus with partial refunds', () => {
  const total = satang(7500);
  test('a partly refunded payment that now covers the new total is paid', () => {
    expect(
      derivePaymentStatus(total, [
        { status: 'confirmed', amount: satang(10000), refunded: satang(2500) },
      ]),
    ).toBe('paid');
  });
  test('refunded more than the total allows is partially paid', () => {
    expect(
      derivePaymentStatus(total, [
        { status: 'confirmed', amount: satang(10000), refunded: satang(3000) },
      ]),
    ).toBe('partially_paid');
  });
  test('no refunded field means nothing was refunded', () => {
    expect(derivePaymentStatus(total, [{ status: 'confirmed', amount: satang(7500) }])).toBe(
      'paid',
    );
  });
});

describe('planAdjustment', () => {
  test('same total: nothing to do', () => {
    expect(planAdjustment(satang(10000), [p('a', 'confirmed', 10000)])).toEqual({ kind: 'none' });
  });

  test('nothing confirmed: nothing to adjust (the normal flow collects)', () => {
    expect(planAdjustment(satang(5000), [p('a', 'pending', 10000)])).toEqual({ kind: 'none' });
    expect(planAdjustment(satang(5000), [])).toEqual({ kind: 'none' });
  });

  test('higher total: top-up for the exact difference', () => {
    expect(planAdjustment(satang(12500), [p('a', 'confirmed', 10000)])).toEqual({
      kind: 'topup',
      amountSatang: 2500,
    });
  });

  test('top-up counts what an earlier partial refund already returned', () => {
    expect(planAdjustment(satang(10000), [p('a', 'confirmed', 10000, 4000)])).toEqual({
      kind: 'topup',
      amountSatang: 4000,
    });
  });

  test('lower total: refund of the difference from the one payment', () => {
    expect(planAdjustment(satang(7000), [p('a', 'confirmed', 10000)])).toEqual({
      kind: 'refund',
      amountSatang: 3000,
      allocations: [{ paymentId: 'a', amountSatang: 3000 }],
    });
  });

  test('lower total across two payments: newest first, never beyond what is left on one', () => {
    const plan = planAdjustment(satang(6000), [
      p('old', 'confirmed', 10000, 1000),
      p('new', 'confirmed', 2000),
    ]);
    expect(plan).toEqual({
      kind: 'refund',
      amountSatang: 5000,
      allocations: [
        { paymentId: 'new', amountSatang: 2000 },
        { paymentId: 'old', amountSatang: 3000 },
      ],
    });
  });

  test('allocations always add up to the difference', () => {
    for (let total = 1; total < 12000; total += 777) {
      const plan = planAdjustment(satang(total), [
        p('a', 'confirmed', 7000, 500),
        p('b', 'confirmed', 5000),
      ]);
      if (plan.kind === 'refund') {
        expect(plan.allocations.reduce((s, a) => s + a.amountSatang, 0)).toBe(plan.amountSatang);
        expect(plan.amountSatang).toBe(11500 - total);
      }
    }
  });

  test('a claimed payment blocks it: staff settle the claim first', () => {
    expect(
      planAdjustment(satang(5000), [p('a', 'confirmed', 10000), p('b', 'claimed', 2000)]),
    ).toEqual({ kind: 'blocked', reason: 'claim_open' });
  });

  test('a new total of zero is a full refund, not an adjustment', () => {
    expect(planAdjustment(satang(0), [p('a', 'confirmed', 10000)])).toEqual({
      kind: 'blocked',
      reason: 'total_zero',
    });
  });

  test('co-pay, platform and other payments are not partly refunded', () => {
    for (const method of ['gov_copay', 'platform', 'other'] as const) {
      expect(planAdjustment(satang(5000), [p('a', 'confirmed', 10000, 0, method)])).toEqual({
        kind: 'blocked',
        reason: 'method_not_adjustable',
      });
    }
    // A top-up does not touch the old payment, so it is fine.
    expect(planAdjustment(satang(12000), [p('a', 'confirmed', 10000, 0, 'gov_copay')]).kind).toBe(
      'topup',
    );
  });

  test('cash plus a co-pay payment: the cash side can cover the refund', () => {
    expect(
      planAdjustment(satang(9000), [
        p('g', 'confirmed', 6000, 0, 'gov_copay'),
        p('c', 'confirmed', 4000, 0, 'cash'),
      ]),
    ).toEqual({
      kind: 'refund',
      amountSatang: 1000,
      allocations: [{ paymentId: 'c', amountSatang: 1000 }],
    });
  });

  test('a refund bigger than the adjustable money is blocked', () => {
    expect(
      planAdjustment(satang(2000), [
        p('g', 'confirmed', 6000, 0, 'gov_copay'),
        p('c', 'confirmed', 4000, 0, 'cash'),
      ]),
    ).toEqual({ kind: 'blocked', reason: 'method_not_adjustable' });
  });
});

describe('adjustRefundInputSchema', () => {
  test('method is cash or promptpay; an amount is refused', () => {
    expect(adjustRefundInputSchema.safeParse({ method: 'cash' }).success).toBe(true);
    expect(
      adjustRefundInputSchema.safeParse({ method: 'promptpay', referenceNote: 'ธ.กสิกร 1234' })
        .success,
    ).toBe(true);
    expect(adjustRefundInputSchema.safeParse({ method: 'other' }).success).toBe(false);
    expect(adjustRefundInputSchema.safeParse({ method: 'cash', amountSatang: 100 }).success).toBe(
      false,
    );
  });
});
