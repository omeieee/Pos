/**
 * Kitchen printing (P8): the print queue's vocabulary, the plain ticket the print program draws,
 * the rules for retries, and the owner's on/off setting. Pure: no I/O.
 *
 * The ticket is built field by field from an order and holds names, places and the order's own
 * words only: never a phone number, a customer id, a picture or an amount of money. Free text a
 * customer typed (a delivery note can hold a phone number) has any phone-like number removed.
 */
import { z } from 'zod';
import { SHOP_TIME_ZONE } from './business-date.ts';
import type { OrderDto } from './orders.ts';
import { fulfillmentSchema, isoDateSchema, orderChannelSchema } from './schemas.ts';

export const PRINT_JOB_KINDS = ['kitchen', 'reprint'] as const;
export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];

export const PRINT_JOB_STATUSES = ['pending', 'claimed', 'printed', 'failed'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/**
 * Why a print failed, as a code and never free text (printer messages can carry addresses). The
 * print program picks one; the server sets `LEASE_EXPIRED` when a job keeps timing out.
 */
export const PRINT_ERROR_CODES = [
  'PRINTER_OFFLINE',
  'OUT_OF_PAPER',
  'COVER_OPEN',
  'TIMEOUT',
  'RENDER_FAILED',
  'LEASE_EXPIRED',
  'OTHER',
] as const;
export type PrintErrorCode = (typeof PRINT_ERROR_CODES)[number];

/** How long a claimed job is held for the print program before another claim may take it. */
export const PRINT_LEASE_SECONDS = 30;
/** Claims of one job before it is marked failed and staff are alerted. */
export const PRINT_MAX_ATTEMPTS = 5;

const RETRY_DELAYS_SECONDS = [5, 15, 45, 135, 135] as const;

/** Seconds to wait before the next claim of a job that has been claimed `attempts` times. */
export function printRetryDelaySeconds(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_SECONDS.length) - 1;
  return RETRY_DELAYS_SECONDS[index] ?? 135;
}

// ---------- The ticket ----------

/** A run of 9 or more digits, with single spaces, dots or dashes between them (Thai digits too). */
const PHONE_LIKE = /\+?[\d๐-๙](?:[ .-]?[\d๐-๙]){8,}/g;

/** Removes anything that looks like a phone number from text a customer typed. */
export function stripPhoneNumbers(text: string): string {
  return text.replace(PHONE_LIKE, '***');
}

const maybeText = (value: string | null | undefined): string | null => {
  const clean = value ? stripPhoneNumbers(value).trim() : '';
  return clean === '' ? null : clean;
};

export const kitchenTicketLineSchema = z.strictObject({
  qty: z.number().int().min(1),
  nameTh: z.string(),
  /** Thai names of the chosen options, in order. */
  modifiers: z.array(z.string()),
  note: z.string().nullable(),
});

/**
 * What the print program draws. Codes, not Thai text: the program chooses the words (source badge,
 * delivery or hand-over label) so they stay in one catalogue.
 */
export const kitchenTicketSchema = z.strictObject({
  /** Display number such as L-012. */
  orderNo: z.string(),
  channel: orderChannelSchema,
  fulfillment: fulfillmentSchema,
  /** Who it is for: a name only (recipient, else nickname, else LINE name). */
  who: z.string().nullable(),
  building: z.string().nullable(),
  /** A room label, only on a legacy room delivery. */
  roomNo: z.string().nullable(),
  deliveryNote: z.string().nullable(),
  orderNote: z.string().nullable(),
  lines: z.array(kitchenTicketLineSchema),
  /** Placement date and time in Asia/Bangkok. */
  placedDate: isoDateSchema,
  placedTime: z.string().regex(/^\d{2}:\d{2}$/),
  reprint: z.boolean(),
  /** 0 for the first print; the sequence number of a reprint. */
  copy: z.number().int().min(0),
});
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHOP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function buildKitchenTicket(
  order: OrderDto,
  options: { reprint: boolean; copy: number },
): KitchenTicket {
  const placed = new Date(order.placedAt);
  return kitchenTicketSchema.parse({
    orderNo: order.orderNo,
    channel: order.channel,
    fulfillment: order.fulfillment,
    who: maybeText(order.recipientName ?? order.member?.nickname ?? order.line?.displayName),
    building: order.deliveryBuilding,
    roomNo: order.roomNo,
    deliveryNote: maybeText(order.deliveryNote),
    orderNote: maybeText(order.note),
    lines: order.items.map((item) => ({
      qty: item.qty,
      nameTh: item.nameTh,
      modifiers: item.modifiers.map((modifier) => modifier.nameTh),
      note: maybeText(item.note),
    })),
    placedDate: dateFormat.format(placed),
    placedTime: timeFormat.format(placed),
    reprint: options.reprint,
    copy: options.copy,
  });
}

// ---------- The queue's API shapes ----------

const isoInstant = z.iso.datetime();

/** A job as staff and the print program see it. No ticket and no personal data. */
export const printJobDtoSchema = z.strictObject({
  id: z.uuid(),
  orderId: z.uuid(),
  orderNo: z.string(),
  kind: z.enum(PRINT_JOB_KINDS),
  /** 0 for the kitchen print; 1, 2, ... for each reprint. */
  seq: z.number().int().min(0),
  status: z.enum(PRINT_JOB_STATUSES),
  attempts: z.number().int().min(0),
  lastError: z.enum(PRINT_ERROR_CODES).nullable(),
  createdAt: isoInstant,
  printedAt: isoInstant.nullable(),
});
export type PrintJobDto = z.infer<typeof printJobDtoSchema>;

export const claimedPrintJobSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(PRINT_JOB_KINDS),
  seq: z.number().int().min(0),
  /** The claim count including this one. */
  attempt: z.number().int().min(1),
  /** Send it back on the ack. */
  leaseToken: z.uuid(),
  leaseUntil: isoInstant,
  ticket: kitchenTicketSchema,
});
export type ClaimedPrintJob = z.infer<typeof claimedPrintJobSchema>;

/** `job` is null when nothing is waiting: the print program asks again a moment later. */
export const claimPrintJobResponseSchema = z.strictObject({
  job: claimedPrintJobSchema.nullable(),
});
export type ClaimPrintJobResponse = z.infer<typeof claimPrintJobResponseSchema>;

/**
 * `printed`: the paper came out (idempotent: a second ack of a printed job changes nothing).
 * `failed`: it did not, with a code; the server retries with a delay and fails the job after
 * `PRINT_MAX_ATTEMPTS`. A failed ack must carry the lease it was claimed with.
 */
export const printAckInputSchema = z.discriminatedUnion('result', [
  z.strictObject({ leaseToken: z.uuid(), result: z.literal('printed') }),
  z.strictObject({
    leaseToken: z.uuid(),
    result: z.literal('failed'),
    errorCode: z.enum(PRINT_ERROR_CODES),
  }),
]);
export type PrintAckInput = z.infer<typeof printAckInputSchema>;

export const printJobIdParamSchema = z.object({ id: z.uuid() });

export const listPrintJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const listPrintJobsResponseSchema = z.strictObject({ jobs: z.array(printJobDtoSchema) });
export type ListPrintJobsResponse = z.infer<typeof listPrintJobsResponseSchema>;

/** One reprint per request id: a retry of the same request returns the same job, not another. */
export const reprintOrderInputSchema = z.strictObject({ clientRequestId: z.uuid() });
export type ReprintOrderInput = z.infer<typeof reprintOrderInputSchema>;

// ---------- The owner's switch ----------

/**
 * Whether orders are sent to the print host (owner, 2026-10-22). Off until the owner turns it on.
 * While it is off no kitchen job is created: those orders are skipped, and staff reprint any order
 * once it is on again.
 */
export const printingSettingsSchema = z.object({ enabled: z.boolean().default(false) });
export type PrintingSettings = z.infer<typeof printingSettingsSchema>;

export const DEFAULT_PRINTING: PrintingSettings = { enabled: false };

export const printingPatchInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  enabled: z.boolean(),
});
export type PrintingPatchInput = z.infer<typeof printingPatchInputSchema>;
