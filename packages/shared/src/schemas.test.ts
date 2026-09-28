import { describe, expect, test } from 'vitest';
import {
  businessDaySettingsSchema,
  createOrderInputSchema,
  nonNegativeSatangSchema,
  promptpaySettingsSchema,
  satangSchema,
} from './schemas.ts';

const uuid = '0192f3a0-0000-7000-8000-000000000001';

describe('satangSchema', () => {
  test('accepts integers', () => {
    expect(satangSchema.parse(4550)).toBe(4550);
  });
  test.each([45.5, Number.MAX_SAFE_INTEGER + 2, '4550'])('rejects %j', (v) => {
    expect(satangSchema.safeParse(v).success).toBe(false);
  });
  test('non-negative variant rejects negatives', () => {
    expect(nonNegativeSatangSchema.safeParse(-1).success).toBe(false);
  });
});

describe('promptpaySettingsSchema', () => {
  test.each([
    { idType: 'phone', idValue: '0812345678' },
    { idType: 'national_id', idValue: '1234567890123' },
    { idType: 'ewallet', idValue: '123456789012345' },
  ])('accepts %j', (v) => {
    expect(promptpaySettingsSchema.safeParse(v).success).toBe(true);
  });
  test.each([
    { idType: 'phone', idValue: '812345678' },
    { idType: 'phone', idValue: '081-234-5678' },
    { idType: 'national_id', idValue: '123' },
    { idType: 'bank', idValue: '0812345678' },
  ])('rejects %j', (v) => {
    expect(promptpaySettingsSchema.safeParse(v).success).toBe(false);
  });
});

test('businessDaySettingsSchema', () => {
  expect(
    businessDaySettingsSchema.safeParse({ cutoffMinutes: 240, timeZone: 'Asia/Bangkok' }).success,
  ).toBe(true);
  expect(
    businessDaySettingsSchema.safeParse({ cutoffMinutes: 1440, timeZone: 'Asia/Bangkok' }).success,
  ).toBe(false);
  expect(
    businessDaySettingsSchema.safeParse({ cutoffMinutes: 240, timeZone: 'Mars/Base' }).success,
  ).toBe(false);
});

describe('createOrderInputSchema', () => {
  const base = {
    clientRequestId: uuid,
    channel: 'line',
    fulfillment: 'pickup',
    items: [{ menuItemId: uuid, qty: 2 }],
  };
  test('accepts a minimal order and defaults modifiers to []', () => {
    const parsed = createOrderInputSchema.parse(base);
    expect(parsed.items[0]?.modifierOptionIds).toEqual([]);
  });
  test('room delivery requires a room number', () => {
    expect(
      createOrderInputSchema.safeParse({ ...base, fulfillment: 'room_delivery' }).success,
    ).toBe(false);
    expect(
      createOrderInputSchema.safeParse({ ...base, fulfillment: 'room_delivery', roomNo: '12/345' })
        .success,
    ).toBe(true);
  });
  test('client prices are stripped, never trusted', () => {
    const parsed = createOrderInputSchema.parse({ ...base, total: 1 });
    expect('total' in parsed).toBe(false);
  });
  test.each([
    ['no items', { ...base, items: [] }],
    ['qty 0', { ...base, items: [{ menuItemId: uuid, qty: 0 }] }],
    ['bad channel', { ...base, channel: 'web' }],
    ['bad request id', { ...base, clientRequestId: 'x' }],
  ])('rejects %s', (_label, v) => {
    expect(createOrderInputSchema.safeParse(v).success).toBe(false);
  });
});
