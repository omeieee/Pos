/**
 * Report API shapes (P6). The numbers come from `@sds/finance`; these schemas are only the wire
 * contract for `GET /v1/reports/revenue`.
 */
import { z } from 'zod';
import { ORDER_CHANNELS, PAYMENT_METHODS } from './enums.ts';
import { isoDateSchema, nonNegativeSatangSchema } from './schemas.ts';

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

/** Only business dates with at least one counted order appear, oldest first. */
export const revenueReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  excludedOrderIds: excludedOrderIdsSchema,
  days: z.array(dayRevenueSchema),
  totals: z.object({
    revenueSatang: nonNegativeSatangSchema,
    orderCount: z.number().int().min(0),
    commissionSatang: nonNegativeSatangSchema,
  }),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

export const itemSalesSchema = z.object({
  menuItemId: z.uuid(),
  name: z.string(),
  qty: z.number().int().min(1),
  revenueSatang: nonNegativeSatangSchema,
  unitShareBp: z.number().int().min(0).max(10000),
  popular: z.boolean(),
});
export type ItemSalesDto = z.infer<typeof itemSalesSchema>;

/** Best seller first. Every item sold in the range is listed; the screen picks top and bottom. */
export const itemsReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  excludedOrderIds: excludedOrderIdsSchema,
  items: z.array(itemSalesSchema),
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
