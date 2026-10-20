import { describe, expect, test } from 'vitest';
import { foodCostOverlap, platformFeesOverlap } from './overlap.ts';

describe('food cost: cost of goods vs "ingredients" expenses, the larger is deducted', () => {
  test('cost of goods larger: ingredients are left out', () => {
    expect(foodCostOverlap(27100, 25000)).toEqual({
      basis: 'cost_of_goods',
      notDeductedSatang: 25000,
    });
  });
  test('ingredients larger: the cost of goods is left out', () => {
    expect(foodCostOverlap(9300, 10000)).toEqual({
      basis: 'ingredients_expenses',
      notDeductedSatang: 9300,
    });
  });
  test('a tie is decided in favour of cost of goods; the same amount is left out either way', () => {
    expect(foodCostOverlap(5000, 5000)).toEqual({
      basis: 'cost_of_goods',
      notDeductedSatang: 5000,
    });
  });
  test('only one present, or neither: nothing is left out', () => {
    for (const [cog, ing] of [
      [5000, 0],
      [0, 5000],
      [0, 0],
    ] as const) {
      expect(foodCostOverlap(cog, ing)).toEqual({ basis: 'only_one', notDeductedSatang: 0 });
    }
  });
});

describe('platform fees: commission vs "platform_fees" expenses, the larger is deducted', () => {
  test('commission larger', () => {
    expect(platformFeesOverlap(4550, 1500)).toEqual({
      basis: 'commission',
      notDeductedSatang: 1500,
    });
  });
  test('fees expense larger', () => {
    expect(platformFeesOverlap(300, 1500)).toEqual({
      basis: 'platform_fees_expenses',
      notDeductedSatang: 300,
    });
  });
  test('tie: commission; one side only or neither: only_one', () => {
    expect(platformFeesOverlap(700, 700)).toEqual({ basis: 'commission', notDeductedSatang: 700 });
    expect(platformFeesOverlap(0, 700)).toEqual({ basis: 'only_one', notDeductedSatang: 0 });
    expect(platformFeesOverlap(700, 0)).toEqual({ basis: 'only_one', notDeductedSatang: 0 });
    expect(platformFeesOverlap(0, 0)).toEqual({ basis: 'only_one', notDeductedSatang: 0 });
  });
});

describe('properties over a grid of amounts', () => {
  const values = [0, 1, 2, 99, 100, 101, 12345, 99999];
  test('deducted = a + b - not deducted = max(a, b); never negative; symmetric amount', () => {
    for (const a of values) {
      for (const b of values) {
        const f = foodCostOverlap(a, b);
        expect(a + b - f.notDeductedSatang).toBe(Math.max(a, b));
        expect(f.notDeductedSatang).toBe(Math.min(a, b) > 0 ? Math.min(a, b) : 0);
        const p = platformFeesOverlap(a, b);
        expect(a + b - p.notDeductedSatang).toBe(Math.max(a, b));
      }
    }
  });
  test('whole satang only', () => {
    expect(() => foodCostOverlap(1.5, 2)).toThrow(RangeError);
    expect(() => platformFeesOverlap(1, -2)).toThrow(RangeError);
  });
});
