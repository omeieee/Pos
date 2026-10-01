import { describe, expect, test } from 'vitest';
import {
  availabilityInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  itemDtoSchema,
  patchItemInputSchema,
  publicMenuQuerySchema,
  publicMenuResponseSchema,
} from './menu.ts';

const uuid = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const item = {
  categoryId: uuid(1),
  nameTh: 'ก๋วยเตี๋ยวต้มยำ',
  priceSatang: 5000,
  channels: ['storefront', 'line'],
};

describe('createItemInputSchema', () => {
  test('a name, a category, a price in satang and the channels are enough', () => {
    const parsed = createItemInputSchema.parse(item);
    expect(parsed).toMatchObject({
      priceSatang: 5000,
      estCostSatang: 0,
      isAvailable: true,
      sort: 0,
    });
  });

  test('prices are whole satang, never negative', () => {
    for (const priceSatang of [50.5, -1, '5000', Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        createItemInputSchema.safeParse({ ...item, priceSatang }).success,
        String(priceSatang),
      ).toBe(false);
    }
  });

  test('needs at least one channel, and only the known ones', () => {
    expect(createItemInputSchema.safeParse({ ...item, channels: [] }).success).toBe(false);
    expect(createItemInputSchema.safeParse({ ...item, channels: ['phone'] }).success).toBe(false);
    expect(
      createItemInputSchema.safeParse({ ...item, channels: ['storefront', 'storefront'] }).success,
    ).toBe(false);
  });

  test('channel prices only for known channels, in satang', () => {
    expect(
      createItemInputSchema.safeParse({ ...item, channelPrices: { grab: 6500 } }).success,
    ).toBe(true);
    expect(
      createItemInputSchema.safeParse({ ...item, channelPrices: { phone: 6500 } }).success,
    ).toBe(false);
    expect(
      createItemInputSchema.safeParse({ ...item, channelPrices: { grab: 65.5 } }).success,
    ).toBe(false);
  });

  test('the photo is an https URL, nothing else', () => {
    expect(
      createItemInputSchema.safeParse({ ...item, imageUrl: 'https://img.example.test/a.jpg' })
        .success,
    ).toBe(true);
    for (const imageUrl of [
      'http://img.example.test/a.jpg',
      'javascript:alert(1)',
      'a.jpg',
      'data:image/png;base64,AAA',
    ]) {
      expect(createItemInputSchema.safeParse({ ...item, imageUrl }).success, imageUrl).toBe(false);
    }
  });

  test('refuses duplicate group ids and unknown fields (such as an id or a rev)', () => {
    expect(
      createItemInputSchema.safeParse({ ...item, modifierGroupIds: [uuid(2), uuid(2)] }).success,
    ).toBe(false);
    expect(createItemInputSchema.safeParse({ ...item, rev: 5 }).success).toBe(false);
  });
});

describe('patchItemInputSchema', () => {
  test('needs the version and a field; can archive and restore', () => {
    expect(patchItemInputSchema.safeParse({ expectedVersion: 1, priceSatang: 5500 }).success).toBe(
      true,
    );
    expect(patchItemInputSchema.safeParse({ expectedVersion: 1, archived: true }).success).toBe(
      true,
    );
    expect(patchItemInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(patchItemInputSchema.safeParse({ priceSatang: 5500 }).success).toBe(false);
    expect(patchItemInputSchema.safeParse({ expectedVersion: 1, priceSatang: -1 }).success).toBe(
      false,
    );
  });
});

describe('modifier groups and options', () => {
  test('a group allows min up to max, and carries optional starting options', () => {
    expect(
      createGroupInputSchema.safeParse({ nameTh: 'เส้น', minSelect: 1, maxSelect: 1 }).success,
    ).toBe(true);
    expect(
      createGroupInputSchema.safeParse({ nameTh: 'เส้น', minSelect: 2, maxSelect: 1 }).success,
    ).toBe(false);
    expect(
      createGroupInputSchema.safeParse({ nameTh: 'เส้น', minSelect: 0, maxSelect: 0 }).success,
    ).toBe(false);
    expect(
      createGroupInputSchema.safeParse({
        nameTh: 'เส้น',
        minSelect: 1,
        maxSelect: 1,
        options: [{ nameTh: 'เส้นเล็ก' }],
      }).success,
    ).toBe(true);
  });

  test('an option may add or take off a few satang; the price change is a whole number', () => {
    expect(createOptionInputSchema.safeParse({ nameTh: 'ไข่', priceDeltaSatang: 500 }).success).toBe(
      true,
    );
    expect(
      createOptionInputSchema.safeParse({ nameTh: 'ลด', priceDeltaSatang: -500 }).success,
    ).toBe(true);
    expect(createOptionInputSchema.safeParse({ nameTh: 'ไข่', priceDeltaSatang: 5.5 }).success).toBe(
      false,
    );
  });
});

describe('availability', () => {
  test('a flag, and an optional version', () => {
    expect(availabilityInputSchema.safeParse({ isAvailable: false }).success).toBe(true);
    expect(
      availabilityInputSchema.safeParse({ isAvailable: false, expectedVersion: 3 }).success,
    ).toBe(true);
    expect(availabilityInputSchema.safeParse({}).success).toBe(false);
    expect(availabilityInputSchema.safeParse({ isAvailable: 'no' }).success).toBe(false);
  });
});

describe('what leaves the server', () => {
  test('no cost field exists in any response shape', () => {
    const keys = JSON.stringify([
      Object.keys(itemDtoSchema.shape),
      Object.keys(publicMenuResponseSchema.shape),
    ]);
    expect(keys).not.toMatch(/cost/i);
  });

  test('the public menu query takes a menu channel, defaulting to the storefront', () => {
    expect(publicMenuQuerySchema.parse({})).toEqual({ channel: 'storefront' });
    expect(publicMenuQuerySchema.parse({ channel: 'grab' })).toEqual({ channel: 'grab' });
    expect(publicMenuQuerySchema.safeParse({ channel: 'phone' }).success).toBe(false);
  });
});
