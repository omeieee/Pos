/**
 * Thai personal income tax ESTIMATOR for a sole trader with section 40(8) income (P7, D-34).
 * Pure: money in, money out, rules passed in as data (`tax-rules/`). It is an estimate to help the
 * owner plan, never a filing; every output carries the rule year, the proposed status, the sources
 * of each rule and a disclaimer key.
 *
 * How the shop's P&L maps to taxable income (D-34, proposed):
 *   assessable income (เงินได้พึงประเมิน) = P&L revenue (net paid of counted orders, on business date)
 *   actual expenses = cost of goods + platform commission + unvoided expense ledger rows, minus the
 *                     smaller of each overlapping pair (below), so it equals what the P&L deducts
 *   flat expenses   = revenue x the flat rate (60% for food and drink sales)
 *   net income      = income - expenses; allowances are then deducted; tax is on what is left, never
 *                     below 0 (a loss pays no tax; the negative figure is still shown)
 * Cost of goods comes from the owner's menu cost estimates, not receipts, and may overlap an
 * "ingredients" ledger expense; the platform commission may overlap a "platform_fees" ledger expense.
 * For each pair, when both are above 0 only the LARGER is deducted (owner-approved 2026-10-21,
 * `overlap.ts`, the same helper the P&L uses), and a note says which one was used. The raw figures
 * are not changed, so `methods.actual.expenseSatang` = P&L revenue - P&L net profit.
 *
 * Rounding: tax is worked out in satang. The progressive tax is summed over the steps and rounded
 * ONCE, half up, to one satang; the 0.5% tax and the flat expense use the shared `applyBasisPoints`
 * (half up). The RD pages we read give no rounding rule for these; the RD tables are in whole baht
 * so the step amounts never need rounding. Treat the last satang as unconfirmed.
 *
 * Section 48(2): the tax is the higher of the normal tax and 0.5% of gross income, EXCEPT that when
 * the 0.5% amount is 5,000 baht or less the normal tax is paid. The conflict between RD pages over
 * the 0.5% threshold is recorded in the rules; see `payableTax`.
 */
import { applyBasisPoints, satang, type TAX_NOTE_KEYS } from '@sds/shared';
import {
  type FoodCostBasis,
  foodCostOverlap,
  type PlatformFeesBasis,
  platformFeesOverlap,
} from './overlap.ts';
import { isCounted, type ReportOrder } from './revenue.ts';
import type { RuleSource, TaxRules } from './tax-rules/types.ts';

export type TaxPeriod = 'annual' | 'half';
export type TaxMethod = 'actual' | 'flat';

/** Keys of the notes an estimate can carry (`TAX_NOTE_KEYS` in @sds/shared); the words are in `packages/i18n`. */
export type TaxNote = (typeof TAX_NOTE_KEYS)[number];

export interface TaxAllowanceItem {
  label: string;
  /** The full-year figure the owner entered. */
  annualSatang: number;
}

export interface TaxExpenses {
  costOfGoodsSatang: number;
  commissionSatang: number;
  /** Unvoided ledger rows, every category. */
  ledgerSatang: number;
  /** Of `ledgerSatang`, the "ingredients" category (food cost that may also be in cost of goods). */
  ingredientsLedgerSatang: number;
  /** Of `ledgerSatang`, the "platform_fees" category (may be the platform commission typed again). */
  platformFeesLedgerSatang: number;
}

export interface TaxInput {
  rules: TaxRules;
  period: TaxPeriod;
  /** The dates the figures cover (the tax year, or Jan-Jun of it), ISO. */
  range: { from: string; to: string };
  /** Today in Asia/Bangkok, ISO; decides "year not finished" and "past due". */
  asOf: string;
  grossIncomeSatang: number;
  expenses: TaxExpenses;
  /** The P&L `complete` flag. */
  pnlComplete: boolean;
  allowanceItems: readonly TaxAllowanceItem[];
  methodPreference: TaxMethod | null;
  /** Incoming bank transfers seen by the POS (a floor of what the bank counts), or null if unknown. */
  incomingTransfers: { count: number; totalSatang: number } | null;
}

export interface HalfPercentBlock {
  rateBasisPoints: number;
  /** 0.5% of the gross income. */
  taxSatang: number;
  thresholdSatang: number;
  thresholdStatus: 'confirmed' | 'conflict';
  exemptCeilingSatang: number;
  /** `applied`: it counts toward the tax. `not_applied_threshold_unconfirmed`: shown, not used. */
  status: 'applied' | 'not_applied_threshold_unconfirmed';
}

export interface MethodResult {
  expenseSatang: number;
  /** Income - expenses; negative for a loss. */
  netBeforeAllowancesSatang: number;
  allowancesSatang: number;
  /** Never below 0. */
  taxableNetSatang: number;
  /** Progressive tax on `taxableNetSatang`. */
  bracketTaxSatang: number;
  /** After the 0.5% comparison. */
  payableSatang: number;
}

export type WatchStatus = 'below' | 'near' | 'over';

export interface TaxEstimate {
  ruleYear: number;
  status: TaxRules['status'];
  estimateOnly: true;
  disclaimerKey: 'tax.disclaimer';
  period: TaxPeriod;
  /** ภ.ง.ด.94 for the half year, ภ.ง.ด.90 for the year. */
  form: 'ภ.ง.ด.94' | 'ภ.ง.ด.90';
  range: { from: string; to: string };
  /** The last date the figures can include: today, or the end of the range. */
  coversThrough: string;
  income: { assessableSatang: number };
  methods: Record<TaxMethod, MethodResult>;
  chosenMethod: TaxMethod;
  chosenBy: 'preference' | 'default_actual';
  cheaperMethod: TaxMethod;
  /** Shown only when the 0.5% amount is over the 5,000 baht limit and the gross is at or over a threshold. */
  halfPercent: HalfPercentBlock | null;
  /** The chosen method's tax after the 0.5% comparison. */
  taxPayableSatang: number;
  allowances: {
    personalSatang: number;
    items: (TaxAllowanceItem & { appliedSatang: number })[];
    totalSatang: number;
  };
  pnlComplete: boolean;
  /** Which of cost of goods and the ingredients expense is deducted (`only_one` = no overlap). */
  foodCostBasis: FoodCostBasis;
  /** The smaller of the two when both are present: raw, but not deducted. */
  foodCostNotDeductedSatang: number;
  /** Which of commission and the platform_fees expense is deducted (`only_one` = no overlap). */
  platformFeesBasis: PlatformFeesBasis;
  platformFeesNotDeductedSatang: number;
  filing: {
    mustFile: boolean;
    incomeOverSatang: number;
    window: { from: string; to: string };
    pastDue: boolean;
  };
  watch: {
    vat: {
      status: WatchStatus;
      revenueSatang: number;
      registrationOverSatang: number;
      /** Whole percent of the threshold, rounded down. */
      percentOfThreshold: number;
    };
    ePayment: {
      status: 'below' | 'near' | 'reached';
      count: number;
      totalSatang: number;
      transferCount: number;
      altTransferCount: number;
      altTotalSatang: number;
    } | null;
  };
  notes: TaxNote[];
  sources: (RuleSource & { rule: string })[];
}

function assertSatang(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError(`${label} must be a whole number of satang, 0 or more, got ${value}`);
  }
}

/** Progressive tax on net income, in satang, rounded once half up. */
export function bracketTax(netSatang: number, rules: TaxRules): number {
  assertSatang(netSatang, 'net income');
  const tiers = rules.brackets.tiers;
  let scaled = 0; // satang x percent
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (!tier || netSatang <= tier.overSatang) break;
    const top = tiers[i + 1]?.overSatang ?? Number.POSITIVE_INFINITY;
    scaled += (Math.min(netSatang, top) - tier.overSatang) * tier.ratePercent;
  }
  return Math.floor((scaled + 50) / 100);
}

/**
 * Section 48(2). `halfPercent` is null when the method plays no part: the gross is under every
 * threshold, or 0.5% of it is not over the exempt ceiling (then the normal tax is paid, RD 31847.html).
 * The limit is compared on the exact product so the 1,000,000 baht boundary cannot flip on rounding.
 * Between the lowest threshold any RD page gives and the one we use, the amount is shown but NOT used.
 */
export function payableTax(
  normalTaxSatang: number,
  grossSatang: number,
  rules: TaxRules,
): { payableSatang: number; halfPercent: HalfPercentBlock | null } {
  assertSatang(normalTaxSatang, 'tax');
  assertSatang(grossSatang, 'gross income');
  const h = rules.halfPercent;
  const lowest = Math.min(h.thresholdSatang, ...h.conflictingThresholdsSatang);
  const overCeiling = grossSatang * h.rateBasisPoints > h.exemptCeilingSatang * 10_000;
  if (grossSatang < lowest || !overCeiling) {
    return { payableSatang: normalTaxSatang, halfPercent: null };
  }
  const tax = applyBasisPoints(satang(grossSatang), h.rateBasisPoints);
  const applied = grossSatang >= h.thresholdSatang;
  return {
    payableSatang: applied ? Math.max(normalTaxSatang, tax) : normalTaxSatang,
    halfPercent: {
      rateBasisPoints: h.rateBasisPoints,
      taxSatang: tax,
      thresholdSatang: h.thresholdSatang,
      thresholdStatus: h.thresholdStatus,
      exemptCeilingSatang: h.exemptCeilingSatang,
      status: applied ? 'applied' : 'not_applied_threshold_unconfirmed',
    },
  };
}

/** Incoming PromptPay payments of counted orders: a floor of what a bank reports (e-Payment watch). */
export function incomingPromptpayTransfers(orders: readonly ReportOrder[]): {
  count: number;
  totalSatang: number;
} {
  let count = 0;
  let totalSatang = 0;
  for (const o of orders) {
    if (!isCounted(o)) continue;
    for (const p of o.payments) {
      if (p.status !== 'confirmed' || p.method !== 'promptpay') continue;
      count += 1;
      totalSatang += p.amountSatang;
    }
  }
  return { count, totalSatang };
}

function sourcesOf(rules: TaxRules): (RuleSource & { rule: string })[] {
  const blocks: [string, { sources: readonly RuleSource[] }][] = [
    ['brackets', rules.brackets],
    ['flatExpense', rules.flatExpense],
    ['allowances', rules.allowances],
    ['halfPercent', rules.halfPercent],
    ['filing', rules.filing],
    ['vat', rules.vat],
    ['ePayment', rules.ePayment],
  ];
  return blocks.flatMap(([rule, b]) => b.sources.map((s) => ({ rule, ...s })));
}

export function estimateTax(input: TaxInput): TaxEstimate {
  const { rules, period, range, asOf } = input;
  const gross = input.grossIncomeSatang;
  assertSatang(gross, 'gross income');
  const x = input.expenses;
  assertSatang(x.costOfGoodsSatang, 'cost of goods');
  assertSatang(x.commissionSatang, 'commission');
  assertSatang(x.ledgerSatang, 'ledger expenses');
  assertSatang(x.ingredientsLedgerSatang, 'ingredients expenses');
  assertSatang(x.platformFeesLedgerSatang, 'platform fees expenses');
  for (const item of input.allowanceItems)
    assertSatang(item.annualSatang, `allowance ${item.label}`);
  if (input.incomingTransfers) {
    assertSatang(input.incomingTransfers.count, 'transfer count');
    assertSatang(input.incomingTransfers.totalSatang, 'transfer total');
  }

  const half = period === 'half';
  const personal = half
    ? rules.allowances.personalHalfYearSatang
    : rules.allowances.personalAnnualSatang;
  const items = input.allowanceItems.map((i) => ({
    ...i,
    // RD halves the allowances on the half-year return (FAQ 61549.html). Some (life insurance, home
    // loan interest) are by amounts actually paid Jan-Jun instead; we do not know which, so half.
    appliedSatang: half ? Math.floor(i.annualSatang / 2) : i.annualSatang,
  }));
  const allowanceTotal = personal + items.reduce((n, i) => n + i.appliedSatang, 0);

  const food = foodCostOverlap(x.costOfGoodsSatang, x.ingredientsLedgerSatang);
  const fees = platformFeesOverlap(x.commissionSatang, x.platformFeesLedgerSatang);
  const actualExpense =
    x.costOfGoodsSatang +
    x.commissionSatang +
    x.ledgerSatang -
    food.notDeductedSatang -
    fees.notDeductedSatang;
  const flatExpense = applyBasisPoints(satang(gross), rules.flatExpense.ratePercent * 100);

  const method = (
    expenseSatang: number,
  ): MethodResult & { halfPercent: HalfPercentBlock | null } => {
    const net = gross - expenseSatang;
    const taxable = Math.max(0, net - allowanceTotal);
    const normal = bracketTax(taxable, rules);
    const { payableSatang, halfPercent } = payableTax(normal, gross, rules);
    return {
      expenseSatang,
      netBeforeAllowancesSatang: net,
      allowancesSatang: allowanceTotal,
      taxableNetSatang: taxable,
      bracketTaxSatang: normal,
      payableSatang,
      halfPercent,
    };
  };
  const { halfPercent, ...actual } = method(actualExpense);
  const { halfPercent: _halfPercentIsTheSame, ...flat } = method(flatExpense);

  const chosenMethod: TaxMethod = input.methodPreference ?? 'actual';
  const taxPayable = chosenMethod === 'actual' ? actual.payableSatang : flat.payableSatang;
  const cheaperMethod: TaxMethod = flat.payableSatang < actual.payableSatang ? 'flat' : 'actual';

  const filingOver = half
    ? rules.filing.halfYearIncomeOverSatang
    : rules.filing.annualIncomeOverSatang;
  const window = half ? rules.filing.halfYearWindow : rules.filing.annualWindow;
  const mustFile = gross > filingOver;
  const pastDue = mustFile && asOf > window.to;

  const vatOver = rules.vat.registrationOverSatang;
  const vatStatus: WatchStatus =
    gross > vatOver ? 'over' : gross * 100 >= rules.vat.warnAtPercent * vatOver ? 'near' : 'below';

  const e = rules.ePayment;
  let ePayment: TaxEstimate['watch']['ePayment'] = null;
  if (input.incomingTransfers) {
    const { count, totalSatang } = input.incomingTransfers;
    const reached =
      count >= e.transferCount || (count >= e.altTransferCount && totalSatang >= e.altTotalSatang);
    const near =
      count * 100 >= e.warnAtPercent * e.transferCount ||
      (count * 100 >= e.warnAtPercent * e.altTransferCount &&
        totalSatang * 100 >= e.warnAtPercent * e.altTotalSatang);
    ePayment = {
      status: reached ? 'reached' : near ? 'near' : 'below',
      count,
      totalSatang,
      transferCount: e.transferCount,
      altTransferCount: e.altTransferCount,
      altTotalSatang: e.altTotalSatang,
    };
  }

  const notes: TaxNote[] = [];
  if (!input.pnlComplete) notes.push('tax.note.pnlIncomplete');
  if (food.basis === 'cost_of_goods') notes.push('tax.note.foodCostCostOfGoodsUsed');
  if (food.basis === 'ingredients_expenses') notes.push('tax.note.foodCostIngredientsUsed');
  if (fees.basis === 'commission') notes.push('tax.note.platformFeesCommissionUsed');
  if (fees.basis === 'platform_fees_expenses') notes.push('tax.note.platformFeesExpensesUsed');
  if (x.costOfGoodsSatang > 0) notes.push('tax.note.costOfGoodsEstimated');
  if (chosenMethod === 'actual') notes.push('tax.note.expensesNeedRecords');
  if (items.length > 0) notes.push('tax.note.allowancesUnchecked');
  if (items.length > 0 && half) notes.push('tax.note.halfYearAllowancesHalved');
  if (halfPercent?.status === 'applied') notes.push('tax.note.halfPercentThresholdSources');
  if (halfPercent?.status === 'not_applied_threshold_unconfirmed') {
    notes.push('tax.note.halfPercentNotApplied');
  }
  if (asOf < range.to) notes.push('tax.note.yearNotFinished');
  if (!half) notes.push('tax.note.halfYearCredit');
  if (pastDue) notes.push('tax.note.filingLate');

  return {
    ruleYear: rules.ruleYear,
    status: rules.status,
    estimateOnly: true,
    disclaimerKey: 'tax.disclaimer',
    period,
    form: half ? 'ภ.ง.ด.94' : 'ภ.ง.ด.90',
    range,
    coversThrough: asOf < range.to ? asOf : range.to,
    income: { assessableSatang: gross },
    methods: { actual, flat },
    chosenMethod,
    chosenBy: input.methodPreference ? 'preference' : 'default_actual',
    cheaperMethod,
    halfPercent,
    taxPayableSatang: taxPayable,
    allowances: { personalSatang: personal, items, totalSatang: allowanceTotal },
    pnlComplete: input.pnlComplete,
    foodCostBasis: food.basis,
    foodCostNotDeductedSatang: food.notDeductedSatang,
    platformFeesBasis: fees.basis,
    platformFeesNotDeductedSatang: fees.notDeductedSatang,
    filing: { mustFile, incomeOverSatang: filingOver, window, pastDue },
    watch: {
      vat: {
        status: vatStatus,
        revenueSatang: gross,
        registrationOverSatang: vatOver,
        percentOfThreshold: Math.floor((gross * 100) / vatOver),
      },
      ePayment,
    },
    notes,
    sources: sourcesOf(rules),
  };
}
