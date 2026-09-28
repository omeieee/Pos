import { describe, expect, test } from 'vitest';
import { businessDate } from './business-date.ts';

describe('businessDate (Asia/Bangkok, UTC+7, default cutoff 04:00)', () => {
  test.each([
    // [UTC instant, Bangkok local, expected business date]
    ['2026-09-29T04:00:00Z', '11:00 on 29 Sep', '2026-09-29'],
    ['2026-09-29T16:59:59Z', '23:59:59 on 29 Sep', '2026-09-29'],
    ['2026-09-29T17:00:00Z', '00:00 on 30 Sep', '2026-09-29'],
    ['2026-09-29T20:59:59Z', '03:59:59 on 30 Sep', '2026-09-29'],
    ['2026-09-29T21:00:00Z', '04:00 on 30 Sep', '2026-09-30'],
    ['2026-12-31T20:30:00Z', '03:30 on 1 Jan', '2026-12-31'],
  ])('%s (%s) → %s', (utc, _local, expected) => {
    expect(businessDate(new Date(utc))).toBe(expected);
  });

  test('cutoff 0 uses the plain local date', () => {
    expect(businessDate(new Date('2026-09-29T17:00:00Z'), 0)).toBe('2026-09-30');
    expect(businessDate(new Date('2026-09-29T16:59:59Z'), 0)).toBe('2026-09-29');
  });

  test('a custom cutoff (02:00)', () => {
    expect(businessDate(new Date('2026-09-29T18:59:59Z'), 120)).toBe('2026-09-29');
    expect(businessDate(new Date('2026-09-29T19:00:00Z'), 120)).toBe('2026-09-30');
  });

  test.each([-1, 1440, 1.5])('rejects cutoff %s', (cutoff) => {
    expect(() => businessDate(new Date(), cutoff)).toThrow(RangeError);
  });

  test('rejects an invalid date', () => {
    expect(() => businessDate(new Date('nope'))).toThrow(RangeError);
  });
});
