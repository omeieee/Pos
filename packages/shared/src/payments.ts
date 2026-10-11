/**
 * Payment API shapes (02 §4.2–4.4, §6; 03 §3–4). Pure; no I/O.
 *
 * - Requests never carry an amount: the server charges the order total (CLAUDE.md rule 1). Every
 *   request object is strict, so a client that sends `amountSatang` or `total` gets a 400 instead
 *   of having it silently dropped. Cash sends only what the customer handed over (`tendered`).
 * - Responses never carry the PromptPay ID or a QR payload (the payload holds the ID in clear).
 *   They show the masked target only; the QR picture is served by its own signed URL and rebuilt
 *   from the current setting every time.
 */
import { z } from 'zod';
import { cashAmountSchema } from './cash.ts';
import { PAYMENT_STATUSES } from './enums.ts';
import { orderDtoSchema } from './orders.ts';
import { REFUND_METHODS } from './payment-adjustment.ts';
import { nonNegativeSatangSchema, paymentMethodSchema } from './schemas.ts';

const isoInstant = z.iso.datetime();
const version = z.number().int().min(1);
const note = z.string().trim().min(1).max(200);

export const paymentIdParamSchema = z.object({ id: z.uuid() });

// ---------- Requests ----------

/** The fields every way of paying shares. `clientRequestId` is the idempotency key. */
const choice = {
  clientRequestId: z.uuid(),
  /** Free text: a bank or ถุงเงิน reference, or what "other" means. */
  referenceNote: note.optional(),
};

/**
 * Starts a payment for an order. Cash needs `tendered` (what the customer handed over) and is
 * recorded as already confirmed; every other method must not send it.
 */
export const createPaymentInputSchema = z.discriminatedUnion('method', [
  z.strictObject({
    ...choice,
    method: z.literal('cash'),
    tendered: cashAmountSchema,
    /** Owner only: the cashier who took this cash before the owner took over the outbox. */
    originalStaffId: z.uuid().optional(),
  }),
  z.strictObject({ ...choice, method: z.literal('promptpay') }),
  z.strictObject({ ...choice, method: z.literal('gov_copay') }),
  z.strictObject({ ...choice, method: z.literal('platform') }),
  z.strictObject({ ...choice, method: z.literal('other') }),
]);
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

/** The same choice for the replacement payment, plus an optional version check on the old one. */
export const changePaymentMethodInputSchema = z.discriminatedUnion('method', [
  z.strictObject({
    ...choice,
    expectedVersion: version.optional(),
    method: z.literal('cash'),
    tendered: cashAmountSchema,
  }),
  z.strictObject({
    ...choice,
    expectedVersion: version.optional(),
    method: z.literal('promptpay'),
  }),
  z.strictObject({
    ...choice,
    expectedVersion: version.optional(),
    method: z.literal('gov_copay'),
  }),
  z.strictObject({ ...choice, expectedVersion: version.optional(), method: z.literal('platform') }),
  z.strictObject({ ...choice, expectedVersion: version.optional(), method: z.literal('other') }),
]);
export type ChangePaymentMethodInput = z.infer<typeof changePaymentMethodInputSchema>;

/**
 * Moves that need no data. `expectedVersion` is optional: a payment already in the target status
 * answers 200 without a write (a retry), and the state machine refuses any other stale move.
 */
export const claimPaymentInputSchema = z.strictObject({ expectedVersion: version.optional() });
export type ClaimPaymentInput = z.infer<typeof claimPaymentInputSchema>;

export const confirmPaymentInputSchema = z.strictObject({
  expectedVersion: version.optional(),
  /** The ถุงเงิน or bank reference staff saw. */
  referenceNote: note.optional(),
});
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentInputSchema>;

/** Cancel-claimed, void and refund all need a reason (03 §4). */
export const paymentReasonInputSchema = z.strictObject({
  expectedVersion: version.optional(),
  reason: note,
});
export type PaymentReasonInput = z.infer<typeof paymentReasonInputSchema>;

// ---------- Responses ----------

export const paymentDtoSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  method: paymentMethodSchema,
  status: z.enum(PAYMENT_STATUSES),
  /** What this payment charges: the order total, or the difference left after confirmed money (a top-up). */
  amountSatang: nonNegativeSatangSchema,
  tenderedSatang: nonNegativeSatangSchema.nullable(),
  changeSatang: nonNegativeSatangSchema.nullable(),
  /** Last characters of the PromptPay ID the QR pays to; never the whole ID. */
  promptpayTargetMasked: z.string().nullable(),
  schemeId: z.uuid().nullable(),
  /** ESTIMATES (the app decides the real split): the government share and the customer share. */
  estGovShareSatang: nonNegativeSatangSchema.nullable(),
  estCustomerShareSatang: nonNegativeSatangSchema.nullable(),
  referenceNote: z.string().nullable(),
  claimedAt: isoInstant.nullable(),
  confirmedByStaffId: z.uuid().nullable(),
  confirmedAt: isoInstant.nullable(),
  /** Why a claimed payment was cancelled, or a confirmed one voided or refunded. */
  reason: z.string().nullable(),
  version,
  rev: z.number().int().min(0),
});
export type PaymentDto = z.infer<typeof paymentDtoSchema>;

/** What a payment change returns: the payment and the order it belongs to (its payment status moved). */
export const paymentResultSchema = z.object({ payment: paymentDtoSchema, order: orderDtoSchema });
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export const changePaymentMethodResultSchema = z.object({
  payment: paymentDtoSchema,
  cancelledPayment: paymentDtoSchema,
  order: orderDtoSchema,
});
export type ChangePaymentMethodResult = z.infer<typeof changePaymentMethodResultSchema>;

/** A partial refund of a confirmed payment: money handed back after the owner lowered the order. */
export const paymentRefundDtoSchema = z.object({
  id: z.uuid(),
  paymentId: z.uuid(),
  amountSatang: nonNegativeSatangSchema,
  method: z.enum(REFUND_METHODS),
  referenceNote: z.string().nullable(),
  reason: z.string(),
  refundedAt: isoInstant,
});
export type PaymentRefundDto = z.infer<typeof paymentRefundDtoSchema>;

export const orderPaymentsResponseSchema = z.object({
  payments: z.array(paymentDtoSchema),
  /** Partial refunds of this order's payments, oldest first. Always sent by the server. */
  refunds: z.array(paymentRefundDtoSchema).optional(),
  /** Confirmed money minus partial refunds. Always sent by the server. */
  netPaidSatang: nonNegativeSatangSchema.optional(),
  /**
   * What is still to collect: the order total minus `netPaidSatang`, never below zero. A new payment
   * charges exactly this (the QR and the cash change use `payment.amountSatang`).
   */
  dueSatang: nonNegativeSatangSchema.optional(),
  /**
   * The payments of this order that have a slip image to look at (`GET /v1/payments/:id/slip`).
   * Only a list of ids, and only on this REST answer: a slip is never in realtime frames or sync.
   */
  slipPaymentIds: z.array(z.uuid()).optional(),
});
export type OrderPaymentsResponse = z.infer<typeof orderPaymentsResponseSchema>;

/** A short-lived link for an `<img>`: the signature in it is the only authentication. */
export const paymentQrUrlResponseSchema = z.object({
  /** Path and query on the API origin, e.g. `/v1/payments/<id>/qr.png?exp=…&sig=…`. */
  url: z.string(),
  expiresAt: isoInstant,
  /**
   * The PromptPay target the picture will pay to RIGHT NOW (last characters only). The payment's
   * own `promptpayTargetMasked` is what it was when the payment was made; if the owner has changed
   * the ID since, this is the one staff should compare with their bank app.
   */
  promptpayTargetMasked: z.string(),
});
export type PaymentQrUrlResponse = z.infer<typeof paymentQrUrlResponseSchema>;
