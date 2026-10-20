import { describe, expect, test } from 'vitest';
import {
  applyBasisPoints,
  bahtToSatang,
  cashChange,
  lineTotal,
  marginBasisPoints,
  orderTotals,
  satang,
  sumSatang,
} from './money.ts';

describe('satang guard', () => {
  test('accepts safe integers, including zero and negatives', () => {
    expect(satang(0)).toBe(0);
    expect(satang(4550)).toBe(4550);
    expect(satang(-100)).toBe(-100);
  });
  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (v) => {
      expect(() => satang(v)).toThrow(RangeError);
    },
  );
});

describe('bahtToSatang (exact decimal parsing, no float math)', () => {
  test.each([
    ['0', 0],
    ['45', 4500],
    ['45.5', 4550],
    ['45.50', 4550],
    ['0.01', 1],
    ['1,250.75', 125075],
  ])('%s → %i', (input, expected) => {
    expect(bahtToSatang(input)).toBe(expected);
  });
  test.each(['', '-1', '1.234', 'abc', '1.2.3', '.5', '1,25'])('rejects %j', (input) => {
    expect(() => bahtToSatang(input)).toThrow(RangeError);
  });
});

describe('applyBasisPoints rounds half up to 1 satang', () => {
  test.each([
    [10000, 6000, 6000], // 60% of ฿100
    [4550, 6000, 2730], // 60% of ฿45.50
    [1, 5000, 1], // 0.5 satang → 1
    [1, 4999, 0], // 0.4999 satang → 0
    [3, 5000, 2], // 1.5 → 2
    [12345, 3333, 4115], // 4114.5 → 4115
    [0, 6000, 0],
  ])('%i × %i bp = %i', (amount, bp, expected) => {
    expect(applyBasisPoints(satang(amount), bp)).toBe(expected);
  });
  test('rejects negative amounts and out-of-range basis points', () => {
    expect(() => applyBasisPoints(satang(-1), 100)).toThrow(RangeError);
    expect(() => applyBasisPoints(satang(100), -1)).toThrow(RangeError);
    expect(() => applyBasisPoints(satang(100), 10001)).toThrow(RangeError);
    expect(() => applyBasisPoints(satang(100), 1.5)).toThrow(RangeError);
  });
});

describe('lineTotal with modifiers', () => {
  test('no modifiers', () => {
    expect(lineTotal({ unitPrice: satang(5000), qty: 2, modifierDeltas: [] })).toBe(10000);
  });
  test('modifier deltas are added per unit, then multiplied by qty', () => {
    // noodles ฿50 + extra ฿10 + egg ฿5, × 3
    expect(
      lineTotal({ unitPrice: satang(5000), qty: 3, modifierDeltas: [satang(1000), satang(500)] }),
    ).toBe(19500);
  });
  test('a negative delta is allowed, but the unit price cannot go below 0', () => {
    expect(lineTotal({ unitPrice: satang(5000), qty: 1, modifierDeltas: [satang(-500)] })).toBe(
      4500,
    );
    expect(() =>
      lineTotal({ unitPrice: satang(500), qty: 1, modifierDeltas: [satang(-600)] }),
    ).toThrow(RangeError);
  });
  test.each([0, -1, 1.5])('rejects qty %s', (qty) => {
    expect(() => lineTotal({ unitPrice: satang(5000), qty, modifierDeltas: [] })).toThrow(
      RangeError,
    );
  });
});

describe('orderTotals', () => {
  const lines = [
    { unitPrice: satang(5000), qty: 2, modifierDeltas: [satang(1000)] }, // 12000
    { unitPrice: satang(2500), qty: 1, modifierDeltas: [] }, // 2500
  ];
  test('subtotal and total without discount', () => {
    expect(orderTotals(lines)).toEqual({ subtotal: 14500, discount: 0, total: 14500 });
  });
  test('discount is subtracted', () => {
    expect(orderTotals(lines, satang(500))).toEqual({
      subtotal: 14500,
      discount: 500,
      total: 14000,
    });
  });
  test('discount can equal but never exceed the subtotal, and is never negative', () => {
    expect(orderTotals(lines, satang(14500)).total).toBe(0);
    expect(() => orderTotals(lines, satang(14501))).toThrow(RangeError);
    expect(() => orderTotals(lines, satang(-1))).toThrow(RangeError);
  });
  test('an order needs at least one line', () => {
    expect(() => orderTotals([])).toThrow(RangeError);
  });
});

describe('cashChange', () => {
  test.each([
    [14500, 20000, 5500],
    [14500, 14500, 0],
    [4550, 10000, 5450],
  ])('amount %i, tendered %i → change %i', (amount, tendered, change) => {
    expect(cashChange(satang(amount), satang(tendered))).toBe(change);
  });
  test('tendered below amount is rejected', () => {
    expect(() => cashChange(satang(14500), satang(14499))).toThrow(RangeError);
  });
  test('negative amount is rejected', () => {
    expect(() => cashChange(satang(-1), satang(0))).toThrow(RangeError);
  });
});

test('sumSatang', () => {
  expect(sumSatang([])).toBe(0);
  expect(sumSatang([satang(1), satang(2), satang(3)])).toBe(6);
  expect(() => sumSatang([satang(Number.MAX_SAFE_INTEGER), satang(1)])).toThrow(RangeError);
});

describe('marginBasisPoints (profit / revenue, half away from zero)', () => {
  test.each([
    [60, 100, 6000], // 60%
    [1, 3, 3333], // 33.333...% -> 3333
    [2, 3, 6667], // 66.666...% -> 6667
    [1, 8, 1250], // exact
    [1, 16000, 1], // 0.00625 bp... 1/16000 = 0.625 bp -> 1
    [1, 40000, 0], // 0.25 bp -> 0
    [0, 5000, 0],
    [-1, 3, -3333], // a loss rounds the same way, away from zero at the half
    [-2, 3, -6667],
    [-1, 20000, -1], // -0.5 bp -> -1 (away from zero)
    [6, 100, 600],
    [150, 100, 15000], // above 100% is only arithmetic (a negative cost); the maths does not cap it
  ])('%i / %i = %i bp', (profit, revenue, expected) => {
    expect(marginBasisPoints(satang(profit), satang(revenue))).toBe(expected);
  });
  test('is null when there is no revenue to divide by', () => {
    expect(marginBasisPoints(satang(0), satang(0))).toBeNull();
    expect(marginBasisPoints(satang(100), satang(0))).toBeNull();
  });
  test('rejects negative revenue', () => {
    expect(() => marginBasisPoints(satang(1), satang(-1))).toThrow(RangeError);
  });
  test('negating the profit negates the margin (symmetry), over many seeded values', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const revenue = (next() % 5_000_000) + 1;
      const profit = (next() % 10_000_000) - 5_000_000;
      const up = marginBasisPoints(satang(profit), satang(revenue));
      const down = marginBasisPoints(satang(-profit), satang(revenue));
      expect(up).not.toBeNull();
      expect(down).toBe(-(up as number) + 0);
      // within half a basis point of the exact ratio
      expect(Math.abs((up as number) - (profit * 10000) / revenue)).toBeLessThanOrEqual(0.5);
    }
  });
});
