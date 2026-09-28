import { describe, expect, test } from 'vitest';
import { formatBaht, formatDate } from './format.ts';

describe('formatBaht', () => {
  test.each([
    [0, '฿0.00'],
    [1, '฿0.01'],
    [4550, '฿45.50'],
    [5000, '฿50.00'],
    [125075, '฿1,250.75'],
    [100000000, '฿1,000,000.00'],
    [-1250, '-฿12.50'],
  ])('%i satang → %s', (satang, expected) => {
    expect(formatBaht(satang)).toBe(expected);
    expect(formatBaht(satang, 'en')).toBe(expected);
  });

  test("decimals: 'auto' drops .00 only for whole baht", () => {
    expect(formatBaht(5000, 'th', { decimals: 'auto' })).toBe('฿50');
    expect(formatBaht(4550, 'th', { decimals: 'auto' })).toBe('฿45.50');
    expect(formatBaht(0, 'th', { decimals: 'auto' })).toBe('฿0');
  });

  test('stays exact where float math would drift', () => {
    // 0.1 + 0.2 style inputs: 1,234,567.89 baht must not become ...88.99999
    expect(formatBaht(123456789)).toBe('฿1,234,567.89');
    expect(formatBaht(Number.MAX_SAFE_INTEGER)).toBe('฿90,071,992,547,409.91');
  });

  test('rejects non-integer satang', () => {
    expect(() => formatBaht(12.5)).toThrow(RangeError);
    expect(() => formatBaht(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatDate', () => {
  test('Thai shows the Buddhist Era year, English the Gregorian year', () => {
    const d = '2026-09-29T05:00:00Z';
    expect(formatDate(d, 'th')).toMatch(/2569/);
    expect(formatDate(d, 'th')).not.toMatch(/2026/);
    expect(formatDate(d, 'th')).toMatch(/ก\.ย\./);
    expect(formatDate(d, 'en')).toMatch(/2026/);
    expect(formatDate(d, 'en')).not.toMatch(/2569|BE/);
  });

  test('uses Asia/Bangkok: 17:30 UTC on the 28th is the 29th at 00:30', () => {
    const d = new Date('2026-09-28T17:30:00Z');
    expect(formatDate(d, 'th')).toMatch(/^29 /);
    expect(formatDate(d, 'en')).toMatch(/^29 /);
    expect(formatDate(d, 'th', 'time')).toBe('00:30');
    expect(formatDate(d, 'en', 'dateTime')).toMatch(/00:30/);
  });

  test('Thai locale keeps Arabic digits', () => {
    expect(formatDate('2026-09-29T05:00:00Z', 'th')).toMatch(/^[0-9]/);
  });

  test('rejects an invalid date', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError);
  });
});
