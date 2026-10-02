import { describe, expect, test } from 'vitest';
import {
  allowedFulfillments,
  buildingNameSchema,
  deliveryNoteSchema,
  recipientDtoSchema,
  recipientKey,
  recipientNameSchema,
  recipientsQuerySchema,
} from './delivery.ts';
import { FULFILLMENTS, ORDER_CHANNELS } from './enums.ts';
import { createOrderInputSchema } from './schemas.ts';

// Made-up names only: no real customer data in tests.
const NAME = 'Test Recipient';

describe('recipient fields', () => {
  test('a name is trimmed and 1 to 60 characters', () => {
    expect(recipientNameSchema.parse(`  ${NAME}  `)).toBe(NAME);
    expect(recipientNameSchema.safeParse('').success).toBe(false);
    expect(recipientNameSchema.safeParse('   ').success).toBe(false);
    expect(recipientNameSchema.safeParse('x'.repeat(60)).success).toBe(true);
    expect(recipientNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });

  test('a note is trimmed and 0 to 200 characters (empty is allowed)', () => {
    expect(deliveryNoteSchema.parse('  ห้อง 12  ')).toBe('ห้อง 12');
    expect(deliveryNoteSchema.parse('   ')).toBe('');
    expect(deliveryNoteSchema.safeParse('x'.repeat(200)).success).toBe(true);
    expect(deliveryNoteSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  test('a building is trimmed and 1 to 10 characters', () => {
    expect(buildingNameSchema.parse(' B1 ')).toBe('B1');
    expect(buildingNameSchema.safeParse('').success).toBe(false);
    expect(buildingNameSchema.safeParse('x'.repeat(11)).success).toBe(false);
  });

  test('the lookup key ignores case, surrounding spaces and repeated spaces', () => {
    expect(recipientKey('  Test   RECIPIENT ')).toBe('test recipient');
    expect(recipientKey(NAME)).toBe(recipientKey('test recipient'));
    expect(recipientKey('Test\tRecipient')).toBe('test recipient');
  });

  test('the lookup key treats equivalent Unicode forms as the same name', () => {
    // "é" as one code point and as "e" + combining accent
    expect(recipientKey('Café')).toBe(recipientKey('Café'));
    // Thai text has no case and is kept as typed (after the same clean-up)
    expect(recipientKey('  ฟ้า  ใส ')).toBe('ฟ้า ใส');
  });

  test('different names have different keys', () => {
    expect(recipientKey('Test A')).not.toBe(recipientKey('Test B'));
  });
});

describe('recipientsQuerySchema', () => {
  test('defaults the limit to 8, allows up to 20, and coerces the query string', () => {
    expect(recipientsQuerySchema.parse({}).limit).toBe(8);
    expect(recipientsQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    expect(recipientsQuerySchema.safeParse({ limit: '21' }).success).toBe(false);
    expect(recipientsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(recipientsQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });

  test('trims the search text and the building; refuses an overlong search', () => {
    expect(recipientsQuerySchema.parse({ q: '  Fa ', building: ' B1 ' })).toMatchObject({
      q: 'Fa',
      building: 'B1',
    });
    expect(recipientsQuerySchema.safeParse({ q: 'x'.repeat(61) }).success).toBe(false);
  });
});

describe('recipientDtoSchema', () => {
  test('carries exactly five fields and drops anything else', () => {
    const parsed = recipientDtoSchema.parse({
      id: '0192f3a0-0000-7000-8000-000000000001',
      building: 'B1',
      recipientName: NAME,
      deliveryNote: null,
      lastOrderAt: '2026-10-02T03:00:00.000Z',
      phone: '0800000000',
      lineUserId: 'U-test',
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ['building', 'deliveryNote', 'id', 'lastOrderAt', 'recipientName'].sort(),
    );
  });
});

describe('createOrderInputSchema: entrance delivery', () => {
  const uuid = '0192f3a0-0000-7000-8000-000000000001';
  const base = {
    clientRequestId: uuid,
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: NAME,
    items: [{ menuItemId: uuid, qty: 1 }],
  };

  test('takes the building, the name and an optional note, trimmed', () => {
    const parsed = createOrderInputSchema.parse({
      ...base,
      recipientName: `  ${NAME} `,
      deliveryNote: ' ถือป้ายสีฟ้า ',
    });
    expect(parsed).toMatchObject({
      deliveryBuilding: 'B1',
      recipientName: NAME,
      deliveryNote: 'ถือป้ายสีฟ้า',
    });
    expect(createOrderInputSchema.parse(base).deliveryNote).toBeUndefined();
  });

  test('needs both the building and the name', () => {
    const { deliveryBuilding: _b, ...noBuilding } = base;
    const { recipientName: _n, ...noName } = base;
    expect(createOrderInputSchema.safeParse(noBuilding).success).toBe(false);
    expect(createOrderInputSchema.safeParse(noName).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...base, recipientName: '  ' }).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...base, deliveryBuilding: ' ' }).success).toBe(
      false,
    );
  });

  test('refuses a name over 60 characters and a note over 200', () => {
    expect(
      createOrderInputSchema.safeParse({ ...base, recipientName: 'x'.repeat(61) }).success,
    ).toBe(false);
    expect(
      createOrderInputSchema.safeParse({ ...base, deliveryNote: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  test('the room number is not needed', () => {
    expect(createOrderInputSchema.safeParse(base).success).toBe(true);
  });

  test('recipient fields on any other fulfilment are refused, not dropped', () => {
    for (const fulfillment of ['platform_delivery', 'takeaway'] as const) {
      const res = createOrderInputSchema.safeParse({ ...base, fulfillment });
      expect(res.success, fulfillment).toBe(false);
    }
    expect(
      createOrderInputSchema.safeParse({
        ...base,
        channel: 'grab',
        fulfillment: 'platform_delivery',
        deliveryBuilding: undefined,
        recipientName: undefined,
      }).success,
    ).toBe(true);
  });
});

describe('allowedFulfillments (owner, 2026-10-02: delivery to the building entrance only)', () => {
  test.each(['storefront', 'line', 'phone'] as const)(
    '%s orders go to the building entrance and nothing else',
    (channel) => {
      expect(allowedFulfillments(channel)).toEqual(['entrance_delivery']);
    },
  );

  test.each(['grab', 'lineman'] as const)('%s orders are delivered by the platform', (channel) => {
    expect(allowedFulfillments(channel)).toEqual(['platform_delivery']);
  });

  test('every channel has exactly one way to be served, and it is a known fulfilment', () => {
    for (const channel of ORDER_CHANNELS) {
      const allowed = allowedFulfillments(channel);
      expect(allowed).toHaveLength(1);
      expect(FULFILLMENTS).toContain(allowed[0]);
    }
  });

  test('the old counter fulfilments are never offered, but stay valid values for history', () => {
    for (const channel of ORDER_CHANNELS) {
      for (const legacy of ['dine_in', 'takeaway', 'pickup', 'room_delivery'] as const) {
        expect(allowedFulfillments(channel)).not.toContain(legacy);
        expect(FULFILLMENTS).toContain(legacy);
      }
    }
  });
});
