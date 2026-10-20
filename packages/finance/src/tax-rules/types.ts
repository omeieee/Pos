/**
 * The shape of one tax year's rules (P7, D-34). A year is DATA: a file `th-pit-<year>.ts` that
 * exports a `TaxRules`, listed in `registry.ts`. The estimator (`../tax.ts`) takes the rules as a
 * parameter and holds no year-specific number, so a new year changes no logic.
 *
 * Every money value is integer satang. Every rule carries the sources it was read from (a URL and
 * the date it was checked), and the whole set is `proposed`: nothing here is a filing or advice.
 */

export interface RuleSource {
  url: string;
  /** ISO date the page or file was read. */
  checkedOn: string;
  /** What the source says, in a few words. */
  says: string;
}

export interface Sourced {
  sources: readonly RuleSource[];
}

export interface BracketTier {
  /** Net income above this (satang) is taxed at `ratePercent`; the previous tier's top. */
  overSatang: number;
  /** A whole percent. */
  ratePercent: number;
}

export interface YearWindow {
  /** ISO dates, inclusive, in the Gregorian calendar. */
  from: string;
  to: string;
}

export interface TaxRules {
  /** Buddhist Era tax year, e.g. 2569 (= 2026). */
  ruleYear: number;
  /** Always this text until the Revenue Department or an accountant confirms the year. */
  status: 'proposed - confirm with the Revenue Department';

  /** Progressive rates on net income (RD instruction, rate table 1). Ascending `overSatang`, first is 0. */
  brackets: Sourced & { tiers: readonly BracketTier[] };

  /** The flat expense deduction for section 40(8) food and drink sales. */
  flatExpense: Sourced & { ratePercent: number };

  allowances: Sourced & {
    /** Personal allowance for a full year. */
    personalAnnualSatang: number;
    /**
     * The personal allowance on the half-year return, as the RD form instruction states it (it is
     * not computed by halving here, it is the stated figure).
     */
    personalHalfYearSatang: number;
  };

  /** Section 48(2): 0.5% of the gross assessable income, compared with the normal tax. */
  halfPercent: Sourced & {
    /** 0.5% = 50. */
    rateBasisPoints: number;
    /** The method applies from this gross income. The source the figure comes from is in `sources`. */
    thresholdSatang: number;
    /** `conflict`: RD pages disagree about the threshold; see `conflictingThresholdsSatang`. */
    thresholdStatus: 'confirmed' | 'conflict';
    /** Other thresholds some RD pages give. Between the lowest of them and `thresholdSatang` the method is NOT applied. */
    conflictingThresholdsSatang: readonly number[];
    /** If the 0.5% tax is at most this (inclusive), the normal tax is paid and the 0.5% tax is exempt. */
    exemptCeilingSatang: number;
  };

  /** The duty to file, for a single person (not a married couple filing together). */
  filing: Sourced & {
    /** A return is due when this year's (or half-year's) income is MORE than this. */
    annualIncomeOverSatang: number;
    halfYearIncomeOverSatang: number;
    halfYearWindow: YearWindow;
    annualWindow: YearWindow;
    /** Late: surcharge percent per month, fine ceiling (satang). */
    lateSurchargePercentPerMonth: number;
    lateFineMaxSatang: number;
  };

  /** VAT registration watch. Registration is due when sales are MORE than the threshold. */
  vat: Sourced & { registrationOverSatang: number; warnAtPercent: number };

  /** e-Payment: banks report an individual's incoming transfers when EITHER limb is reached (per bank, per year). */
  ePayment: Sourced & {
    transferCount: number;
    altTransferCount: number;
    altTotalSatang: number;
    warnAtPercent: number;
  };
}
