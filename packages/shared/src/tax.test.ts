import { describe, expect, test } from 'vitest';
import { putTaxProfileInputSchema, taxProfileValueSchema, taxReportQuerySchema } from './tax.ts';

describe('tax report query', () => {
  test('year is a Buddhist Era number, period is annual or half', () => {
    expect(taxReportQuerySchema.parse({ year: '2569', period: 'half' })).toEqual({
      year: 2569,
      period: 'half',
    });
    expect(taxReportQuerySchema.safeParse({ year: '2026', period: 'half' }).success).toBe(false);
    expect(taxReportQuerySchema.safeParse({ year: '2569', period: 'quarter' }).success).toBe(false);
    expect(taxReportQuerySchema.safeParse({ year: '2569.5', period: 'annual' }).success).toBe(
      false,
    );
    expect(taxReportQuerySchema.safeParse({ period: 'annual' }).success).toBe(false);
  });
});

describe('tax profile', () => {
  test('the empty jsonb the table starts with reads as no extra allowances', () => {
    expect(taxProfileValueSchema.parse({ allowances: {}, methodPreference: null })).toEqual({
      allowances: { items: [] },
      methodPreference: null,
    });
  });
  test('items are whole non-negative satang with a label; unknown keys are refused', () => {
    const ok = {
      allowances: { items: [{ label: 'ประกันสุขภาพ', annualSatang: 2_000_000 }] },
      methodPreference: 'actual',
    };
    expect(putTaxProfileInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { label: 'x', annualSatang: -1 },
      { label: 'x', annualSatang: 1.5 },
      { label: ' ', annualSatang: 1 },
      { label: 'x', annualSatang: 1, extra: true },
    ]) {
      expect(
        putTaxProfileInputSchema.safeParse({
          allowances: { items: [bad] },
          methodPreference: null,
        }).success,
      ).toBe(false);
    }
    expect(
      putTaxProfileInputSchema.safeParse({ ...ok, methodPreference: 'whatever' }).success,
    ).toBe(false);
  });
});
