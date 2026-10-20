/**
 * The tax years we have rules for. Adding a year is: write `th-pit-<year>.ts` (a `TaxRules`) and
 * list it here. No estimator code changes. A year that is not listed has NO estimate: the caller
 * must say so, never fall back to another year's numbers.
 */
import { thPit2569 } from './th-pit-2569.ts';
import type { TaxRules } from './types.ts';

export const TAX_RULES: readonly TaxRules[] = [thPit2569];

export function taxRulesFor(year: number): TaxRules | undefined {
  return TAX_RULES.find((r) => r.ruleYear === year);
}

export function taxYearsAvailable(): number[] {
  return TAX_RULES.map((r) => r.ruleYear).sort((a, b) => a - b);
}
