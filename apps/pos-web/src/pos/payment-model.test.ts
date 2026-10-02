import { type PaymentStatus, satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import {
  govCopayFrame,
  orderDto,
  paymentDto,
  paymentFrame,
  paymentMethodsFrame,
  uuid,
} from '../test-support/frames.ts';
import {
  cashView,
  copayVerdict,
  methodOptions,
  openPayment,
  paymentActions,
  paymentPhase,
  paymentsOf,
  pressKey,
  quickTenders,
  tenderedFromDigits,
} from './payment-model.ts';

const ORDER = uuid(900);
const order = (over: Parameters<typeof orderDto>[2] = {}) => orderDto(ORDER, 10, over);
const pay = (n: number, over: Parameters<typeof paymentDto>[3] = {}) =>
  paymentDto(uuid(500 + n), ORDER, 100 + n, over);

/** 12:00 in Bangkok on a day inside the test scheme (1 Oct - 30 Nov 2030). */
const NOON = Date.parse('2030-10-15T05:00:00Z');

describe('the payments of an order', () => {
  test('are taken from the store, for this order only, oldest first', () => {
    const store = createEntityStore();
    store.apply(paymentFrame(uuid(502), ORDER, 120, { status: 'pending' }));
    store.apply(paymentFrame(uuid(501), ORDER, 110, { status: 'cancelled' }));
    store.apply(paymentFrame(uuid(503), uuid(901), 130, { status: 'confirmed' }));
    expect(paymentsOf(store.getState(), ORDER).map((p) => p.id)).toEqual([uuid(501), uuid(502)]);
  });

  test('the open payment is the pending or claimed one', () => {
    const list = [pay(1, { status: 'cancelled' }), pay(2, { status: 'claimed' })];
    expect(openPayment(list)?.id).toBe(uuid(502));
    expect(openPayment([pay(1, { status: 'confirmed' }), pay(2, { status: 'voided' })])).toBe(
      undefined,
    );
  });
});

describe('what the payment panel shows', () => {
  test('a cancelled order cannot be paid', () => {
    expect(paymentPhase(order({ status: 'cancelled' }), [])).toBe('closed');
  });

  test('an order with nothing to pay says so', () => {
    expect(paymentPhase(order({ totalSatang: satang(0) }), [])).toBe('nothingToPay');
  });

  test('a paid order shows as paid', () => {
    expect(paymentPhase(order({ paymentStatus: 'paid' }), [pay(1)])).toBe('paid');
  });

  test('an open payment, or an order the server says is awaiting confirmation, is "open"', () => {
    expect(paymentPhase(order(), [pay(1, { status: 'pending' })])).toBe('open');
    // The list has not been loaded yet but the order already says a payment was claimed.
    expect(paymentPhase(order({ paymentStatus: 'awaiting_confirmation' }), [])).toBe('open');
  });

  test('an unpaid order, or one whose payment was voided, offers the methods', () => {
    expect(paymentPhase(order(), [])).toBe('choose');
    expect(paymentPhase(order({ paymentStatus: 'unpaid' }), [pay(1, { status: 'voided' })])).toBe(
      'choose',
    );
  });
});

describe('the methods on offer', () => {
  const methodsOf = (
    frames: Parameters<ReturnType<typeof createEntityStore>['apply']>[0][],
    o = order(),
  ) => {
    const store = createEntityStore();
    for (const frame of frames) store.apply(frame);
    return methodOptions(o, store.getState().settings, NOON, new Set());
  };

  test('without any settings, cash and PromptPay are on (the defaults) and co-pay is off with a reason', () => {
    expect(methodsOf([])).toEqual([
      { method: 'cash', enabled: true },
      { method: 'promptpay', enabled: true },
      { method: 'gov_copay', enabled: false, reason: 'notConfigured' },
    ]);
  });

  test('a method the owner switched off is not offered at all', () => {
    const list = methodsOf([paymentMethodsFrame(5, { promptpay: false })]);
    expect(list.map((m) => m.method)).toEqual(['cash', 'gov_copay']);
  });

  test('a method the server refused as disabled is hidden until the next load', () => {
    const store = createEntityStore();
    const list = methodOptions(order(), store.getState().settings, NOON, new Set(['cash']));
    expect(list.map((m) => m.method)).toEqual(['promptpay', 'gov_copay']);
  });

  test('co-pay is on offer inside the scheme for a counter order', () => {
    const list = methodsOf([govCopayFrame(6)]);
    expect(list.find((m) => m.method === 'gov_copay')).toEqual({
      method: 'gov_copay',
      enabled: true,
    });
  });
});

describe('government co-pay availability', () => {
  const scheme = (over = {}) => {
    const store = createEntityStore();
    store.apply(govCopayFrame(6, over));
    const entry = store.getState().settings.get('gov_copay');
    if (!entry || entry.id !== 'gov_copay') throw new Error('no scheme');
    return entry.data;
  };

  test('is available for a storefront order inside the dates and hours', () => {
    expect(copayVerdict(scheme(), order(), NOON)).toEqual({ available: true });
  });

  test('is never offered for room delivery', () => {
    expect(copayVerdict(scheme(), order({ fulfillment: 'room_delivery' }), NOON)).toEqual({
      available: false,
      reason: 'notAtCounter',
    });
  });

  test('is never offered for Grab or LINE MAN orders', () => {
    for (const channel of ['grab', 'lineman'] as const) {
      expect(
        copayVerdict(scheme(), order({ channel, fulfillment: 'platform_delivery' }), NOON),
      ).toEqual({ available: false, reason: 'notAtCounter' });
    }
  });

  test('says "off" when the owner has not enabled the scheme', () => {
    expect(copayVerdict(scheme({ enabled: false }), order(), NOON)).toEqual({
      available: false,
      reason: 'off',
    });
  });

  test('says "outside" before the opening hour, after the closing hour and outside the dates', () => {
    const early = Date.parse('2030-10-14T22:00:00Z'); // 05:00 in Bangkok
    const late = Date.parse('2030-10-15T16:00:00Z'); // 23:00 in Bangkok: closing is excluded
    const before = Date.parse('2030-09-30T05:00:00Z');
    const after = Date.parse('2030-12-01T05:00:00Z');
    for (const at of [early, late, before, after]) {
      expect(copayVerdict(scheme(), order(), at)).toEqual({
        available: false,
        reason: 'outsideWindow',
      });
    }
  });

  test('without a scheme row it is not configured', () => {
    expect(copayVerdict(undefined, order(), NOON)).toEqual({
      available: false,
      reason: 'notConfigured',
    });
  });
});

describe('the cash keypad', () => {
  test('digits build a whole-baht amount; "00" adds two zeros', () => {
    let digits = '';
    for (const key of ['5', '00']) digits = pressKey(digits, key);
    expect(digits).toBe('500');
    expect(tenderedFromDigits(digits)).toBe(50000);
  });

  test('a leading zero is ignored, and backspace and clear work', () => {
    expect(pressKey('', '0')).toBe('');
    expect(pressKey('', '00')).toBe('');
    expect(pressKey('12', 'back')).toBe('1');
    expect(pressKey('', 'back')).toBe('');
    expect(pressKey('123', 'clear')).toBe('');
  });

  test('an amount above the cash limit (฿1,000,000) is not accepted', () => {
    expect(pressKey('1000000', '0')).toBe('1000000');
    expect(pressKey('100000', '0')).toBe('1000000');
    expect(pressKey('999999', '9')).toBe('999999');
  });

  test('nothing typed means no tender', () => {
    expect(tenderedFromDigits('')).toBeNull();
  });

  test('change is the shared cash change: tendered minus the server total', () => {
    expect(cashView(satang(20000), '500')).toEqual({
      tendered: 50000,
      change: 30000,
      shortBy: null,
      canConfirm: true,
    });
  });

  test('an exact tender gives no change', () => {
    expect(cashView(satang(7500), '75')).toMatchObject({ change: 0, canConfirm: true });
  });

  test('a tender below the total blocks confirming and says how much is missing', () => {
    expect(cashView(satang(20000), '150')).toEqual({
      tendered: 15000,
      change: null,
      shortBy: 5000,
      canConfirm: false,
    });
  });

  test('before anything is typed there is nothing to confirm', () => {
    expect(cashView(satang(20000), '')).toEqual({
      tendered: null,
      change: null,
      shortBy: null,
      canConfirm: false,
    });
  });

  test('quick tenders come from the shared suggestion: exact first, then the notes that cover it', () => {
    expect(quickTenders(satang(7500))).toEqual({
      exact: 7500,
      others: [8000, 10000, 50000, 100000],
    });
    expect(quickTenders(satang(100000))).toEqual({ exact: 100000, others: [] });
  });
});

describe('who may do what with a payment', () => {
  const cashier = (status: PaymentStatus) => paymentActions('cashier', pay(1, { status }));

  test('a cashier can claim, confirm and change a pending payment but not void it', () => {
    expect(cashier('pending')).toEqual({
      claim: true,
      confirm: true,
      changeMethod: true,
      cancelClaimed: false,
      voidRefund: false,
    });
  });

  test('a claimed payment can be confirmed or cancelled as "no money found", not changed', () => {
    expect(cashier('claimed')).toEqual({
      claim: false,
      confirm: true,
      changeMethod: false,
      cancelClaimed: true,
      voidRefund: false,
    });
  });

  test('only a manager or the owner may void or refund a confirmed payment', () => {
    expect(paymentActions('cashier', pay(1, { status: 'confirmed' })).voidRefund).toBe(false);
    expect(paymentActions('kitchen', pay(1, { status: 'confirmed' })).voidRefund).toBe(false);
    expect(paymentActions('manager', pay(1, { status: 'confirmed' })).voidRefund).toBe(true);
    expect(paymentActions('owner', pay(1, { status: 'confirmed' })).voidRefund).toBe(true);
  });

  test('the kitchen can do nothing with a payment', () => {
    expect(paymentActions('kitchen', pay(1, { status: 'pending' }))).toEqual({
      claim: false,
      confirm: false,
      changeMethod: false,
      cancelClaimed: false,
      voidRefund: false,
    });
  });

  test('a finished payment offers nothing', () => {
    for (const status of ['cancelled', 'voided', 'refunded'] as const) {
      expect(Object.values(paymentActions('owner', pay(1, { status }))).some(Boolean)).toBe(false);
    }
  });
});
