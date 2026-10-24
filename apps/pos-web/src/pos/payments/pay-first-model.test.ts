import { describe, expect, test } from 'vitest';
import { orderDto, paymentDto, uuid } from '../../test-support/frames.ts';
import {
  awaitingCustomerPayment,
  heldBackFromKitchen,
  isPayFirstOrder,
  needsManualConfirm,
  promptpayOrderIds,
  startPlan,
} from './pay-first-model.ts';

const order = (n: number, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(uuid(n), n, { channel: 'line', ...over });
/** An order from an older server: it carries neither new field, so the device derives them. */
const legacy = (n: number, over: Parameters<typeof orderDto>[2] = {}) =>
  order(n, { paymentMethod: undefined, needsManualConfirm: undefined, ...over });
const pay = (orderN: number, over: Parameters<typeof paymentDto>[3] = {}) =>
  paymentDto(uuid(500 + orderN), uuid(orderN), 1, {
    method: 'promptpay',
    status: 'pending',
    ...over,
  });

describe('which orders pay first (older server: derived from the stored payments)', () => {
  test('a LINE order with a live PromptPay payment does; cash, storefront and platform do not', () => {
    const ids = promptpayOrderIds([
      pay(1),
      pay(2, { method: 'cash' }),
      pay(3, { status: 'claimed' }),
      pay(4),
    ]);
    expect(isPayFirstOrder(legacy(1), ids)).toBe(true);
    expect(isPayFirstOrder(legacy(2), ids)).toBe(false);
    expect(isPayFirstOrder(legacy(3), ids)).toBe(true);
    expect(isPayFirstOrder(legacy(4, { channel: 'storefront' }), ids)).toBe(false);
    expect(isPayFirstOrder(legacy(4, { channel: 'grab' }), ids)).toBe(false);
  });

  test('a cancelled or voided PromptPay payment (the customer changed method) does not count', () => {
    const ids = promptpayOrderIds([
      pay(1, { status: 'cancelled' }),
      pay(2, { status: 'voided' }),
      pay(2, { method: 'cash', status: 'confirmed' }),
    ]);
    expect(isPayFirstOrder(legacy(1), ids)).toBe(false);
    expect(isPayFirstOrder(legacy(2), ids)).toBe(false);
  });

  test('an order without a known payment is not pay-first (the payment has not arrived)', () => {
    expect(isPayFirstOrder(legacy(9), promptpayOrderIds([]))).toBe(false);
  });
});

describe('which orders pay first (the order carries its method)', () => {
  test('the method on the order is trusted first (the kitchen has no payments)', () => {
    const none = promptpayOrderIds([]);
    expect(isPayFirstOrder(order(1, { paymentMethod: 'promptpay' }), none)).toBe(true);
    const withPayment = promptpayOrderIds([pay(1)]);
    expect(isPayFirstOrder(order(1, { paymentMethod: 'cash' }), withPayment)).toBe(false);
  });

  test('a null method from the server means no live payment, whatever the device stored', () => {
    const withPayment = promptpayOrderIds([pay(1)]);
    expect(isPayFirstOrder(order(1, { paymentMethod: null }), withPayment)).toBe(false);
  });

  test('gov co-pay and the storefront are never pay-first by the order field either', () => {
    const none = promptpayOrderIds([]);
    expect(isPayFirstOrder(order(1, { paymentMethod: 'gov_copay' }), none)).toBe(false);
    expect(
      isPayFirstOrder(order(1, { channel: 'storefront', paymentMethod: 'promptpay' }), none),
    ).toBe(false);
  });
});

describe('held back from the kitchen, and the waiting badge', () => {
  const ids = promptpayOrderIds([
    pay(1),
    pay(2, { status: 'claimed' }),
    pay(3, { status: 'confirmed' }),
  ]);

  test('a new unpaid pay-first order is held back and shows the waiting badge', () => {
    const o = legacy(1);
    expect(heldBackFromKitchen(o, ids)).toBe(true);
    expect(awaitingCustomerPayment(o, ids)).toBe(true);
  });

  test('once the customer claimed, it is still held back but the badge gives way', () => {
    const o = legacy(2, { paymentStatus: 'awaiting_confirmation' });
    expect(heldBackFromKitchen(o, ids)).toBe(true);
    expect(awaitingCustomerPayment(o, ids)).toBe(false);
  });

  test('a paid order, or one the server already moved on, is not held back', () => {
    expect(heldBackFromKitchen(legacy(3, { paymentStatus: 'paid' }), ids)).toBe(false);
    expect(heldBackFromKitchen(legacy(1, { status: 'preparing' }), ids)).toBe(false);
  });

  test('with the order fields alone (no payments on the device) the same rules hold', () => {
    const none = promptpayOrderIds([]);
    const o = order(1, { paymentMethod: 'promptpay' });
    expect(heldBackFromKitchen(o, none)).toBe(true);
    expect(awaitingCustomerPayment(o, none)).toBe(true);
    expect(heldBackFromKitchen({ ...o, paymentStatus: 'paid' }, none)).toBe(false);
  });

  test('a LINE cash order is never held back', () => {
    const cash = promptpayOrderIds([pay(7, { method: 'cash' })]);
    expect(heldBackFromKitchen(legacy(7), cash)).toBe(false);
    expect(heldBackFromKitchen(order(7, { paymentMethod: 'cash' }), cash)).toBe(false);
  });
});

describe('the confirm-by-hand icon', () => {
  const base = {
    status: 'new',
    paymentStatus: 'awaiting_confirmation',
    claimWithoutSlip: false,
  } as const;

  test('shows for a claimed payment with a slip that is not confirmed (older server)', () => {
    expect(needsManualConfirm(base)).toBe(true);
    expect(needsManualConfirm({ ...base, status: 'preparing' })).toBe(true);
  });

  test('the server flag is trusted first: true shows, false hides, whatever the claim fields say', () => {
    expect(needsManualConfirm({ ...base, claimWithoutSlip: true, needsManualConfirm: true })).toBe(
      true,
    );
    expect(needsManualConfirm({ ...base, needsManualConfirm: false })).toBe(false);
    expect(
      needsManualConfirm({
        status: 'new',
        paymentStatus: 'awaiting_confirmation',
        needsManualConfirm: true,
      }),
    ).toBe(true);
  });

  test('not for a claim without a slip, nor when the field is unknown (older server)', () => {
    expect(needsManualConfirm({ ...base, claimWithoutSlip: true })).toBe(false);
    expect(needsManualConfirm({ status: 'new', paymentStatus: 'awaiting_confirmation' })).toBe(
      false,
    );
  });

  test('not once paid, not before a claim, not on a cancelled order', () => {
    expect(needsManualConfirm({ ...base, paymentStatus: 'paid' })).toBe(false);
    expect(needsManualConfirm({ ...base, paymentStatus: 'unpaid' })).toBe(false);
    expect(needsManualConfirm({ ...base, status: 'cancelled' })).toBe(false);
    expect(needsManualConfirm({ ...base, status: 'cancelled', needsManualConfirm: true })).toBe(
      false,
    );
  });
});

describe('who may start an unpaid pay-first order (D-38)', () => {
  const ids = promptpayOrderIds([]);
  const held = order(1, { paymentMethod: 'promptpay' });

  test('cashier and kitchen must wait for the payment; manager and owner may override', () => {
    expect(startPlan(held, 'cashier', ids)).toBe('wait');
    expect(startPlan(held, 'kitchen', ids)).toBe('wait');
    expect(startPlan(held, 'manager', ids)).toBe('override');
    expect(startPlan(held, 'owner', ids)).toBe('override');
  });

  test('every other order starts as usual, for every role', () => {
    const others = [
      order(2, { paymentMethod: 'cash' }),
      order(3, { channel: 'storefront', paymentMethod: null }),
      order(4, { paymentMethod: 'promptpay', paymentStatus: 'paid' }),
      order(5, { paymentMethod: 'promptpay', status: 'preparing' }),
      order(6, { paymentMethod: null }),
    ];
    for (const o of others) {
      for (const role of ['cashier', 'kitchen', 'manager', 'owner'] as const) {
        expect(startPlan(o, role, ids), `${o.orderNo} ${role}`).toBe('normal');
      }
    }
  });

  test('a claimed but unconfirmed payment still waits: the shop confirms it, not the cook', () => {
    const claimed = order(1, {
      paymentMethod: 'promptpay',
      paymentStatus: 'awaiting_confirmation',
    });
    expect(startPlan(claimed, 'cashier', ids)).toBe('wait');
    expect(startPlan(claimed, 'manager', ids)).toBe('override');
  });
});
