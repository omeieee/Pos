/**
 * Settings shapes (02 §6, 03 §3 "settings", CLAUDE.md rules 3, 4, 9). Each resource is one row of
 * the `settings` table (or the `gov_copay_schemes` row) behind GET/PATCH /v1/settings/<name>.
 * A PATCH always carries `expectedVersion`; 0 means "this was never saved yet".
 *
 * Pure: no I/O. Nothing here holds a PromptPay ID or a scheme figure; the owner enters them.
 */
import { z } from 'zod';
import { businessDate, SHOP_TIME_ZONE } from './business-date.ts';
import { buildingNameSchema } from './delivery.ts';
import {
  businessDaySettingsSchema,
  isoDateSchema,
  nonNegativeSatangSchema,
  orderChannelSchema,
  promptpaySettingsSchema,
} from './schemas.ts';

const expectedVersion = z.number().int().min(0);
const isoInstant = z.iso.datetime();

/** A PATCH body must change something besides naming the version. */
function needsAField<T extends { expectedVersion: number }>(v: T): boolean {
  return Object.keys(v).some(
    (k) => k !== 'expectedVersion' && (v as Record<string, unknown>)[k] !== undefined,
  );
}
const needsAFieldMessage = {
  message: 'give at least one field to change',
  path: ['expectedVersion'],
};

// ---------- Common response ----------

/** What GET returns for a key/value setting. `version` 0 means it was never saved: `value` is the default. */
export function settingResponseSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    version: z.number().int().min(0),
    rev: z.number().int().min(0),
    updatedAt: isoInstant.nullable(),
  });
}

// ---------- Shop profile ----------

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const shopSettingsSchema = z.object({
  nameTh: shortText(80),
  nameEn: shortText(80).nullable().default(null),
  phone: shortText(30).nullable().default(null),
  address: shortText(200).nullable().default(null),
});
export type ShopSettings = z.infer<typeof shopSettingsSchema>;

export const DEFAULT_SHOP_SETTINGS: ShopSettings = {
  nameTh: 'แซ่บโดนเส้น',
  nameEn: 'Saap Don Sen',
  phone: null,
  address: null,
};

export const shopPatchInputSchema = z
  .strictObject({
    expectedVersion,
    nameTh: shortText(80).optional(),
    nameEn: shortText(80).nullable().optional(),
    phone: shortText(30).nullable().optional(),
    address: shortText(200).nullable().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type ShopPatchInput = z.infer<typeof shopPatchInputSchema>;

// ---------- Opening hours ----------

export const dayWindowSchema = z
  .strictObject({
    /** Minutes from local midnight; opening included. */
    openMinute: z.number().int().min(0).max(1439),
    /** Closing excluded; 1440 is midnight. */
    closeMinute: z.number().int().min(1).max(1440),
  })
  .refine((w) => w.openMinute < w.closeMinute, {
    message: 'closeMinute must be after openMinute',
    path: ['closeMinute'],
  });
export type DayWindow = z.infer<typeof dayWindowSchema>;

export const OPENING_SERVICES = ['storefront', 'delivery'] as const;
export type OpeningService = (typeof OPENING_SERVICES)[number];

/** A window, or null for "closed". Absent means "no change from the level below". */
const windowOrClosed = dayWindowSchema.nullable();
const dayRuleSchema = z.strictObject({
  storefront: windowOrClosed.optional(),
  delivery: windowOrClosed.optional(),
});
export type DayRule = z.infer<typeof dayRuleSchema>;

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const overrideSchema = z.strictObject({
  date: isoDateSchema,
  /** A closure: both services are closed all day, whatever else is given. */
  closed: z.boolean().default(false),
  storefront: windowOrClosed.optional(),
  delivery: windowOrClosed.optional(),
  note: z.string().trim().max(100).optional(),
});

const weeklySchema = z.strictObject({
  sun: dayRuleSchema.optional(),
  mon: dayRuleSchema.optional(),
  tue: dayRuleSchema.optional(),
  wed: dayRuleSchema.optional(),
  thu: dayRuleSchema.optional(),
  fri: dayRuleSchema.optional(),
  sat: dayRuleSchema.optional(),
});

const uniqueDates = (overrides: readonly { date: string }[]) =>
  new Set(overrides.map((o) => o.date)).size === overrides.length;

/**
 * Opening hours (A3): the seeded shape plus per-weekday rules and per-date overrides.
 * Precedence for a date: override, then weekday rule, then the default `storefront`/`delivery`.
 */
export const openingHoursSchema = z.strictObject({
  storefront: dayWindowSchema,
  delivery: dayWindowSchema,
  weekly: weeklySchema.default({}),
  overrides: z
    .array(overrideSchema)
    .max(400)
    .default([])
    .refine(uniqueDates, { message: 'two overrides for the same date' }),
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

export const DEFAULT_OPENING_HOURS: OpeningHours = {
  storefront: { openMinute: 660, closeMinute: 1380 },
  delivery: { openMinute: 780, closeMinute: 1380 },
  weekly: {},
  overrides: [],
};

export const openingHoursPatchInputSchema = z
  .strictObject({
    expectedVersion,
    storefront: dayWindowSchema.optional(),
    delivery: dayWindowSchema.optional(),
    weekly: weeklySchema.optional(),
    overrides: z
      .array(overrideSchema)
      .max(400)
      .refine(uniqueDates, { message: 'two overrides for the same date' })
      .optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type OpeningHoursPatchInput = z.infer<typeof openingHoursPatchInputSchema>;

/** The window a service is open on a calendar date (`YYYY-MM-DD`, shop time), or null when closed. */
export function openingWindow(
  hours: OpeningHours,
  date: string,
  service: OpeningService,
): DayWindow | null {
  const override = hours.overrides.find((o) => o.date === date);
  if (override) {
    if (override.closed) return null;
    const chosen = override[service];
    if (chosen !== undefined) return chosen;
  }
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()];
  const weekly = weekday ? hours.weekly[weekday]?.[service] : undefined;
  if (weekly !== undefined) return weekly;
  return hours[service];
}

/** Minutes since local midnight of an instant in a time zone (Asia/Bangkok by default). */
export function localMinuteOfDay(instant: Date, timeZone: string = SHOP_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
}

/**
 * Whether a service is open at this instant. The calendar date is the plain local date (cutoff 0),
 * because opening hours belong to the day on the wall clock, not to the business day. Opening
 * included, closing excluded. `window` is today's window (null when closed all day).
 */
export function serviceOpenAt(
  hours: OpeningHours,
  instant: Date,
  service: OpeningService,
  timeZone: string = SHOP_TIME_ZONE,
): { open: boolean; window: DayWindow | null } {
  const window = openingWindow(hours, businessDate(instant, 0, timeZone), service);
  if (!window) return { open: false, window: null };
  const minute = localMinuteOfDay(instant, timeZone);
  return { open: minute >= window.openMinute && minute < window.closeMinute, window };
}

// ---------- Numbering and business day ----------

export const numberingPatchInputSchema = z
  .strictObject({
    expectedVersion,
    cutoffMinutes: businessDaySettingsSchema.shape.cutoffMinutes.optional(),
    timeZone: businessDaySettingsSchema.shape.timeZone.optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type NumberingPatchInput = z.infer<typeof numberingPatchInputSchema>;

// ---------- Delivery buildings ----------

/** Most buildings the list may hold. */
export const MAX_DELIVERY_BUILDINGS = 30;

/**
 * Where the shop delivers (owner, 2026-10-02): the condominium bans outside visitors, so every
 * order is delivered to the entrance of one of these buildings, where a guard is stationed and the
 * customer comes down to receive it. 1 to 30 unique names (ignoring case), each 1 to 10 characters.
 * A new order must name one of them. The owner edits the list.
 */
export const deliverySettingsSchema = z.object({
  buildings: z
    .array(buildingNameSchema)
    .min(1)
    .max(MAX_DELIVERY_BUILDINGS)
    .refine((names) => new Set(names.map((n) => n.toLowerCase())).size === names.length, {
      message: 'two buildings with the same name',
    }),
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  buildings: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'],
};

/** PUT (or PATCH) replaces the whole list. */
export const deliveryPatchInputSchema = z.strictObject({
  expectedVersion,
  buildings: deliverySettingsSchema.shape.buildings,
});
export type DeliveryPatchInput = z.infer<typeof deliveryPatchInputSchema>;

// ---------- Payment methods ----------

/** Which methods staff may offer. The government co-pay scheme has its own switch (`enabled`). */
export const paymentsSettingsSchema = z.object({
  cash: z.boolean().default(true),
  promptpay: z.boolean().default(true),
  platform: z.boolean().default(true),
  other: z.boolean().default(false),
});
export type PaymentsSettings = z.infer<typeof paymentsSettingsSchema>;

export const paymentsPatchInputSchema = z
  .strictObject({
    expectedVersion,
    cash: z.boolean().optional(),
    promptpay: z.boolean().optional(),
    platform: z.boolean().optional(),
    other: z.boolean().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type PaymentsPatchInput = z.infer<typeof paymentsPatchInputSchema>;

// ---------- PromptPay ID ----------

export const promptpayPatchInputSchema = z.intersection(
  z.object({ expectedVersion }),
  promptpaySettingsSchema,
);
export type PromptpayPatchInput = z.infer<typeof promptpayPatchInputSchema>;

/** For audit rows and messages: only the last four characters survive. */
export function maskPromptpayId(value: string): string {
  const keep = Math.min(4, Math.max(0, value.length - 2));
  return `${'*'.repeat(value.length - keep)}${value.slice(value.length - keep)}`;
}

// ---------- Government co-pay scheme ----------

/** The scheme row: the fields `govCopaySchemeSchema` knows, plus what screens show. */
export const govCopayDtoSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  settlementNote: z.string().nullable(),
  version: z.number().int().min(1),
  rev: z.number().int().min(0),
  govShareBp: z.number().int().min(0).max(10000),
  govDailyCapSatang: nonNegativeSatangSchema.nullable(),
  govTotalCapSatang: nonNegativeSatangSchema.nullable(),
  activeFrom: isoDateSchema,
  activeTo: isoDateSchema,
  activeFromMinute: z.number().int().min(0).max(1440),
  activeToMinute: z.number().int().min(0).max(1440),
  channels: z.array(orderChannelSchema),
  enabled: z.boolean(),
});
export type GovCopayDto = z.infer<typeof govCopayDtoSchema>;

export const govCopayResponseSchema = z.object({ scheme: govCopayDtoSchema.nullable() });
export type GovCopayResponse = z.infer<typeof govCopayResponseSchema>;

const schemeFields = {
  nameTh: shortText(80).optional(),
  nameEn: shortText(80).nullable().optional(),
  settlementNote: z.string().trim().max(300).nullable().optional(),
  govShareBp: z.number().int().min(0).max(10000).optional(),
  govDailyCapSatang: nonNegativeSatangSchema.nullable().optional(),
  govTotalCapSatang: nonNegativeSatangSchema.nullable().optional(),
  activeFrom: isoDateSchema.optional(),
  activeTo: isoDateSchema.optional(),
  activeFromMinute: z.number().int().min(0).max(1440).optional(),
  activeToMinute: z.number().int().min(0).max(1440).optional(),
  channels: z.array(orderChannelSchema).optional(),
  enabled: z.boolean().optional(),
};

/**
 * Changes to the scheme. The service merges them onto the row and checks the result with
 * `govCopaySchemeSchema` (dates and hours consistent) before anything is saved. With no row yet
 * (`expectedVersion` 0) the body must carry every field and `nameTh`; `code` is then optional.
 */
export const govCopayPatchInputSchema = z
  .strictObject({ expectedVersion, code: shortText(60).optional(), ...schemeFields })
  .refine(needsAField, needsAFieldMessage);
export type GovCopayPatchInput = z.infer<typeof govCopayPatchInputSchema>;
