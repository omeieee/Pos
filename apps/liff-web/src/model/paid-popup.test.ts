import { afterEach, describe, expect, test, vi } from 'vitest';
import { markPaidPopupSeen, paidPopupSeen, shouldShowPaidPopup } from './paid-popup.ts';

const promptpay = { method: 'promptpay' } as never;
const cash = { method: 'cash' } as never;
const paid = { paymentStatus: 'paid' as const, payment: promptpay };

describe('shouldShowPaidPopup', () => {
  test('shows when an open payment turns paid while the page is open', () => {
    for (const prev of ['unpaid', 'awaiting_confirmation', 'partially_paid'] as const) {
      expect(shouldShowPaidPopup(prev, paid, false)).toBe(true);
    }
  });

  test('not on first load of an already-paid order', () => {
    expect(shouldShowPaidPopup(null, paid, false)).toBe(false);
    expect(shouldShowPaidPopup('paid', paid, false)).toBe(false);
  });

  test('only once per payment', () => {
    expect(shouldShowPaidPopup('awaiting_confirmation', paid, true)).toBe(false);
  });

  test('not for cash, a missing payment, an unpaid result or a refund', () => {
    expect(shouldShowPaidPopup('unpaid', { paymentStatus: 'paid', payment: cash }, false)).toBe(
      false,
    );
    expect(shouldShowPaidPopup('unpaid', { paymentStatus: 'paid', payment: null }, false)).toBe(
      false,
    );
    expect(
      shouldShowPaidPopup(
        'unpaid',
        { paymentStatus: 'awaiting_confirmation', payment: promptpay },
        false,
      ),
    ).toBe(false);
    expect(shouldShowPaidPopup('refunded', paid, false)).toBe(false);
  });
});

describe('seen memory', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('remembers a payment in session storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(paidPopupSeen('p1')).toBe(false);
    markPaidPopupSeen('p1');
    expect(paidPopupSeen('p1')).toBe(true);
    expect(paidPopupSeen('p2')).toBe(false);
  });

  test('blocked storage never throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(paidPopupSeen('p1')).toBe(false);
    expect(() => markPaidPopupSeen('p1')).not.toThrow();
  });
});
