/**
 * Government co-pay (ไทยช่วยไทย พลัส) rules, pure and configurable (CLAUDE.md rule 4, D-08,
 * docs/04 §3, 02 §4.3). Integer satang only; no floating point.
 *
 * Nothing about a scheme is hardcoded here. Every figure (share, caps, dates, hours, channels,
 * enabled) comes from a `gov_copay_schemes` row, parsed with `govCopaySchemeSchema`.
 *
 * - `estimateGovCopaySplit`: the ESTIMATED split shown next to the full amount that staff type
 *   into ถุงเงิน. The app itself decides the real split.
 * - `isCopayAvailable`: whether the method may be offered right now.
 *
 * Staff still create the ถุงเงิน QR per transaction, it is never sent through LINE, and staff
 * confirm the payment by hand (rules 2 and 4). Revenue is the full amount; it is a receivable
 * until the next-day settlement (docs/04 §3.2).
 */
import { z } from 'zod';
import { businessDate, SHOP_TIME_ZONE } from './business-date.ts';
import type { Fulfillment, OrderChannel } from './enums.ts';
import { applyBasisPoints, type Satang, satang } from './money.ts';
import {
  fulfillmentSchema,
  isoDateSchema,
  nonNegativeSatangSchema,
  orderChannelSchema,
} from './schemas.ts';

/**
 * Sanity limit for the total passed to the estimate: 100,000,000 satang = ฿1,000,000.
 * It is a typo guard, not a business rule. It also keeps `total × basis points` far inside the
 * safe-integer range, so the rounding below is always exact.
 */
export const MAX_COPAY_TOTAL_SATANG = 100_000_000;

/**
 * One `gov_copay_schemes` row (03 §3), in the camelCase names the Drizzle schema returns, so a
 * row can be parsed directly; other columns (id, names, version, rev ...) are dropped.
 *
 * - `govShareBp`: the government's share in basis points (10000 = 100%).
 * - `govDailyCapSatang` / `govTotalCapSatang`: the most the government pays per person per day
 *   and per person for the whole round. `null` means "no cap on file". Both keys are required
 *   so that a cap cannot be forgotten by leaving it out.
 * - `activeFrom` / `activeTo`: first and last calendar date (Asia/Bangkok), both included.
 * - `activeFromMinute` / `activeToMinute`: daily hours as minutes from local midnight, opening
 *   included and closing excluded (0 is 00:00, 1440 is 24:00; hours of 60 and 120 mean
 *   01:00:00 up to 01:59:59).
 * - `channels`: order channels the scheme is configured for (default `['storefront']`).
 * - `enabled`: the owner's switch; a scheme is seeded disabled until the shop is registered.
 */
export const govCopaySchemeSchema = z
  .object({
    govShareBp: z.number().int().min(0).max(10000),
    govDailyCapSatang: nonNegativeSatangSchema.nullable(),
    govTotalCapSatang: nonNegativeSatangSchema.nullable(),
    activeFrom: isoDateSchema,
    activeTo: isoDateSchema,
    activeFromMinute: z.number().int().min(0).max(1440),
    activeToMinute: z.number().int().min(0).max(1440),
    channels: z.array(orderChannelSchema),
    enabled: z.boolean(),
  })
  .refine((s) => s.activeFrom <= s.activeTo, {
    message: 'activeTo must not be before activeFrom',
    path: ['activeTo'],
  })
  .refine((s) => s.activeFromMinute < s.activeToMinute, {
    message: 'activeToMinute must be after activeFromMinute',
    path: ['activeToMinute'],
  });
export type GovCopayScheme = z.infer<typeof govCopaySchemeSchema>;

const copayTotalSchema = nonNegativeSatangSchema.refine(
  (v) => v <= MAX_COPAY_TOTAL_SATANG,
  `must not exceed ${MAX_COPAY_TOTAL_SATANG} satang`,
);

/**
 * Request of the split estimate. Only the total: the server knows the scheme and a client must
 * never supply one. (For an order, the server uses its own order total.)
 */
export const govCopaySplitInputSchema = z.object({ total: copayTotalSchema });
export type GovCopaySplitInput = z.infer<typeof govCopaySplitInputSchema>;

/**
 * Response of the split estimate. `estimate` is the literal `true` so a consumer cannot drop
 * the label: every screen must show the split as an estimate (see `estimateGovCopaySplit`).
 */
export const govCopaySplitEstimateSchema = z
  .object({
    total: copayTotalSchema,
    govShare: nonNegativeSatangSchema,
    customerShare: nonNegativeSatangSchema,
    capped: z.boolean(),
    estimate: z.literal(true),
  })
  .refine((r) => r.govShare + r.customerShare === r.total, {
    message: 'govShare + customerShare must equal total',
    path: ['customerShare'],
  });
export type GovCopaySplitEstimate = z.infer<typeof govCopaySplitEstimateSchema>;

/**
 * Request of the availability check: the order's channel and fulfilment. The scheme and the
 * clock are the server's own; a client-supplied `now` is ignored (stripped).
 */
export const copayAvailabilityInputSchema = z.object({
  channel: orderChannelSchema,
  fulfillment: fulfillmentSchema,
});
export type CopayAvailabilityInput = z.infer<typeof copayAvailabilityInputSchema>;

export const copayAvailabilityResultSchema = z.object({ available: z.boolean() });
export type CopayAvailabilityResult = z.infer<typeof copayAvailabilityResultSchema>;

function assertCap(cap: number | null, label: string): void {
  if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0)) {
    throw new RangeError(
      `${label} must be null or a non-negative whole number of satang, got ${cap}`,
    );
  }
}

/**
 * ESTIMATE of how a total splits between the government and the customer.
 *
 * Rule, in order:
 * 1. `govShare = applyBasisPoints(total, govShareBp)`: the share rounded HALF UP to one satang
 *    (the project's single rounding rule, 03 §1; for example 3 satang at 60% is 1.8, so 2).
 * 2. If a cap is on file, the government share is cut back to the LOWER of the daily cap and
 *    the round cap (`capped` is then true). A `null` cap is ignored.
 * 3. `customerShare = total - govShare`: the customer takes the remainder, so the two shares
 *    always add up to the total exactly and there is no separate rounding on the customer side.
 *
 * Why it is only an estimate: the caps are per person, and we do not know how much of their
 * daily and round allowance THIS customer has already used (only เป๋าตัง knows). The estimate
 * assumes the customer's full allowance is still available, so the government share is an
 * upper bound and the customer share a lower bound. Cashiers type the full total into
 * ถุงเงิน; the app decides the real split. The screen must label this an estimate.
 *
 * Throws `RangeError` for a negative, fractional, unsafe or oversized total
 * (> `MAX_COPAY_TOTAL_SATANG`), a share outside 0-10000 bp, or a negative or fractional cap.
 * It does not check availability; use `isCopayAvailable` for that.
 */
export function estimateGovCopaySplit(
  total: Satang,
  scheme: Pick<GovCopayScheme, 'govShareBp' | 'govDailyCapSatang' | 'govTotalCapSatang'>,
): GovCopaySplitEstimate {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_COPAY_TOTAL_SATANG) {
    throw new RangeError(
      `total must be a whole number of satang from 0 to ${MAX_COPAY_TOTAL_SATANG}, got ${total}`,
    );
  }
  assertCap(scheme.govDailyCapSatang, 'govDailyCapSatang');
  assertCap(scheme.govTotalCapSatang, 'govTotalCapSatang');

  const exactTotal = satang(total + 0); // turns a stray -0 into +0
  const uncapped = applyBasisPoints(exactTotal, scheme.govShareBp);
  let govShare: number = uncapped;
  for (const cap of [scheme.govDailyCapSatang, scheme.govTotalCapSatang]) {
    if (cap !== null && cap < govShare) govShare = cap;
  }
  return {
    total: exactTotal,
    govShare: satang(govShare),
    customerShare: satang(exactTotal - govShare),
    capped: govShare < uncapped,
    estimate: true,
  };
}

/**
 * Fulfilments where staff and the customer meet face to face (owner, 2026-10-02, replacing "only
 * at the storefront"): at the counter, or at the building entrance when staff hand the order over
 * (`entrance_delivery`; the customer scans the ถุงเงิน QR that staff create on the spot). The old
 * counter values stay for history. The legacy room delivery is not allowed, and platform delivery
 * is paid through the platform. An allow-list, so any future fulfilment defaults to "not available".
 */
const FACE_TO_FACE_FULFILLMENTS: readonly Fulfillment[] = [
  'dine_in',
  'takeaway',
  'pickup',
  'entrance_delivery',
];

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Seconds since local midnight in the given time zone (0-86399). */
function secondOfDayIn(timeZone: string, instant: Date): number {
  let fmt = clockFormatters.get(timeZone);
  if (!fmt) {
    // h23 keeps midnight as 00, never 24.
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    clockFormatters.set(timeZone, fmt);
  }
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;
  for (const part of fmt.formatToParts(instant)) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60)) {
    throw new RangeError(`could not read the local time in ${timeZone}`);
  }
  return hour * 3600 + minute * 60 + second;
}

/**
 * Whether the government co-pay method may be offered for an order right now. True only when
 * ALL of these hold; otherwise false:
 * - the scheme is `enabled`;
 * - `channel` is `'storefront'` (a hard rule, CLAUDE.md rule 4) and the scheme lists it;
 * - `fulfillment` is face to face: `entrance_delivery` (staff hand it over at the building
 *   entrance) or the legacy `dine_in`, `takeaway`, `pickup` (never `room_delivery` or
 *   `platform_delivery`);
 * - the local calendar date is within `activeFrom`..`activeTo`, both included;
 * - the local time of day is within `[activeFromMinute, activeToMinute)`: opening included,
 *   closing excluded, so 23:00:00 is already closed when the hours end at 23:00.
 *
 * Dates and hours are WALL-CLOCK time in `timeZone` (default Asia/Bangkok), not the business
 * date: the 04:00 business-day cutoff does not apply. `now` is the server's clock. An invalid
 * `now` throws `RangeError`.
 *
 * `channel` is the channel of the payment, not of the order. A LINE or phone order that staff
 * hand over (and take the payment for) face to face is paid like a storefront one, so the payment
 * service passes `'storefront'` for it; a `'line'` here is refused. Grab and LINE MAN orders are
 * never eligible. The ถุงเงิน QR is never sent through LINE.
 */
export function isCopayAvailable(
  scheme: Pick<
    GovCopayScheme,
    'enabled' | 'channels' | 'activeFrom' | 'activeTo' | 'activeFromMinute' | 'activeToMinute'
  >,
  now: Date,
  channel: OrderChannel,
  fulfillment: Fulfillment,
  timeZone: string = SHOP_TIME_ZONE,
): boolean {
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid instant');
  if (!scheme.enabled) return false;
  if (channel !== 'storefront' || !scheme.channels.includes('storefront')) return false;
  if (!FACE_TO_FACE_FULFILLMENTS.includes(fulfillment)) return false;

  // Cutoff 0: the plain local calendar date (ISO dates compare correctly as text).
  const today = businessDate(now, 0, timeZone);
  if (today < scheme.activeFrom || today > scheme.activeTo) return false;

  const second = secondOfDayIn(timeZone, now);
  return second >= scheme.activeFromMinute * 60 && second < scheme.activeToMinute * 60;
}
