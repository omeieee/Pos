/**
 * Wire types of the tax estimate and the tax profile (P7, D-34). The estimate is an owner-only
 * report (`finance.pnl`); the profile is edited by the owner with step-up (`settings.tax_profile`).
 * `year` is the Buddhist Era tax year (2569 = 2026), the same number the rules files and the
 * `tax_profiles` table use.
 */
import { z } from 'zod';
import { isoDateSchema, nonNegativeSatangSchema, satangSchema } from './schemas.ts';

export const TAX_PERIODS = ['annual', 'half'] as const;
export type TaxPeriodDto = (typeof TAX_PERIODS)[number];
export const TAX_METHODS = ['actual', 'flat'] as const;

const taxYearSchema = z.number().int().min(2560).max(2700);

export const taxReportQuerySchema = z.object({
  year: z.coerce.number().pipe(taxYearSchema),
  period: z.enum(TAX_PERIODS),
});
export type TaxReportQuery = z.infer<typeof taxReportQuerySchema>;

export const taxAllowanceItemSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  /** The full-year figure; the half-year return uses half of it. */
  annualSatang: nonNegativeSatangSchema,
});

/** What the owner entered for one year. Only the personal 60,000 baht is built in (in the rules file). */
export const taxProfileValueSchema = z.strictObject({
  allowances: z.strictObject({ items: z.array(taxAllowanceItemSchema).max(30).default([]) }),
  methodPreference: z.enum(TAX_METHODS).nullable(),
});
export type TaxProfileValue = z.infer<typeof taxProfileValueSchema>;

/** PUT replaces the whole profile of the year. */
export const putTaxProfileInputSchema = taxProfileValueSchema;
export type PutTaxProfileInput = z.infer<typeof putTaxProfileInputSchema>;

export const taxProfileResponseSchema = z.object({
  year: taxYearSchema,
  filerType: z.literal('individual'),
  ...taxProfileValueSchema.shape,
  /** False until the owner saves one: the answer is then the default (personal allowance only, actual expenses). */
  saved: z.boolean(),
});
export type TaxProfileResponse = z.infer<typeof taxProfileResponseSchema>;

const methodResultSchema = z.object({
  expenseSatang: nonNegativeSatangSchema,
  netBeforeAllowancesSatang: satangSchema,
  allowancesSatang: nonNegativeSatangSchema,
  taxableNetSatang: nonNegativeSatangSchema,
  bracketTaxSatang: nonNegativeSatangSchema,
  payableSatang: nonNegativeSatangSchema,
});

const ruleSourceSchema = z.object({
  rule: z.string(),
  url: z.string(),
  checkedOn: isoDateSchema,
  says: z.string(),
});

const windowSchema = z.object({ from: isoDateSchema, to: isoDateSchema });

export const TAX_NOTE_KEYS = [
  'tax.note.pnlIncomplete',
  'tax.note.foodCostTwice',
  'tax.note.costOfGoodsEstimated',
  'tax.note.expensesNeedRecords',
  'tax.note.allowancesUnchecked',
  'tax.note.halfYearAllowancesHalved',
  'tax.note.halfPercentThresholdSources',
  'tax.note.halfPercentNotApplied',
  'tax.note.yearNotFinished',
  'tax.note.halfYearCredit',
  'tax.note.filingLate',
] as const;

/**
 * The tax estimate for a tax year and period. An ESTIMATE, not a filing: `estimateOnly` is always
 * true, `status` says the rules are proposed, `disclaimerKey` and `notes` are i18n keys (th, en),
 * and `sources` lists the Revenue Department page behind each rule with the date it was read.
 */
export const taxReportSchema = z.object({
  ruleYear: taxYearSchema,
  status: z.literal('proposed - confirm with the Revenue Department'),
  estimateOnly: z.literal(true),
  disclaimerKey: z.literal('tax.disclaimer'),
  period: z.enum(TAX_PERIODS),
  form: z.enum(['ภ.ง.ด.94', 'ภ.ง.ด.90']),
  range: windowSchema,
  coversThrough: isoDateSchema,
  income: z.object({ assessableSatang: nonNegativeSatangSchema }),
  methods: z.object({ actual: methodResultSchema, flat: methodResultSchema }),
  chosenMethod: z.enum(TAX_METHODS),
  chosenBy: z.enum(['preference', 'default_actual']),
  cheaperMethod: z.enum(TAX_METHODS),
  halfPercent: z
    .object({
      rateBasisPoints: z.number().int(),
      taxSatang: nonNegativeSatangSchema,
      thresholdSatang: nonNegativeSatangSchema,
      thresholdStatus: z.enum(['confirmed', 'conflict']),
      exemptCeilingSatang: nonNegativeSatangSchema,
      status: z.enum(['applied', 'not_applied_threshold_unconfirmed']),
    })
    .nullable(),
  taxPayableSatang: nonNegativeSatangSchema,
  allowances: z.object({
    personalSatang: nonNegativeSatangSchema,
    items: z.array(
      z.object({
        label: z.string(),
        annualSatang: nonNegativeSatangSchema,
        appliedSatang: nonNegativeSatangSchema,
      }),
    ),
    totalSatang: nonNegativeSatangSchema,
  }),
  pnlComplete: z.boolean(),
  incompleteReasons: z.array(z.string()),
  foodCostMayBeCountedTwice: z.boolean(),
  filing: z.object({
    mustFile: z.boolean(),
    incomeOverSatang: nonNegativeSatangSchema,
    window: windowSchema,
    pastDue: z.boolean(),
  }),
  watch: z.object({
    vat: z.object({
      status: z.enum(['below', 'near', 'over']),
      revenueSatang: nonNegativeSatangSchema,
      registrationOverSatang: nonNegativeSatangSchema,
      percentOfThreshold: z.number().int().min(0),
    }),
    ePayment: z
      .object({
        status: z.enum(['below', 'near', 'reached']),
        count: z.number().int().min(0),
        totalSatang: nonNegativeSatangSchema,
        transferCount: z.number().int(),
        altTransferCount: z.number().int(),
        altTotalSatang: nonNegativeSatangSchema,
      })
      .nullable(),
  }),
  notes: z.array(z.enum(TAX_NOTE_KEYS)),
  sources: z.array(ruleSourceSchema),
});
export type TaxReport = z.infer<typeof taxReportSchema>;
