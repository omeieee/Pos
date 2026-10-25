import type { AppOpenOrder } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import type { Cart } from './cart.ts';
import {
  cancelReasonView,
  cartFromOrder,
  checkoutWarning,
  mergedItems,
  openOrderFor,
  orderNoList,
  startEditSession,
} from './open-orders.ts';

const DISH = '0191a8f0-0000-7000-8000-000000000001';
const OTHER = '0191a8f0-0000-7000-8000-000000000002';
const OPT = '0191a8f0-0000-7000-8000-000000000011';

const orderLine = (menuItemId: string, qty = 1, note?: string) => ({
  menuItemId,
  nameTh: 'จาน',
  nameEn: null,
  qty,
  modifierOptionIds: [OPT],
  ...(note === undefined ? {} : { note }),
});

function open(over: Partial<AppOpenOrder> = {}): AppOpenOrder {
  return {
    id: '0191a8f0-0000-7000-8000-0000000000a1',
    orderNo: 'L-001',
    totalSatang: 5000,
    version: 2,
    businessDate: '2030-10-15',
    deliveryBuilding: 'A1',
    recipientName: 'คุณตัวอย่าง',
    placedAt: '2030-10-15T05:00:00.000Z',
    items: [orderLine(DISH)],
    ...over,
  };
}
const line = (menuItemId: string, qty: number, note = ''): Cart[number] => ({
  key: `${menuItemId}|${OPT}|${note}`,
  menuItemId,
  qty,
  optionIds: [OPT],
  note,
});
const form = { building: 'A1', name: 'คุณตัวอย่าง' };

describe('checkoutWarning', () => {
  test('no open order, no warning', () => {
    expect(checkoutWarning([], [line(DISH, 1)], form)).toBeNull();
  });

  test('other dishes: a normal warning, mergeable with the same name and building', () => {
    const w = checkoutWarning([open()], [line(OTHER, 1)], form);
    expect(w).toMatchObject({ duplicate: false, canMerge: true });
    expect(w?.order.orderNo).toBe('L-001');
  });

  test('the same dishes make it a duplicate, whatever the note', () => {
    expect(checkoutWarning([open()], [line(DISH, 1, 'ไม่เผ็ด')], form)?.duplicate).toBe(true);
    expect(checkoutWarning([open()], [line(DISH, 2)], form)?.duplicate).toBe(false);
  });

  test('merge is not offered when the name or building differs (case and spaces ignored)', () => {
    const cart = [line(OTHER, 1)];
    expect(checkoutWarning([open()], cart, { building: 'B2', name: form.name })?.canMerge).toBe(
      false,
    );
    expect(checkoutWarning([open()], cart, { building: 'A1', name: 'คนอื่น' })?.canMerge).toBe(false);
    const somchai = open({ recipientName: 'Somchai' });
    expect(checkoutWarning([somchai], cart, { building: 'a1 ', name: ' SOMCHAI' })?.canMerge).toBe(
      true,
    );
  });

  test('an empty name or building never merges', () => {
    expect(checkoutWarning([open()], [line(OTHER, 1)], { building: '', name: '' })?.canMerge).toBe(
      false,
    );
  });

  test('asks about the same dishes first, then an order it could join, then the newest', () => {
    const newer = open({
      id: '0191a8f0-0000-7000-8000-0000000000a2',
      orderNo: 'L-002',
      placedAt: '2030-10-15T06:00:00.000Z',
      recipientName: 'คนอื่น',
    });
    const older = open({ items: [orderLine(OTHER)] });
    const cart = [line(OTHER, 1)];
    // The older order has the same dishes.
    expect(checkoutWarning([newer, older], cart, form)?.order.orderNo).toBe('L-001');
    // No same dishes: the one the cart could join, even though the other is newer.
    expect(checkoutWarning([newer, open()], cart, form)?.order.orderNo).toBe('L-001');
    // Nothing to join: the newest.
    expect(
      checkoutWarning([newer, open()], cart, { building: 'Z9', name: 'x' })?.order.orderNo,
    ).toBe('L-002');
  });
});

describe('merging lines', () => {
  test('the order lines plus the cart; equal lines add up; notes are kept', () => {
    const o = open({ items: [orderLine(DISH, 1, 'ไม่เผ็ด')] });
    expect(mergedItems(o, [line(DISH, 2, 'ไม่เผ็ด'), line(OTHER, 1)])).toEqual([
      { menuItemId: DISH, qty: 3, modifierOptionIds: [OPT], note: 'ไม่เผ็ด' },
      { menuItemId: OTHER, qty: 1, modifierOptionIds: [OPT] },
    ]);
  });

  test('an order from an older server without notes loads as plain lines', () => {
    expect(cartFromOrder(open())[0]).toMatchObject({
      menuItemId: DISH,
      qty: 1,
      optionIds: [OPT],
      note: '',
    });
  });
});

describe('small helpers', () => {
  test('openOrderFor finds by id', () => {
    expect(openOrderFor([open()], open().id)?.version).toBe(2);
    expect(openOrderFor([open()], 'nope')).toBeUndefined();
  });

  test('orderNoList joins with +', () => {
    expect(orderNoList(['L-001', 'L-002'])).toBe('#L-001 + #L-002');
  });

  test('cancelReasonView', () => {
    expect(cancelReasonView({ cancelReason: 'unpaid_timeout' })).toEqual({ key: 'unpaid_timeout' });
    expect(cancelReasonView({ cancelReason: 'customer_cancel' })).toEqual({
      key: 'customer_cancel',
    });
    expect(cancelReasonView({ cancelReason: 'merged', mergedInto: 'L-004' })).toEqual({
      key: 'merged',
      orderNo: 'L-004',
    });
    expect(cancelReasonView({ cancelReason: 'merged', mergedInto: null })).toEqual({
      key: 'mergedUnknown',
    });
    expect(cancelReasonView({ cancelReason: 'other' })).toBeNull();
    expect(cancelReasonView({})).toBeNull();
  });
});

describe('startEditSession', () => {
  test('the cart becomes the order lines and the old cart is kept to put back', () => {
    const before = [line(OTHER, 3)];
    const { session, cart } = startEditSession(
      open({ items: [orderLine(DISH, 2, 'ไม่เผ็ด')] }),
      before,
    );
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ menuItemId: DISH, qty: 2, note: 'ไม่เผ็ด' });
    expect(session).toMatchObject({ orderNo: 'L-001', version: 2, stash: before });
  });
});
