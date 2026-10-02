import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { optionFrame } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import { type CartLine, checkSelection, estimateLineTotal, priceCart } from './cart-pricing.ts';

function state() {
  const store = createEntityStore();
  seedMenu(store);
  return { store, get: () => store.getState() };
}

const line = (
  key: string,
  itemId: string,
  optionIds: string[] = [],
  qty = 1,
  note = '',
): CartLine => ({
  key,
  itemId,
  qty,
  optionIds,
  note,
});

describe('priceCart (a running ESTIMATE from the shared pricing rules; the server decides the total)', () => {
  test('prices a dish with options and a quantity exactly as the server does', () => {
    const { get } = state();
    // ก๋วยเตี๋ยวต้มยำ ฿50 + ไข่ ฿10 = ฿60 each, two of them.
    const result = priceCart(get(), [line('a', MENU.tomYum, [MENU.thin, MENU.mild, MENU.egg], 2)]);
    expect(result.valid).toBe(true);
    expect(result.lines[0]).toMatchObject({
      key: 'a',
      ok: true,
      unitPriceSatang: 5000,
      lineTotalSatang: 12000,
    });
    expect(result.totalSatang).toBe(12000);
    expect(result.itemCount).toBe(2);
  });

  test('adds several lines', () => {
    const { get } = state();
    const result = priceCart(get(), [
      line('a', MENU.tomYum, [MENU.wide, MENU.hot, MENU.meatball, MENU.special], 1),
      line('b', MENU.tea, [], 3),
    ]);
    expect(result.valid).toBe(true);
    expect(result.totalSatang).toBe(5000 + 1500 + 1000 + 3 * 2500);
    expect(result.itemCount).toBe(4);
  });

  test('uses the channel price', () => {
    const { get } = state();
    expect(priceCart(get(), [line('a', MENU.water)], 'storefront').totalSatang).toBe(2000);
    expect(priceCart(get(), [line('a', MENU.water)], 'line').totalSatang).toBe(2500);
  });

  test('an empty cart is a valid zero', () => {
    const { get } = state();
    expect(priceCart(get(), [])).toMatchObject({ valid: true, totalSatang: 0, itemCount: 0 });
  });

  test('a missing required choice marks that line, and the total leaves it out', () => {
    const { get } = state();
    const result = priceCart(get(), [line('a', MENU.tomYum, [MENU.thin]), line('b', MENU.tea)]);
    expect(result.valid).toBe(false);
    expect(result.lines[0]).toMatchObject({ ok: false });
    expect(result.lines[0]?.errors).toEqual([{ code: 'GROUP_TOO_FEW', groupId: MENU.gSpice }]);
    expect(result.totalSatang).toBe(2500);
  });

  test('too many choices in a group is refused', () => {
    const { get } = state();
    const result = priceCart(get(), [
      line('a', MENU.tomYum, [MENU.thin, MENU.mild, MENU.egg, MENU.meatball, MENU.special]),
    ]);
    expect(result.valid).toBe(false);
    expect(result.lines[0]?.errors[0]?.code).toBe('GROUP_TOO_MANY');
  });

  test('a dish that went sold out after it was added is flagged, not silently priced', () => {
    const { get } = state();
    const result = priceCart(get(), [line('a', MENU.seafood)]);
    expect(result.valid).toBe(false);
    expect(result.lines[0]?.errors[0]?.code).toBe('ITEM_UNAVAILABLE');
    expect(result.totalSatang).toBe(0);
  });

  test('an option that went sold out after it was chosen is flagged', () => {
    const { store, get } = state();
    store.apply(optionFrame(MENU.egg, MENU.gExtra, 900, { isAvailable: false }));
    const result = priceCart(get(), [line('a', MENU.tomYum, [MENU.thin, MENU.mild, MENU.egg])]);
    expect(result.lines[0]?.errors[0]?.code).toBe('OPTION_UNAVAILABLE');
  });

  test('a dish that is not on the menu any more is flagged', () => {
    const { get } = state();
    const result = priceCart(get(), [line('a', MENU.secret)]);
    expect(result.valid).toBe(false);
  });
});

describe('checkSelection (can this dish be added with these choices?)', () => {
  test('ok when every required group is chosen', () => {
    const { get } = state();
    expect(checkSelection(get(), MENU.tomYum, [MENU.thin, MENU.mild])).toEqual({
      ok: true,
      missingGroupIds: [],
    });
  });

  test('lists the required groups still to choose', () => {
    const { get } = state();
    expect(checkSelection(get(), MENU.tomYum, [])).toEqual({
      ok: false,
      missingGroupIds: [MENU.gNoodle, MENU.gSpice],
    });
    expect(checkSelection(get(), MENU.tomYum, [MENU.wide])).toEqual({
      ok: false,
      missingGroupIds: [MENU.gSpice],
    });
  });

  test('a dish with no groups is always ok', () => {
    const { get } = state();
    expect(checkSelection(get(), MENU.tea, [])).toEqual({ ok: true, missingGroupIds: [] });
  });

  test('any other problem is not ok but names no group', () => {
    const { get } = state();
    expect(checkSelection(get(), MENU.seafood, [])).toEqual({ ok: false, missingGroupIds: [] });
  });
});

describe('estimateLineTotal (the sheet button, before every required choice is made)', () => {
  test('prices the dish and the choices made so far, for the quantity', () => {
    const { get } = state();
    expect(estimateLineTotal(get(), { itemId: MENU.tomYum, optionIds: [], qty: 2 })).toBe(10000);
    expect(
      estimateLineTotal(get(), {
        itemId: MENU.tomYum,
        optionIds: [MENU.egg, MENU.meatball],
        qty: 2,
      }),
    ).toBe(2 * (5000 + 1000 + 1500));
  });

  test('uses the channel price and ignores unknown choices', () => {
    const { get } = state();
    expect(estimateLineTotal(get(), { itemId: MENU.water, optionIds: [], qty: 1 }, 'line')).toBe(
      2500,
    );
    expect(estimateLineTotal(get(), { itemId: MENU.tea, optionIds: ['nope'], qty: 1 })).toBe(2500);
  });

  test('an unknown dish is 0', () => {
    const { get } = state();
    expect(estimateLineTotal(get(), { itemId: 'nope', optionIds: [], qty: 1 })).toBe(0);
  });
});
