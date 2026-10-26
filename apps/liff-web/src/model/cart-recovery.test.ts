/**
 * LINE-02: a dish that goes หมด while the customer is at checkout. The server names the failed
 * lines (ORDER_INVALID `details.errors[].lineIndex`); the app shows them with a remove action, and
 * the cart survives closing and reopening the app.
 */
import type { PublicMenuResponse } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import type { Cart } from './cart.ts';
import {
  CART_MAX_AGE_MS,
  parseStoredCart,
  readStoredCart,
  removeLines,
  serializeCart,
  storeCart,
  unavailableLines,
} from './cart-recovery.ts';

const ids = (n: number) => `0191a8f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOODLES = ids(1);
const WATER = ids(2);
const EGG = ids(12);

const item = (id: string, nameTh: string) => ({
  id,
  nameTh,
  nameEn: null,
  descriptionTh: null,
  descriptionEn: null,
  priceSatang: 5000,
  imageUrl: null,
  modifierGroups: [],
});
const menuWith = (...items: ReturnType<typeof item>[]) =>
  ({
    channel: 'line',
    categories: [{ id: ids(100), nameTh: 'หมวด', nameEn: null, items }],
  }) as unknown as PublicMenuResponse;

const cart: Cart = [
  { key: 'a', menuItemId: NOODLES, qty: 2, optionIds: [EGG], note: 'ไม่ใส่ผัก' },
  { key: 'b', menuItemId: WATER, qty: 1, optionIds: [], note: '' },
];

describe('unavailableLines', () => {
  test("the server's failed line (by index) is named from the menu the customer saw", () => {
    const seen = menuWith(item(NOODLES, 'ก๋วยเตี๋ยว'), item(WATER, 'น้ำเปล่า'));
    const failed = unavailableLines(cart, seen, [
      { code: 'ITEM_UNAVAILABLE', lineIndex: 1, menuItemId: WATER },
    ]);
    expect(failed).toEqual([
      { key: 'b', qty: 1, name: { nameTh: 'น้ำเปล่า', nameEn: null }, code: 'ITEM_UNAVAILABLE' },
    ]);
  });

  test('a line no longer on the (refreshed) menu is listed too, with the name already known', () => {
    const fresh = menuWith(item(NOODLES, 'ก๋วยเตี๋ยว'));
    const known = [
      {
        key: 'b',
        qty: 1,
        name: { nameTh: 'น้ำเปล่า', nameEn: null },
        code: 'ITEM_UNAVAILABLE',
      },
    ];
    expect(unavailableLines(cart, fresh, [], known)).toEqual(known);
    // Reopened later: nothing known, so no name (the screen says "a dish no longer available").
    expect(unavailableLines(cart, fresh, [])).toEqual([
      { key: 'b', qty: 1, name: null, code: 'ITEM_UNAVAILABLE' },
    ]);
  });

  test('an index that does not match the cart, or a menu id that differs, is ignored', () => {
    const seen = menuWith(item(NOODLES, 'ก๋วยเตี๋ยว'), item(WATER, 'น้ำเปล่า'));
    expect(
      unavailableLines(cart, seen, [
        { code: 'ITEM_UNAVAILABLE', lineIndex: 7, menuItemId: WATER },
        { code: 'ITEM_UNAVAILABLE', lineIndex: 0, menuItemId: WATER },
      ]),
    ).toEqual([]);
  });

  test('an option that went หมด names its line once, even with two errors on it', () => {
    const seen = menuWith(item(NOODLES, 'ก๋วยเตี๋ยว'), item(WATER, 'น้ำเปล่า'));
    const failed = unavailableLines(cart, seen, [
      { code: 'OPTION_UNAVAILABLE', lineIndex: 0, menuItemId: NOODLES },
      { code: 'GROUP_TOO_FEW', lineIndex: 0, menuItemId: NOODLES },
    ]);
    expect(failed.map((l) => l.key)).toEqual(['a']);
  });

  test('removeLines drops exactly those lines', () => {
    expect(removeLines(cart, ['b']).map((l) => l.key)).toEqual(['a']);
    expect(removeLines(cart, [])).toEqual(cart);
  });
});

describe('the cart kept across reopening', () => {
  const now = new Date('2026-10-26T08:00:00Z');

  test('round-trips the lines, and nothing else', () => {
    const raw = serializeCart(cart, now);
    expect(Object.keys(JSON.parse(raw))).toEqual(['v', 'savedAt', 'lines']);
    expect(parseStoredCart(raw, now)).toEqual(cart);
  });

  test('an old, broken or foreign value gives an empty cart', () => {
    const later = new Date(now.getTime() + CART_MAX_AGE_MS + 1);
    expect(parseStoredCart(serializeCart(cart, now), later)).toEqual([]);
    expect(parseStoredCart(null, now)).toEqual([]);
    expect(parseStoredCart('not json', now)).toEqual([]);
    expect(parseStoredCart('{"v":2,"savedAt":0,"lines":[]}', now)).toEqual([]);
    const bad = JSON.stringify({
      v: 1,
      savedAt: now.getTime(),
      lines: [{ key: 'x', menuItemId: NOODLES, qty: 0, optionIds: [], note: '' }],
    });
    expect(parseStoredCart(bad, now)).toEqual([]);
    const price = JSON.stringify({
      v: 1,
      savedAt: now.getTime(),
      lines: [{ ...cart[0], priceSatang: 1 }],
    });
    // Extra fields (a price) are never carried into the cart.
    expect(parseStoredCart(price, now)).toEqual([cart[0]]);
  });

  test('storage that throws (private mode, blocked) never breaks the app', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredCart(throwing, now)).toEqual([]);
    expect(() => storeCart(throwing, cart, now)).not.toThrow();
    expect(() => storeCart(throwing, [], now)).not.toThrow();
    expect(readStoredCart(undefined, now)).toEqual([]);
  });

  test('an empty cart removes the stored one', () => {
    const box = new Map<string, string>();
    const storage = {
      getItem: (k: string) => box.get(k) ?? null,
      setItem: (k: string, v: string) => void box.set(k, v),
      removeItem: (k: string) => void box.delete(k),
    };
    storeCart(storage, cart, now);
    expect(readStoredCart(storage, now)).toEqual(cart);
    storeCart(storage, [], now);
    expect(box.size).toBe(0);
  });
});
