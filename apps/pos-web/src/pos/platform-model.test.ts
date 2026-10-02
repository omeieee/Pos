import { describe, expect, test } from 'vitest';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  duplicatePlatformRef,
  isPlatformChannel,
  PLATFORM_NOTE_MAX,
  platformNote,
  platformRefSchema,
} from './platform-model.ts';

describe('the platform order reference', () => {
  test('is trimmed, not empty and not longer than 40 characters', () => {
    expect(platformRefSchema.parse('  GF-1234 ')).toBe('GF-1234');
    expect(platformRefSchema.safeParse('   ').success).toBe(false);
    expect(platformRefSchema.safeParse('x'.repeat(41)).success).toBe(false);
    expect(platformRefSchema.safeParse('x'.repeat(40)).success).toBe(true);
  });

  test('has no line breaks or control characters', () => {
    expect(platformRefSchema.safeParse('GF\n12').success).toBe(false);
  });
});

describe('the note that carries it (the order has no reference field yet)', () => {
  test('names the platform and the reference, then the kitchen note', () => {
    expect(platformNote('grab', 'GF-12', '')).toBe('GRAB GF-12');
    expect(platformNote('lineman', ' 7788 ', ' ไม่เผ็ด ')).toBe('LINE MAN 7788 · ไม่เผ็ด');
  });

  test('leaves room for the kitchen note inside the 500 characters the order allows', () => {
    const longest = platformNote('lineman', 'x'.repeat(40), 'y'.repeat(PLATFORM_NOTE_MAX));
    expect(longest.length).toBeLessThanOrEqual(500);
  });
});

describe('keying the same platform order twice', () => {
  const orders = [
    orderDto(uuid(1), 1, { channel: 'grab', note: 'GRAB GF-12 · ไม่เผ็ด' }),
    orderDto(uuid(2), 2, { channel: 'lineman', note: 'LINE MAN 7788' }),
  ];
  test('is found among the orders and the waiting entries', () => {
    expect(duplicatePlatformRef(orders, [], 'grab', 'gf-12')).toBe(true);
    expect(duplicatePlatformRef(orders, [], 'lineman', '7788')).toBe(true);
    expect(duplicatePlatformRef([], [{ channel: 'grab', note: 'GRAB GF-9' }], 'grab', 'GF-9')).toBe(
      true,
    );
  });
  test('is not found for another reference, another platform, or a longer reference', () => {
    expect(duplicatePlatformRef(orders, [], 'grab', 'GF-1')).toBe(false);
    expect(duplicatePlatformRef(orders, [], 'lineman', 'GF-12')).toBe(false);
    expect(duplicatePlatformRef(orders, [], 'grab', 'GF-123')).toBe(false);
  });
});

describe('the platform channels', () => {
  test('are Grab and LINE MAN only', () => {
    expect(isPlatformChannel('grab')).toBe(true);
    expect(isPlatformChannel('lineman')).toBe(true);
    expect(isPlatformChannel('storefront')).toBe(false);
  });
});
