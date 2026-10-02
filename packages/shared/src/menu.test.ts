import { describe, expect, test } from 'vitest';
import {
  availabilityInputSchema,
  createCategoryInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  itemDtoSchema,
  menuPhotoPath,
  patchItemInputSchema,
  photoQuerySchema,
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

describe('clientRequestId on the create inputs', () => {
  const id = '0192f3a0-0000-7000-8000-0000000000aa';
  test('is an optional UUID on every create input', () => {
    for (const [schema, body] of [
      [createCategoryInputSchema, { nameTh: 'หมวด' }],
      [createItemInputSchema, item],
      [createGroupInputSchema, { nameTh: 'เส้น', minSelect: 1, maxSelect: 1 }],
      [createOptionInputSchema, { nameTh: 'ไข่' }],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, clientRequestId: id }).success).toBe(true);
      expect(schema.safeParse({ ...body, clientRequestId: 'nope' }).success).toBe(false);
    }
  });

  test('an option nested in a new group takes none: the group carries the id', () => {
    expect(
      createGroupInputSchema.safeParse({
        nameTh: 'เส้น',
        minSelect: 1,
        maxSelect: 1,
        options: [{ nameTh: 'เส้นเล็ก', clientRequestId: id }],
      }).success,
    ).toBe(false);
  });

  test('a patch takes none (a PATCH is guarded by expectedVersion)', () => {
    expect(
      patchItemInputSchema.safeParse({ expectedVersion: 1, priceSatang: 1, clientRequestId: id })
        .success,
    ).toBe(false);
  });
});

describe('photo URLs (D-21)', () => {
  test('the path carries the version, so a new photo is a new URL', () => {
    expect(menuPhotoPath(uuid(1), 7)).toBe(`/v1/menu/items/${uuid(1)}/photo?v=7`);
    expect(menuPhotoPath(uuid(1), 8)).not.toBe(menuPhotoPath(uuid(1), 7));
  });

  test('the query takes a positive integer version only', () => {
    expect(photoQuerySchema.parse({ v: '12' })).toEqual({ v: 12 });
    for (const v of ['0', '-1', '1.5', 'abc', '', '99999999999']) {
      expect(photoQuerySchema.safeParse({ v }).success, v).toBe(false);
    }
    expect(photoQuerySchema.safeParse({}).success).toBe(false);
  });

  test('a photo version is optional on a staff item: older clients and rows without a photo parse', () => {
    const base = {
      id: uuid(1),
      categoryId: uuid(2),
      nameTh: 'x',
      nameEn: null,
      descriptionTh: null,
      descriptionEn: null,
      priceSatang: 100,
      imageUrl: null,
      isAvailable: true,
      channels: ['storefront'],
      channelPrices: {},
      modifierGroupIds: [],
      sort: 0,
      archived: false,
      version: 1,
      rev: 1,
    };
    expect(itemDtoSchema.safeParse(base).success).toBe(true);
    expect(itemDtoSchema.safeParse({ ...base, photoVersion: null, photoUrl: null }).success).toBe(
      true,
    );
    expect(
      itemDtoSchema.safeParse({ ...base, photoVersion: 3, photoUrl: menuPhotoPath(uuid(1), 3) })
        .success,
    ).toBe(true);
    expect(itemDtoSchema.safeParse({ ...base, photoVersion: 0 }).success).toBe(false);
  });
});
