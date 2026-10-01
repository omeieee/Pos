import { describe, expect, test } from 'vitest';
import { satang } from './money.ts';
import {
  type CatalogGroup,
  type CatalogItem,
  type CatalogOption,
  menuChannelFor,
  type OrderLineInput,
  priceOrder,
} from './pricing.ts';

const s = satang;

function option(id: string, over: Partial<CatalogOption> = {}): CatalogOption {
  return {
    id,
    nameTh: `ตัวเลือก ${id}`,
    nameEn: `Option ${id}`,
    priceDeltaSatang: s(0),
    costDeltaSatang: s(0),
    isAvailable: true,
    archived: false,
    ...over,
  };
}

function group(
  id: string,
  options: CatalogOption[],
  over: Partial<CatalogGroup> = {},
): CatalogGroup {
  return {
    id,
    nameTh: `กลุ่ม ${id}`,
    nameEn: `Group ${id}`,
    minSelect: 0,
    maxSelect: 1,
    archived: false,
    options,
    ...over,
  };
}

/** ก๋วยเตี๋ยว ฿50: noodle type is required (1), spice is optional (1), extras up to 3. */
const thin = option('thin');
const wide = option('wide');
const mild = option('mild');
const egg = option('egg', { priceDeltaSatang: s(500), costDeltaSatang: s(300) });
const large = option('large', { priceDeltaSatang: s(1000), costDeltaSatang: s(500) });
const meatballs = option('meatballs', { priceDeltaSatang: s(1000), costDeltaSatang: s(500) });

function noodles(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'noodles',
    nameTh: 'ก๋วยเตี๋ยวต้มยำ',
    nameEn: 'Tom yum noodles',
    priceSatang: s(5000),
    estCostSatang: s(2200),
    isAvailable: true,
    archived: false,
    categoryActive: true,
    channels: ['storefront', 'line', 'grab'],
    channelPrices: { grab: s(6500) },
    groups: [
      group('type', [thin, wide], { minSelect: 1, maxSelect: 1 }),
      group('spice', [mild]),
      group('extras', [egg, large, meatballs], { maxSelect: 3 }),
    ],
    ...over,
  };
}

const water: CatalogItem = {
  id: 'water',
  nameTh: 'น้ำเปล่า',
  nameEn: 'Water',
  priceSatang: s(1000),
  estCostSatang: s(400),
  isAvailable: true,
  archived: false,
  categoryActive: true,
  channels: ['storefront', 'line', 'grab', 'lineman'],
  channelPrices: {},
  groups: [],
};

const catalog = (...items: CatalogItem[]) => new Map(items.map((i) => [i.id, i]));
const line = (over: Partial<OrderLineInput> & { menuItemId: string }): OrderLineInput => ({
  qty: 1,
  modifierOptionIds: [],
  ...over,
});

function ok(result: ReturnType<typeof priceOrder>) {
  if (!result.ok) throw new Error(`expected a priced order, got ${JSON.stringify(result.errors)}`);
  return result;
}
function errors(result: ReturnType<typeof priceOrder>) {
  if (result.ok) throw new Error('expected errors');
  return result.errors.map((e) => `${e.code}:${e.lineIndex}`);
}

describe('menuChannelFor', () => {
  test.each([
    ['storefront', 'storefront'],
    ['line', 'line'],
    ['grab', 'grab'],
    ['lineman', 'lineman'],
    ['phone', 'storefront'],
  ] as const)('order channel %s is priced as menu channel %s', (order, menu) => {
    expect(menuChannelFor(order)).toBe(menu);
  });
});

describe('priceOrder: totals in integer satang', () => {
  test('adds modifier deltas per unit, then multiplies by quantity', () => {
    // (฿50 + ฿5 egg + ฿10 large) × 2 = ฿130
    const result = ok(
      priceOrder(
        'storefront',
        [line({ menuItemId: 'noodles', qty: 2, modifierOptionIds: ['thin', 'egg', 'large'] })],
        catalog(noodles()),
      ),
    );
    expect(result.lines[0]).toMatchObject({
      unitPriceSatang: 5000,
      qty: 2,
      lineTotalSatang: 13000,
    });
    expect(result.totals).toEqual({ subtotal: 13000, discount: 0, total: 13000 });
  });

  test('sums several lines', () => {
    const result = ok(
      priceOrder(
        'storefront',
        [
          line({ menuItemId: 'noodles', modifierOptionIds: ['wide'] }),
          line({ menuItemId: 'water', qty: 3 }),
        ],
        catalog(noodles(), water),
      ),
    );
    expect(result.totals.total).toBe(5000 + 3000);
    expect(Number.isInteger(result.totals.total)).toBe(true);
  });

  test('the largest accepted order stays exact', () => {
    const result = ok(
      priceOrder('storefront', [line({ menuItemId: 'water', qty: 99 })], catalog(water)),
    );
    expect(result.totals.total).toBe(99 * 1000);
  });

  test('uses the Grab price on the Grab channel and the base price elsewhere', () => {
    const noodlesOnly = catalog(noodles());
    const base = [line({ menuItemId: 'noodles', modifierOptionIds: ['thin'] })];
    expect(ok(priceOrder('grab', base, noodlesOnly)).lines[0]?.unitPriceSatang).toBe(6500);
    expect(ok(priceOrder('storefront', base, noodlesOnly)).lines[0]?.unitPriceSatang).toBe(5000);
    expect(ok(priceOrder('line', base, noodlesOnly)).lines[0]?.unitPriceSatang).toBe(5000);
  });

  test('a phone order is priced and checked as a storefront order', () => {
    const item = noodles({ channels: ['storefront'], channelPrices: { storefront: s(5500) } });
    const result = ok(
      priceOrder(
        'phone',
        [line({ menuItemId: 'noodles', modifierOptionIds: ['thin'] })],
        catalog(item),
      ),
    );
    expect(result.lines[0]?.unitPriceSatang).toBe(5500);
  });

  test('modifier prices are not changed by the channel price', () => {
    const result = ok(
      priceOrder(
        'grab',
        [line({ menuItemId: 'noodles', modifierOptionIds: ['thin', 'egg'] })],
        catalog(noodles()),
      ),
    );
    expect(result.lines[0]?.lineTotalSatang).toBe(6500 + 500);
  });
});

describe('priceOrder: what is saved with each line (03 §1 snapshots)', () => {
  test('copies names, base price, cost and modifiers so later menu edits change nothing', () => {
    const result = ok(
      priceOrder(
        'storefront',
        [
          line({
            menuItemId: 'noodles',
            qty: 2,
            modifierOptionIds: ['wide', 'egg'],
            note: 'ไม่ใส่ผัก',
          }),
        ],
        catalog(noodles()),
      ),
    );
    expect(result.lines[0]).toEqual({
      menuItemId: 'noodles',
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      nameEn: 'Tom yum noodles',
      unitPriceSatang: 5000,
      // estimated cost ฿22 + egg cost ฿3
      unitCostSatang: 2500,
      qty: 2,
      modifiers: [
        {
          groupId: 'type',
          optionId: 'wide',
          nameTh: 'ตัวเลือก wide',
          nameEn: 'Option wide',
          priceDeltaSatang: 0,
          costDeltaSatang: 0,
        },
        {
          groupId: 'extras',
          optionId: 'egg',
          nameTh: 'ตัวเลือก egg',
          nameEn: 'Option egg',
          priceDeltaSatang: 500,
          costDeltaSatang: 300,
        },
      ],
      note: 'ไม่ใส่ผัก',
      lineTotalSatang: 2 * 5500,
    });
  });

  test('a line without a note saves null', () => {
    const result = ok(priceOrder('storefront', [line({ menuItemId: 'water' })], catalog(water)));
    expect(result.lines[0]?.note).toBeNull();
  });
});

describe('priceOrder: the menu item', () => {
  test('refuses an item that is not on the menu at all', () => {
    expect(
      errors(priceOrder('storefront', [line({ menuItemId: 'ghost' })], catalog(water))),
    ).toEqual(['UNKNOWN_ITEM:0']);
  });

  test.each([
    ['archived', { archived: true }],
    ['sold out', { isAvailable: false }],
    ['in a deactivated category', { categoryActive: false }],
  ])('refuses an item that is %s', (_label, over) => {
    expect(
      errors(
        priceOrder('storefront', [line({ menuItemId: 'water' })], catalog({ ...water, ...over })),
      ),
    ).toEqual(['ITEM_UNAVAILABLE:0']);
  });

  test('refuses an item that is not offered on the order channel', () => {
    const lineOnly = { ...water, channels: ['line'] as const };
    expect(
      errors(priceOrder('storefront', [line({ menuItemId: 'water' })], catalog(lineOnly))),
    ).toEqual(['ITEM_NOT_ON_CHANNEL:0']);
    expect(
      errors(priceOrder('lineman', [line({ menuItemId: 'water' })], catalog(lineOnly))),
    ).toEqual(['ITEM_NOT_ON_CHANNEL:0']);
    expect(priceOrder('line', [line({ menuItemId: 'water' })], catalog(lineOnly)).ok).toBe(true);
  });
});

describe('priceOrder: modifiers', () => {
  const order = (ids: string[], item = noodles()) =>
    priceOrder(
      'storefront',
      [line({ menuItemId: 'noodles', modifierOptionIds: ids })],
      catalog(item),
    );

  test('a required group needs a choice', () => {
    expect(errors(order([]))).toEqual(['GROUP_TOO_FEW:0']);
    expect(errors(order(['mild']))).toEqual(['GROUP_TOO_FEW:0']);
  });

  test('a group refuses more than its maximum', () => {
    expect(errors(order(['thin', 'wide']))).toEqual(['GROUP_TOO_MANY:0']);
    expect(order(['thin', 'egg', 'large', 'meatballs', 'mild']).ok).toBe(true);
    const four = noodles({
      groups: [
        group('type', [thin, wide], { minSelect: 1, maxSelect: 1 }),
        group('extras', [egg, large, meatballs, option('x')], { maxSelect: 3 }),
      ],
    });
    expect(errors(order(['thin', 'egg', 'large', 'meatballs', 'x'], four))).toEqual([
      'GROUP_TOO_MANY:0',
    ]);
  });

  test('refuses an option that does not belong to this item', () => {
    expect(errors(order(['thin', 'bogus']))).toEqual(['UNKNOWN_OPTION:0']);
    const other = option('foreign');
    const withForeign = catalog(noodles(), { ...water, groups: [group('g', [other])] });
    const result = priceOrder(
      'storefront',
      [line({ menuItemId: 'noodles', modifierOptionIds: ['thin', 'foreign'] })],
      withForeign,
    );
    expect(errors(result)).toEqual(['UNKNOWN_OPTION:0']);
  });

  test.each([
    ['archived', { archived: true }],
    ['sold out', { isAvailable: false }],
  ])('refuses an option that is %s', (_label, over) => {
    const item = noodles({
      groups: [
        group('type', [thin, wide], { minSelect: 1 }),
        group('extras', [{ ...egg, ...over }], { maxSelect: 3 }),
      ],
    });
    expect(errors(order(['thin', 'egg'], item))).toEqual(['OPTION_UNAVAILABLE:0']);
  });

  test('refuses options of an archived group, and does not ask for a choice from it', () => {
    const item = noodles({
      groups: [
        group('type', [thin, wide], { minSelect: 1 }),
        group('old', [mild], { minSelect: 1, archived: true }),
      ],
    });
    expect(errors(order(['thin', 'mild'], item))).toEqual(['OPTION_UNAVAILABLE:0']);
    expect(order(['thin'], item).ok).toBe(true);
  });

  test('refuses the same option twice on one line', () => {
    expect(errors(order(['thin', 'egg', 'egg']))).toEqual(['DUPLICATE_OPTION:0']);
  });

  test('reports every problem on every line, with the line number', () => {
    const result = priceOrder(
      'storefront',
      [
        line({ menuItemId: 'noodles', modifierOptionIds: [] }),
        line({ menuItemId: 'water' }),
        line({ menuItemId: 'ghost' }),
      ],
      catalog(noodles(), water),
    );
    expect(errors(result)).toEqual(['GROUP_TOO_FEW:0', 'UNKNOWN_ITEM:2']);
  });
});

describe('priceOrder: bad prices in the menu', () => {
  test('a discount modifier larger than the price is refused, not turned into a negative total', () => {
    const item = noodles({
      groups: [
        group('type', [thin], { minSelect: 1 }),
        group('promo', [option('promo', { priceDeltaSatang: s(-6000) })]),
      ],
    });
    const result = priceOrder(
      'storefront',
      [line({ menuItemId: 'noodles', modifierOptionIds: ['thin', 'promo'] })],
      catalog(item),
    );
    expect(errors(result)).toEqual(['INVALID_PRICE:0']);
  });
});
