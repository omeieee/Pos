import { describe, expect, test } from 'vitest';
import { TAX_RULES, taxRulesFor, taxYearsAvailable } from './registry.ts';

describe('tax rules registry', () => {
  test('lists 2569, finds it by year and nothing else', () => {
    expect(taxYearsAvailable()).toContain(2569);
    expect(taxRulesFor(2569)?.ruleYear).toBe(2569);
    expect(taxRulesFor(2568)).toBeUndefined();
    expect(taxRulesFor(2570)).toBeUndefined();
  });

  test.each(TAX_RULES.map((r) => [r.ruleYear, r] as const))(
    'year %i: unique, proposed, every rule block sourced with a URL and a check date',
    (_year, rules) => {
      expect(TAX_RULES.filter((r) => r.ruleYear === rules.ruleYear)).toHaveLength(1);
      expect(rules.status).toBe('proposed - confirm with the Revenue Department');
      const blocks = [
        rules.brackets,
        rules.flatExpense,
        rules.allowances,
        rules.halfPercent,
        rules.filing,
        rules.vat,
        rules.ePayment,
      ];
      for (const block of blocks) {
        expect(block.sources.length).toBeGreaterThan(0);
        for (const s of block.sources) {
          expect(s.url).toMatch(/^https:\/\/(www\.)?rd\.go\.th\//);
          expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(s.says.length).toBeGreaterThan(0);
        }
      }
    },
  );

  test.each(TAX_RULES.map((r) => [r.ruleYear, r] as const))(
    'year %i: brackets start at 0 and ascend; money is whole satang',
    (_year, rules) => {
      const tiers = rules.brackets.tiers;
      expect(tiers[0]?.overSatang).toBe(0);
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]?.overSatang).toBeGreaterThan(tiers[i - 1]?.overSatang ?? 0);
        expect(tiers[i]?.ratePercent).toBeGreaterThan(tiers[i - 1]?.ratePercent ?? 0);
      }
      const money = [
        rules.allowances.personalAnnualSatang,
        rules.allowances.personalHalfYearSatang,
        rules.halfPercent.thresholdSatang,
        rules.halfPercent.exemptCeilingSatang,
        rules.vat.registrationOverSatang,
        rules.ePayment.altTotalSatang,
        ...tiers.map((t) => t.overSatang),
      ];
      for (const m of money) expect(Number.isSafeInteger(m)).toBe(true);
    },
  );

  test('2569 keeps the 0.5% threshold conflict on record and uses the current form figure', () => {
    const h = taxRulesFor(2569)?.halfPercent;
    expect(h?.thresholdStatus).toBe('conflict');
    expect(h?.thresholdSatang).toBe(12_000_000);
    expect(h?.conflictingThresholdsSatang).toEqual([6_000_000]);
    expect(h?.exemptCeilingSatang).toBe(500_000);
  });
});
