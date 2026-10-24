import { describe, expect, test } from 'vitest';
import {
  canCustomerEdit,
  isDuplicateCart,
  isPayFirst,
  type MergeFacts,
  mergeEligible,
} from './order-merge.ts';

const CUSTOMER = '0191a8f0-0000-7000-8000-0000000000c1';
const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  customerId: CUSTOMER,
  channel: 'line',
  status: 'new',
  businessDate: '2026-10-24',
  deliveryBuilding: 'B1',
  recipientName: 'Fah',
  payments: [{ status: 'pending', hasSlip: false }],
  ...over,
});

describe('isPayFirst (D-38)', () => {
  test('only a LINE order paid by PromptPay', () => {
    expect(isPayFirst({ channel: 'line', paymentMethod: 'promptpay' })).toBe(true);
    expect(isPayFirst({ channel: 'line', paymentMethod: 'cash' })).toBe(false);
    expect(isPayFirst({ channel: 'line', paymentMethod: 'gov_copay' })).toBe(false);
    expect(isPayFirst({ channel: 'line', paymentMethod: null })).toBe(false);
    for (const channel of ['storefront', 'phone', 'grab', 'lineman'] as const) {
      expect(isPayFirst({ channel, paymentMethod: 'promptpay' })).toBe(false);
    }
  });
});

describe('canCustomerEdit (A4)', () => {
  test('a new order with an untouched pending payment', () => {
    expect(canCustomerEdit({ status: 'new' }, [{ status: 'pending', hasSlip: false }])).toBe(true);
    expect(canCustomerEdit({ status: 'new' }, [])).toBe(true);
  });

  test('not after acceptance or cancellation', () => {
    for (const status of ['preparing', 'ready', 'completed', 'cancelled'] as const) {
      expect(canCustomerEdit({ status }, [])).toBe(false);
    }
  });

  test('not once a payment is claimed or confirmed', () => {
    for (const status of ['claimed', 'confirmed', 'voided', 'refunded'] as const) {
      expect(canCustomerEdit({ status: 'new' }, [{ status, hasSlip: false }])).toBe(false);
    }
  });

  test('not once any slip was uploaded, even on a pending or cancelled payment', () => {
    expect(canCustomerEdit({ status: 'new' }, [{ status: 'pending', hasSlip: true }])).toBe(false);
    expect(
      canCustomerEdit({ status: 'new' }, [
        { status: 'cancelled', hasSlip: true },
        { status: 'pending', hasSlip: false },
      ]),
    ).toBe(false);
  });

  test('a cancelled payment without a slip does not block', () => {
    expect(
      canCustomerEdit({ status: 'new' }, [
        { status: 'cancelled', hasSlip: false },
        { status: 'pending', hasSlip: false },
      ]),
    ).toBe(true);
  });
});

describe('mergeEligible (D-39)', () => {
  test('same customer, line, new, date, building and name', () => {
    expect(mergeEligible(facts(), [facts()])).toBe(true);
    expect(mergeEligible(facts(), [facts(), facts()])).toBe(true);
  });

  test('building and name compare trimmed and case-folded', () => {
    expect(
      mergeEligible(facts(), [facts({ deliveryBuilding: ' b1 ', recipientName: '  FAH ' })]),
    ).toBe(true);
  });

  test('refused when the building or the name differs or is missing', () => {
    expect(mergeEligible(facts(), [facts({ deliveryBuilding: 'B2' })])).toBe(false);
    expect(mergeEligible(facts(), [facts({ recipientName: 'Nok' })])).toBe(false);
    expect(mergeEligible(facts(), [facts({ deliveryBuilding: null })])).toBe(false);
    expect(
      mergeEligible(facts({ deliveryBuilding: null, recipientName: null }), [
        facts({ deliveryBuilding: null, recipientName: null }),
      ]),
    ).toBe(false);
  });

  test('refused for another customer, a guest, another channel, status or day', () => {
    expect(mergeEligible(facts(), [facts({ customerId: 'other' })])).toBe(false);
    expect(mergeEligible(facts({ customerId: null }), [facts({ customerId: null })])).toBe(false);
    expect(mergeEligible(facts(), [facts({ channel: 'storefront' })])).toBe(false);
    expect(mergeEligible(facts({ channel: 'grab' }), [facts({ channel: 'grab' })])).toBe(false);
    expect(mergeEligible(facts(), [facts({ status: 'preparing' })])).toBe(false);
    expect(mergeEligible(facts({ status: 'cancelled' }), [facts()])).toBe(false);
    expect(mergeEligible(facts(), [facts({ businessDate: '2026-10-23' })])).toBe(false);
  });

  test('refused when any order has a confirmed payment', () => {
    const confirmed = [{ status: 'confirmed' as const, hasSlip: true }];
    expect(mergeEligible(facts(), [facts({ payments: confirmed })])).toBe(false);
    expect(mergeEligible(facts({ payments: confirmed }), [facts()])).toBe(false);
  });

  test('a claim without a slip, or a slip alone, is not eligible either', () => {
    expect(
      mergeEligible(facts(), [facts({ payments: [{ status: 'claimed', hasSlip: false }] })]),
    ).toBe(false);
    expect(
      mergeEligible(facts({ payments: [{ status: 'claimed', hasSlip: false }] }), [facts()]),
    ).toBe(false);
    expect(
      mergeEligible(facts(), [facts({ payments: [{ status: 'pending', hasSlip: true }] })]),
    ).toBe(false);
  });

  test('needs at least one source', () => {
    expect(mergeEligible(facts(), [])).toBe(false);
  });
});

describe('isDuplicateCart', () => {
  const A = '0191a8f0-0000-7000-8000-00000000000a';
  const B = '0191a8f0-0000-7000-8000-00000000000b';
  const M1 = '0191a8f0-0000-7000-8000-0000000000e1';
  const M2 = '0191a8f0-0000-7000-8000-0000000000e2';
  const line = (menuItemId: string, qty: number, modifierOptionIds: string[] = []) => ({
    menuItemId,
    qty,
    modifierOptionIds,
  });

  test('same dishes, quantities and options, in any order', () => {
    expect(isDuplicateCart([line(A, 1), line(B, 2)], [line(B, 2), line(A, 1)])).toBe(true);
    expect(isDuplicateCart([line(A, 1, [M1, M2])], [line(A, 1, [M2, M1])])).toBe(true);
  });

  test('a different quantity, option or dish is not a duplicate', () => {
    expect(isDuplicateCart([line(A, 1)], [line(A, 2)])).toBe(false);
    expect(isDuplicateCart([line(A, 1, [M1])], [line(A, 1)])).toBe(false);
    expect(isDuplicateCart([line(A, 1)], [line(B, 1)])).toBe(false);
    expect(isDuplicateCart([line(A, 1)], [line(A, 1), line(B, 1)])).toBe(false);
  });

  test('repeated identical lines count as many', () => {
    expect(isDuplicateCart([line(A, 1), line(A, 1)], [line(A, 1)])).toBe(false);
    expect(isDuplicateCart([line(A, 1), line(A, 1)], [line(A, 1), line(A, 1)])).toBe(true);
  });

  test('an empty cart is never a duplicate', () => {
    expect(isDuplicateCart([], [])).toBe(false);
  });
});
