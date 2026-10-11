import { type OrderDto, satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  addableItems,
  addMenuLine,
  buildCorrection,
  CORRECTION_CHOICES,
  canCorrectOrder,
  defaultPaymentAction,
  draftFromOrder,
  hasActivePayment,
  hasClaimedPayment,
  removeLine,
  setLineQty,
} from './correction-model.ts';
import type { MenuItemView } from './menu-model.ts';

const line = (n: number, qty = 2) => ({
  id: uuid(n),
  menuItemId: uuid(n + 100),
  nameTh: `จาน ${n}`,
  nameEn: null,
  unitPriceSatang: satang(5000),
  qty,
  modifiers: [],
  note: null,
  lineTotalSatang: satang(5000 * qty),
});

const order = (over: Partial<OrderDto> = {}) =>
  orderDto(uuid(900), 5, {
    status: 'completed',
    paymentStatus: 'paid',
    version: 7,
    note: null,
    items: [line(1), line(2, 1)],
    ...over,
  });

const view = (over: Partial<MenuItemView> = {}): MenuItemView => ({
  id: uuid(300),
  categoryId: uuid(301),
  nameTh: 'ชาเย็น',
  nameEn: null,
  priceSatang: 2500,
  imageUrl: null,
  orderable: true,
  soldOut: false,
  groups: [],
  ...over,
});

describe('who may correct an order', () => {
  test('only the owner, and not an order that is already voided', () => {
    expect(canCorrectOrder('owner', order())).toBe(true);
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      expect(canCorrectOrder(role, order())).toBe(false);
    }
    expect(canCorrectOrder(null, order())).toBe(false);
    expect(canCorrectOrder('owner', order({ status: 'cancelled' }))).toBe(false);
  });
});

describe('a payment that needs a decision', () => {
  test('claimed, partly paid or paid; not unpaid or on a voided order', () => {
    expect(hasActivePayment(order({ paymentStatus: 'awaiting_confirmation' }))).toBe(true);
    expect(hasActivePayment(order({ paymentStatus: 'paid' }))).toBe(true);
    expect(hasActivePayment(order({ paymentStatus: 'unpaid' }))).toBe(false);
    expect(hasActivePayment(order({ status: 'cancelled', paymentStatus: 'paid' }))).toBe(false);
  });
});

describe('the edit draft', () => {
  test('quantity stays between 1 and 99, and the last line cannot be removed', () => {
    const lines = draftFromOrder(order());
    expect(setLineQty(lines, lines[0]?.key ?? '', 0)[0]?.qty).toBe(1);
    expect(setLineQty(lines, lines[0]?.key ?? '', 500)[0]?.qty).toBe(99);
    expect(removeLine(lines, lines[0]?.key ?? '')).toHaveLength(1);
    expect(removeLine(removeLine(lines, lines[0]?.key ?? ''), lines[1]?.key ?? '')).toHaveLength(1);
  });

  test('a dish added twice is one line with two; dishes with a required choice are not offered', () => {
    const tea = view();
    const twice = addMenuLine(addMenuLine([], tea), tea);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ orderItemId: null, menuItemId: tea.id, qty: 2 });
    const needsChoice = view({
      id: uuid(301),
      groups: [
        {
          id: uuid(1),
          nameTh: 'เส้น',
          nameEn: null,
          minSelect: 1,
          maxSelect: 1,
          required: true,
          options: [],
        },
      ],
    });
    expect(addableItems([tea, needsChoice, view({ id: uuid(302), orderable: false })])).toEqual([
      tea,
    ]);
  });
});

describe('the correction request', () => {
  const base = { note: '', reason: 'คีย์ผิด', paymentAction: null } as const;

  test('is nothing while the reason is empty or nothing changed', () => {
    const o = order();
    expect(buildCorrection(o, { ...base, lines: draftFromOrder(o) })).toBeNull();
    const more = setLineQty(draftFromOrder(o), uuid(1), 3);
    expect(buildCorrection(o, { ...base, lines: more, reason: '  ' })).toBeNull();
  });

  test('sends the whole line list with the version, and keeps saved lines as saved ids', () => {
    const o = order();
    const lines = addMenuLine(setLineQty(draftFromOrder(o), uuid(1), 3), view());
    expect(buildCorrection(o, { ...base, lines })).toEqual({
      expectedVersion: 7,
      reason: 'คีย์ผิด',
      items: [
        { orderItemId: uuid(1), qty: 3, note: null },
        { orderItemId: uuid(2), qty: 1, note: null },
        { menuItemId: uuid(300), qty: 1, modifierOptionIds: [] },
      ],
    });
  });

  test('a note-only change sends the note and no items; clearing it sends null', () => {
    const o = order({ note: 'เดิม' });
    const lines = draftFromOrder(o);
    expect(buildCorrection(o, { ...base, lines, note: 'ใหม่' })).toEqual({
      expectedVersion: 7,
      reason: 'คีย์ผิด',
      note: 'ใหม่',
    });
    expect(buildCorrection(o, { ...base, lines, note: ' ' })?.note).toBeNull();
  });

  test('carries the payment choice only while a payment is claimed or confirmed', () => {
    const lines = setLineQty(draftFromOrder(order()), uuid(1), 1);
    expect(
      buildCorrection(order(), { ...base, lines, paymentAction: 'refund' })?.paymentAction,
    ).toBe('refund');
    expect(
      buildCorrection(order({ paymentStatus: 'unpaid' }), {
        ...base,
        lines,
        paymentAction: 'refund',
      }),
    ).not.toHaveProperty('paymentAction');
  });
});

describe('adjusting a paid order', () => {
  const changed = (over: Partial<Parameters<typeof buildCorrection>[1]> = {}) => ({
    lines: draftFromOrder(order()).map((l, i) => (i === 0 ? { ...l, qty: 1 } : l)),
    note: '',
    reason: 'ลดจาน',
    paymentAction: 'adjust' as const,
    ...over,
  });

  test('a claimed payment preselects void, a confirmed one nothing', () => {
    expect(defaultPaymentAction(order({ paymentStatus: 'awaiting_confirmation' }))).toBe('void');
    expect(defaultPaymentAction(order())).toBeNull();
    expect(defaultPaymentAction(order({ paymentStatus: 'partially_paid' }))).toBeNull();
    expect(hasClaimedPayment(order({ paymentStatus: 'awaiting_confirmation' }))).toBe(true);
  });

  test('adjust is offered first', () => {
    expect(CORRECTION_CHOICES).toEqual(['adjust', 'void', 'refund']);
  });

  test('adjust alone sends no refund and never an amount', () => {
    const input = buildCorrection(order(), changed());
    expect(input?.paymentAction).toBe('adjust');
    expect(input).not.toHaveProperty('refund');
  });

  test('a refund method goes with adjust only, trimmed, without an empty note', () => {
    const withRefund = buildCorrection(
      order(),
      changed({ refund: { method: 'cash', referenceNote: '  ' } }),
    );
    expect(withRefund?.refund).toEqual({ method: 'cash' });
    const noted = buildCorrection(
      order(),
      changed({ refund: { method: 'promptpay', referenceNote: ' r1 ' } }),
    );
    expect(noted?.refund).toEqual({ method: 'promptpay', referenceNote: 'r1' });
    const other = buildCorrection(
      order(),
      changed({ paymentAction: 'void', refund: { method: 'cash', referenceNote: '' } }),
    );
    expect(other).not.toHaveProperty('refund');
    expect(
      buildCorrection(order(), changed({ refund: { method: null, referenceNote: '' } })),
    ).not.toHaveProperty('refund');
  });
});
