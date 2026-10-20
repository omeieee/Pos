/**
 * Report API shapes (P6). The numbers come from `@sds/finance`; these schemas are only the wire
 * contract for `GET /v1/reports/revenue`.
 */
import { z } from 'zod';
import { ORDER_CHANNELS, PAYMENT_METHODS } from './enums.ts';
import { isoDateSchema, nonNegativeSatangSchema, satangSchema } from './schemas.ts';

/** Longest range one report call may cover: a leap year. */
export const REPORT_MAX_DAYS = 366;

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to` inclusive; both are ISO dates (UTC midnight, so no DST). */
export function reportRangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export const revenueReportQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => reportRangeDays(q.from, q.to) <= REPORT_MAX_DAYS, {
    message: `the range must not exceed ${REPORT_MAX_DAYS} days`,
    path: ['to'],
  });
export type RevenueReportQuery = z.infer<typeof revenueReportQuerySchema>;

/**
 * Orders left out of the figures because their refunds exceed their payment (a data fault). The
 * screen shows a warning so the owner can look at them; the rest of the report is still right.
 */
export const excludedOrderIdsSchema = z.array(z.string());

export const dayRevenueSchema = z.object({
  businessDate: isoDateSchema,
  revenueSatang: nonNegativeSatangSchema,
  orderCount: z.number().int().min(1),
  averageTicketSatang: nonNegativeSatangSchema,
  commissionSatang: nonNegativeSatangSchema,
  byChannel: z.partialRecord(z.enum(ORDER_CHANNELS), nonNegativeSatangSchema),
  byMethod: z.partialRecord(z.enum(PAYMENT_METHODS), nonNegativeSatangSchema),
});
export type DayRevenueDto = z.infer<typeof dayRevenueSchema>;

/**
 * Gross profit over the orders whose every line has a cost (D-32). Revenue here is net paid; cost
 * is the snapshot saved on each line. Orders with an uncosted line are left out of the margin and
 * named, never guessed. Gross profit is before platform commission and expenses; it is negative
 * for a loss, and `null` (with `marginBp`) when no order is costed or there is no revenue.
 */
export const periodMarginSchema = z.object({
  costedOrderCount: z.number().int().min(0),
  costedRevenueSatang: nonNegativeSatangSchema,
  costSatang: nonNegativeSatangSchema,
  grossProfitSatang: satangSchema.nullable(),
  /** Basis points (10000 = 100%), half away from zero. */
  marginBp: z.number().int().nullable(),
  uncostedOrderIds: z.array(z.string()),
  uncostedRevenueSatang: nonNegativeSatangSchema,
  uncostedMenuItemIds: z.array(z.string()),
});
export type PeriodMarginDto = z.infer<typeof periodMarginSchema>;

/** The delivery platforms whose commission rate is a setting. */
export const RATED_PLATFORMS = ['grab', 'lineman'] as const;

/**
 * Platform commission, an expense shown beside revenue (D-31, D-32). A figure recorded on the order
 * wins; otherwise Grab and LINE MAN orders are estimated from the rate in settings (no built-in
 * rate). An order with neither is named in `rateNotSetOrderIds` and is not in `totalSatang`.
 */
export const commissionSummarySchema = z.object({
  recordedSatang: nonNegativeSatangSchema,
  recordedOrderCount: z.number().int().min(0),
  estimatedSatang: nonNegativeSatangSchema,
  estimatedOrderCount: z.number().int().min(0),
  totalSatang: nonNegativeSatangSchema,
  rateNotSetOrderIds: z.array(z.string()),
  ratesNotSet: z.array(z.enum(RATED_PLATFORMS)),
});
export type CommissionSummaryDto = z.infer<typeof commissionSummarySchema>;

/** Only business dates with at least one counted order appear, oldest first. */
export const revenueReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  excludedOrderIds: excludedOrderIdsSchema,
  days: z.array(dayRevenueSchema),
  totals: z.object({
    revenueSatang: nonNegativeSatangSchema,
    orderCount: z.number().int().min(0),
    /** Commission recorded on the orders only; the estimate is in `commission`. */
    commissionSatang: nonNegativeSatangSchema,
  }),
  margin: periodMarginSchema,
  commission: commissionSummarySchema,
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

/** Why a profit and loss answer is not complete (D-33). */
export const PNL_INCOMPLETE_REASONS = [
  'orders_excluded',
  'orders_uncosted',
  'commission_rate_not_set',
] as const;

/**
 * Which side of an overlapping pair is deducted when both are above 0 in the period (owner-approved
 * 2026-10-21): cost of goods vs the `ingredients` expense, commission vs the `platform_fees` expense.
 * `only_one` also covers "neither": there is no overlap. A tie goes to cost of goods / commission.
 */
export const FOOD_COST_BASES = ['cost_of_goods', 'ingredients_expenses', 'only_one'] as const;
export const PLATFORM_FEES_BASES = ['commission', 'platform_fees_expenses', 'only_one'] as const;

const pnlFiguresShape = {
  revenueSatang: nonNegativeSatangSchema,
  orderCount: z.number().int().min(0),
  /** Cost of the fully costed orders only; an order with an uncosted line has none here. */
  costOfGoodsSatang: nonNegativeSatangSchema,
  /** Net paid of the counted orders left out of `costOfGoodsSatang`. */
  uncostedRevenueSatang: nonNegativeSatangSchema,
  /** Revenue - cost of goods. Negative for a loss. */
  grossProfitSatang: satangSchema,
  /** Recorded plus estimated platform commission; orders with "rate not set" are not in it. */
  commissionSatang: nonNegativeSatangSchema,
  /** Unvoided expense rows, every category (platform_fees and ingredients included, commission not). Raw. */
  expensesSatang: nonNegativeSatangSchema,
  /** The smaller of cost of goods and the `ingredients` expense when both are above 0, else 0. Not deducted. */
  foodCostNotDeductedSatang: nonNegativeSatangSchema,
  /** The smaller of commission and the `platform_fees` expense when both are above 0, else 0. Not deducted. */
  platformFeesNotDeductedSatang: nonNegativeSatangSchema,
  /**
   * Gross profit - commission - expenses + the two "not deducted" amounts, before income tax.
   * Negative for a loss.
   */
  netProfitSatang: satangSchema,
  /** False when anything is missing; the profit is then at most this high, never lower. */
  complete: z.boolean(),
};

export const pnlMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  ...pnlFiguresShape,
});
export type PnlMonthDto = z.infer<typeof pnlMonthSchema>;

/**
 * Profit and loss for a range, owner only (`finance.pnl`). An estimate for the owner, not a filing.
 * `missing` lists what is not in the figures; nothing is guessed. `months` has one row per calendar
 * month with data, only when the range touches more than one month (the end months may be partial).
 * `govCopay.receivable` is 'not_tracked': when the government's share arrives is not tracked (owner decision 2026-10-21).
 */
export const pnlReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  ...pnlFiguresShape,
  incompleteReasons: z.array(z.enum(PNL_INCOMPLETE_REASONS)),
  missing: z.object({
    excludedOrderIds: z.array(z.string()),
    uncostedOrderIds: z.array(z.string()),
    uncostedMenuItemIds: z.array(z.string()),
    rateNotSetOrderIds: z.array(z.string()),
    ratesNotSet: z.array(z.enum(RATED_PLATFORMS)),
  }),
  margin: periodMarginSchema,
  commission: commissionSummarySchema,
  expensesByCategory: z.array(
    z.object({
      category: z.string(),
      totalSatang: nonNegativeSatangSchema,
      count: z.number().int().min(1),
    }),
  ),
  voidedExpenseCount: z.number().int().min(0),
  /** Of cost of goods and the `ingredients` expense, the one that is deducted (the other is raw only). */
  foodCostBasis: z.enum(FOOD_COST_BASES),
  ingredientsExpensesSatang: nonNegativeSatangSchema,
  /** Of commission and the `platform_fees` expense, the one that is deducted (the other is raw only). */
  platformFeesBasis: z.enum(PLATFORM_FEES_BASES),
  platformFeesExpensesSatang: nonNegativeSatangSchema,
  govCopay: z.object({
    revenueSatang: nonNegativeSatangSchema,
    receivable: z.literal('not_tracked'),
  }),
  months: z.array(pnlMonthSchema),
});
export type PnlReport = z.infer<typeof pnlReportSchema>;

export const itemSalesSchema = z.object({
  menuItemId: z.uuid(),
  name: z.string(),
  qty: z.number().int().min(1),
  revenueSatang: nonNegativeSatangSchema,
  unitShareBp: z.number().int().min(0).max(10000),
  popular: z.boolean(),
  /** Units with a cost snapshot; the rest of `qty` had "no cost entered" and is out of the margin. */
  costedQty: z.number().int().min(0),
  costedRevenueSatang: nonNegativeSatangSchema,
  /** Null = no cost entered on any unit sold. */
  costSatang: nonNegativeSatangSchema.nullable(),
  grossProfitSatang: satangSchema.nullable(),
  /** Gross profit / costed revenue, basis points; null when it cannot be stated. */
  marginBp: z.number().int().nullable(),
});
export type ItemSalesDto = z.infer<typeof itemSalesSchema>;

/** Best seller first. Every item sold in the range is listed; the screen picks top and bottom. */
export const itemsReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  excludedOrderIds: excludedOrderIdsSchema,
  items: z.array(itemSalesSchema),
  /** Items sold at least once with no cost entered (their `qty - costedQty` units are out of the margin). */
  uncostedMenuItemIds: z.array(z.string()),
});
export type ItemsReport = z.infer<typeof itemsReportSchema>;

export const heatCellSchema = z.object({
  /** ISO weekday of the business date: Monday 1 ... Sunday 7. */
  weekday: z.number().int().min(1).max(7),
  /** Local hour (Asia/Bangkok) the order was placed. */
  hour: z.number().int().min(0).max(23),
  orderCount: z.number().int().min(1),
  revenueSatang: nonNegativeSatangSchema,
});
export type HeatCellDto = z.infer<typeof heatCellSchema>;

export const heatmapReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  excludedOrderIds: excludedOrderIdsSchema,
  cells: z.array(heatCellSchema),
});
export type HeatmapReport = z.infer<typeof heatmapReportSchema>;

export const CUSTOMER_SEGMENTS = ['new', 'regular', 'lapsed'] as const;
export type CustomerSegmentName = (typeof CUSTOMER_SEGMENTS)[number];

/** The most customers one report call sends (most recent first); the summary still counts everyone. */
export const CUSTOMERS_LISTED = 50;

/** How many favourite items each customer row carries. */
export const FAVOURITE_ITEMS_PER_CUSTOMER = 3;

export const customerReportRowSchema = z.object({
  id: z.uuid(),
  /** Null when we hold no name (a LINE customer who never gave one). */
  name: z.string().nullable(),
  building: z.string().nullable(),
  segment: z.enum(CUSTOMER_SEGMENTS),
  orderCount: z.number().int().min(0),
  totalSpentSatang: nonNegativeSatangSchema,
  firstSeenAt: z.iso.datetime(),
  lastOrderAt: z.iso.datetime().nullable(),
  favourites: z.array(
    z.object({
      menuItemId: z.uuid(),
      name: z.string(),
      qty: z.number().int().min(1),
    }),
  ),
});
export type CustomerReportRow = z.infer<typeof customerReportRowSchema>;

/**
 * Owner only (`customer.report`, PDPA). Anonymised customers are not listed. Most recent order
 * first. `summary` counts the listed customers per segment.
 */
export const customersReportSchema = z.object({
  summary: z.object({
    new: z.number().int().min(0),
    regular: z.number().int().min(0),
    lapsed: z.number().int().min(0),
  }),
  customers: z.array(customerReportRowSchema),
});
export type CustomersReport = z.infer<typeof customersReportSchema>;

/** The cash report's query: a range like the other reports, and `emptyDays=true` to list days with no activity too. */
export const cashReportQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    emptyDays: z.enum(['true', 'false']).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => reportRangeDays(q.from, q.to) <= REPORT_MAX_DAYS, {
    message: `the range must not exceed ${REPORT_MAX_DAYS} days`,
    path: ['to'],
  });
export type CashReportQuery = z.infer<typeof cashReportQuerySchema>;

const receiptsByMethodSchema = z.object({
  cash: nonNegativeSatangSchema,
  promptpay: nonNegativeSatangSchema,
  gov_copay: nonNegativeSatangSchema,
  platform: nonNegativeSatangSchema,
  other: nonNegativeSatangSchema,
});

const cashFiguresShape = {
  receiptsByMethod: receiptsByMethodSchema,
  /** All methods; equals the revenue report's figure for the same days. */
  receiptsSatang: nonNegativeSatangSchema,
  /** The cash column only: confirmed cash payments minus cash refunds (0 while every sale is a transfer). */
  cashInSatang: nonNegativeSatangSchema,
  /** The "buying goods" column of the Revenue Department form (the categories the owner flagged as goods). */
  purchasesSatang: nonNegativeSatangSchema,
  /** Every other unvoided expense. */
  otherExpensesSatang: nonNegativeSatangSchema,
  paymentsSatang: nonNegativeSatangSchema,
};

/**
 * Receipts and payments (D-35), owner only (`finance.pnl`). A working record behind the Revenue
 * Department's รายงานเงินสดรับ-จ่าย, not a filed document. Receipts are all payment methods; expenses
 * are assumed paid from the same account. `runningNetSatang` = the owner's start amount + receipts
 * minus payments since the start date; it is null before that day or when no start amount is set
 * (`openingNotSet`), never 0 for "unknown". It is not a bank statement.
 */
export const cashReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  opening: z.object({ amountSatang: nonNegativeSatangSchema, asOf: isoDateSchema }).nullable(),
  openingNotSet: z.boolean(),
  runningStartSatang: satangSchema.nullable(),
  runningEndSatang: satangSchema.nullable(),
  days: z.array(
    z.object({
      businessDate: isoDateSchema,
      ...cashFiguresShape,
      orderCount: z.number().int().min(0),
      expenseCount: z.number().int().min(0),
      /** Receipts minus payments of the day. */
      netSatang: satangSchema,
      runningNetSatang: satangSchema.nullable(),
    }),
  ),
  totals: z.object({
    ...cashFiguresShape,
    orderCount: z.number().int().min(0),
    expenseCount: z.number().int().min(0),
    receiptsMinusPaymentsSatang: satangSchema,
  }),
  months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), ...cashFiguresShape })),
  excludedOrderIds: excludedOrderIdsSchema,
  /** False when orders were set aside as inconsistent (in the range, or between the opening day and it). */
  complete: z.boolean(),
  reconciliation: z.object({
    revenueReportSatang: nonNegativeSatangSchema,
    differenceSatang: satangSchema,
  }),
});
export type CashReport = z.infer<typeof cashReportSchema>;
