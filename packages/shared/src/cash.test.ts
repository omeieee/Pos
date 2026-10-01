import { describe, expect, test } from 'vitest';
import {
  CASH_TENDER_STEPS,
  CashPaymentError,
  calculateCashChange,
  cashAmountSchema,
  cashChangeInputSchema,
  cashChangeResultSchema,
  cashTenderSuggestionsInputSchema,
  cashTenderSuggestionsResultSchema,
  MAX_CASH_SATANG,
  suggestCashTenders,
} from './cash.ts';
import { type Satang, satang } from './money.ts';
import { mulberry32, randomInt } from './test-prng.ts';

/** Bypasses the `satang()` guard so the function's own runtime guards can be tested. */
const raw = (n: number): Satang => n as Satang;
const s = (n: number): Satang => satang(n);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CashPaymentError) return error.code;
    throw error;
  }
  return undefined;
}

describe('calculateCashChange: worked examples (02 §4.2, 03 §4)', () => {
  test.each([
    [7500, 10000, 2500], // 02 §4.2: total ฿75, tendered ฿100, change ฿25
    [14500, 20000, 5500],
    [4550, 10000, 5450],
    [4550, 4600, 50],
  ])('total %i, tendered %i → change %i', (total, tendered, change) => {
    expect(calculateCashChange(s(total), s(tendered))).toEqual({ total, tendered, change });
  });
});

describe('calculateCashChange: boundaries', () => {
  test('zero total with zero tendered gives zero change', () => {
    expect(calculateCashChange(s(0), s(0))).toEqual({ total: 0, tendered: 0, change: 0 });
  });
  test('zero total with a tender gives the whole tender back', () => {
    expect(calculateCashChange(s(0), s(100))).toEqual({ total: 0, tendered: 100, change: 100 });
  });
  test('exact payment gives zero change', () => {
    expect(calculateCashChange(s(14500), s(14500)).change).toBe(0);
  });
  test('one satang over gives one satang of change', () => {
    expect(calculateCashChange(s(14500), s(14501)).change).toBe(1);
  });
  test('one satang short is an error', () => {
    expect(codeOf(() => calculateCashChange(s(14500), s(14499)))).toBe('tendered_below_total');
    expect(codeOf(() => calculateCashChange(s(1), s(0)))).toBe('tendered_below_total');
  });
  test('the largest accepted values stay exact', () => {
    expect(calculateCashChange(s(MAX_CASH_SATANG), s(MAX_CASH_SATANG)).change).toBe(0);
    expect(calculateCashChange(s(1), s(MAX_CASH_SATANG)).change).toBe(MAX_CASH_SATANG - 1);
    expect(calculateCashChange(s(0), s(MAX_CASH_SATANG)).change).toBe(MAX_CASH_SATANG);
  });
});

describe('calculateCashChange: rejections', () => {
  const invalid: [string, number][] = [
    ['negative', -1],
    ['a fraction of a satang', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative fraction', -0.5],
  ];
  test.each(invalid)('total: %s', (_label, value) => {
    expect(codeOf(() => calculateCashChange(raw(value), s(100)))).toBe('invalid_amount');
  });
  test.each(invalid)('tendered: %s', (_label, value) => {
    expect(codeOf(() => calculateCashChange(s(100), raw(value)))).toBe('invalid_amount');
  });
  test('values past the sanity limit are "too large", not silently accepted', () => {
    expect(codeOf(() => calculateCashChange(s(100), s(MAX_CASH_SATANG + 1)))).toBe(
      'amount_too_large',
    );
    expect(codeOf(() => calculateCashChange(s(MAX_CASH_SATANG + 1), s(MAX_CASH_SATANG + 1)))).toBe(
      'amount_too_large',
    );
    expect(codeOf(() => calculateCashChange(s(100), raw(Number.MAX_SAFE_INTEGER)))).toBe(
      'amount_too_large',
    );
  });
  test('unsafe integers are invalid', () => {
    expect(codeOf(() => calculateCashChange(s(100), raw(Number.MAX_SAFE_INTEGER + 1)))).toBe(
      'invalid_amount',
    );
    expect(codeOf(() => calculateCashChange(raw(2 ** 60), s(100)))).toBe('invalid_amount');
  });
  test('every error is a RangeError carrying a code', () => {
    expect(() => calculateCashChange(s(100), s(99))).toThrow(RangeError);
    expect(() => calculateCashChange(s(100), s(99))).toThrow(CashPaymentError);
  });
  test('negative zero is treated as plain zero in the result', () => {
    // toEqual distinguishes -0 from +0, so this fails if a -0 leaks out.
    expect(calculateCashChange(raw(-0), raw(-0))).toEqual({ total: 0, tendered: 0, change: 0 });
    expect(suggestCashTenders(raw(-0))).toEqual([0]);
  });
});

describe('calculateCashChange: properties (seeded, 5000 cases each)', () => {
  const CASES = 5000;

  test('change = tendered - total, checked against BigInt arithmetic', () => {
    const rng = mulberry32(20261001);
    for (let i = 0; i < CASES; i++) {
      // Mix small amounts (where off-by-one bugs live) with the full range.
      const span = i % 2 === 0 ? 200_000 : MAX_CASH_SATANG;
      const total = randomInt(rng, 0, span);
      const tendered = randomInt(rng, total, Math.min(MAX_CASH_SATANG, total + span));
      const result = calculateCashChange(s(total), s(tendered));
      expect(BigInt(result.change)).toBe(BigInt(tendered) - BigInt(total));
      expect(result.total + result.change).toBe(tendered);
      expect(Number.isSafeInteger(result.change)).toBe(true);
      expect(result.change).toBeGreaterThanOrEqual(0);
    }
  });

  test('any tender below the total is rejected', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < CASES; i++) {
      const total = randomInt(rng, 1, MAX_CASH_SATANG);
      const tendered = randomInt(rng, 0, total - 1);
      expect(codeOf(() => calculateCashChange(s(total), s(tendered)))).toBe('tendered_below_total');
    }
  });

  test('a non-integer or negative amount is never accepted', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < CASES; i++) {
      const whole = randomInt(rng, 0, 1_000_000);
      const fraction = randomInt(rng, 1, 99) / 100;
      expect(codeOf(() => calculateCashChange(raw(whole + fraction), s(MAX_CASH_SATANG)))).toBe(
        'invalid_amount',
      );
      expect(codeOf(() => calculateCashChange(s(0), raw(-whole - 1)))).toBe('invalid_amount');
    }
  });
});

describe('suggestCashTenders', () => {
  // Totals in satang. Steps are the Thai notes ฿20, ฿50, ฿100, ฿500, ฿1000.
  test.each([
    [7500, [7500, 8000, 10000, 50000, 100000]], // ฿75
    [2000, [2000, 5000, 10000, 50000, 100000]], // ฿20 exactly: the ฿20 note is the exact amount
    [14500, [14500, 15000, 16000, 20000, 50000, 100000]], // ฿145
    [1, [1, 2000, 5000, 10000, 50000, 100000]], // one satang
    [99999, [99999, 100000]], // ฿999.99: every note rounds to ฿1000
    [100000, [100000]], // ฿1000 exactly
    [100001, [100001, 102000, 105000, 110000, 150000, 200000]], // ฿1000.01
    [0, [0]],
    [MAX_CASH_SATANG, [MAX_CASH_SATANG]],
    [MAX_CASH_SATANG - 1, [MAX_CASH_SATANG - 1, MAX_CASH_SATANG]],
  ])('total %i → %j', (total, expected) => {
    expect(suggestCashTenders(s(total))).toEqual(expected);
  });

  test('rejects negative, fractional and oversized totals', () => {
    expect(() => suggestCashTenders(raw(-1))).toThrow(CashPaymentError);
    expect(() => suggestCashTenders(raw(10.5))).toThrow(CashPaymentError);
    expect(() => suggestCashTenders(raw(Number.NaN))).toThrow(CashPaymentError);
    expect(codeOf(() => suggestCashTenders(s(MAX_CASH_SATANG + 1)))).toBe('amount_too_large');
  });

  test('the steps are the five Thai notes, in satang', () => {
    expect([...CASH_TENDER_STEPS]).toEqual([2000, 5000, 10000, 50000, 100000]);
  });

  test('the sanity limit is a multiple of every step, so no suggestion can exceed it', () => {
    for (const step of CASH_TENDER_STEPS) expect(MAX_CASH_SATANG % step).toBe(0);
  });

  test('properties: exact first, ascending, unique, each covers the total by less than one note', () => {
    const rng = mulberry32(31337);
    for (let i = 0; i < 5000; i++) {
      const span = i % 2 === 0 ? 300_000 : MAX_CASH_SATANG;
      const total = randomInt(rng, 0, span);
      const out = suggestCashTenders(s(total));
      expect(out[0]).toBe(total);
      expect(new Set(out).size).toBe(out.length);
      expect([...out].sort((a, b) => a - b)).toEqual([...out]);
      for (const tender of out) {
        expect(Number.isSafeInteger(tender)).toBe(true);
        expect(tender).toBeGreaterThanOrEqual(total);
        expect(tender).toBeLessThanOrEqual(MAX_CASH_SATANG);
        // Every suggestion can be paid with the matching note: it is the total or the next
        // multiple of one note value, so it exceeds the total by less than that note.
        const covered =
          tender === total || CASH_TENDER_STEPS.some((n) => tender % n === 0 && tender - total < n);
        expect(covered).toBe(true);
      }
      // Every suggestion is acceptable to calculateCashChange.
      for (const tender of out)
        expect(() => calculateCashChange(s(total), s(tender))).not.toThrow();
    }
  });

  test('properties: the smallest suggestion above the exact total is the nearest multiple', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 3000; i++) {
      const total = randomInt(rng, 0, 300_000);
      const out = suggestCashTenders(s(total));
      for (const step of CASH_TENDER_STEPS) {
        const nextMultiple = Number((BigInt(total) + BigInt(step) - 1n) / BigInt(step)) * step;
        expect(out).toContain(nextMultiple);
      }
    }
  });
});

describe('cash schemas', () => {
  test('cashAmountSchema accepts zero up to the limit and brands the value', () => {
    expect(cashAmountSchema.parse(0)).toBe(0);
    expect(cashAmountSchema.parse(MAX_CASH_SATANG)).toBe(MAX_CASH_SATANG);
  });
  test.each([-1, 1.5, MAX_CASH_SATANG + 1, Number.NaN, '100', null])(
    'cashAmountSchema rejects %j',
    (v) => {
      expect(cashAmountSchema.safeParse(v).success).toBe(false);
    },
  );

  test('cashChangeInputSchema parses { total, tendered }', () => {
    expect(cashChangeInputSchema.parse({ total: 7500, tendered: 10000 })).toEqual({
      total: 7500,
      tendered: 10000,
    });
    expect(cashChangeInputSchema.safeParse({ total: 7500 }).success).toBe(false);
    expect(cashChangeInputSchema.safeParse({ total: 7500, tendered: -5 }).success).toBe(false);
  });

  test('cashChangeResultSchema requires change = tendered - total', () => {
    expect(
      cashChangeResultSchema.safeParse({ total: 7500, tendered: 10000, change: 2500 }).success,
    ).toBe(true);
    expect(
      cashChangeResultSchema.safeParse({ total: 7500, tendered: 10000, change: 2499 }).success,
    ).toBe(false);
    expect(
      cashChangeResultSchema.safeParse({ total: 7500, tendered: 7000, change: -500 }).success,
    ).toBe(false);
  });

  test('the result of calculateCashChange always satisfies its own response schema', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 1000; i++) {
      const total = randomInt(rng, 0, 500_000);
      const tendered = randomInt(rng, total, total + 500_000);
      const result = calculateCashChange(s(total), s(tendered));
      expect(cashChangeResultSchema.safeParse(result).success).toBe(true);
    }
  });

  test('suggestion request and response schemas', () => {
    expect(cashTenderSuggestionsInputSchema.parse({ total: 7500 })).toEqual({ total: 7500 });
    expect(cashTenderSuggestionsInputSchema.safeParse({ total: -1 }).success).toBe(false);
    expect(
      cashTenderSuggestionsResultSchema.safeParse({
        total: 7500,
        suggestions: suggestCashTenders(s(7500)),
      }).success,
    ).toBe(true);
    // The first suggestion must be the exact total, and none may be below it.
    expect(
      cashTenderSuggestionsResultSchema.safeParse({ total: 7500, suggestions: [8000] }).success,
    ).toBe(false);
    expect(
      cashTenderSuggestionsResultSchema.safeParse({ total: 7500, suggestions: [] }).success,
    ).toBe(false);
  });
});
