/**
 * Order API shapes (02 §6). Responses never carry cost fields: a kitchen device must not see
 * what a bowl costs. Requests never carry prices; the server computes every amount.
 */
import { z } from 'zod';
import { ORDER_PAYMENT_STATUSES, ORDER_STATUSES } from './enums.ts';
import { memberProfileSchema } from './member.ts';
import { adjustRefundInputSchema, CORRECTION_PAYMENT_ACTIONS } from './payment-adjustment.ts';
import {
  fulfillmentSchema,
  isoDateSchema,
  nonNegativeSatangSchema,
  orderChannelSchema,
} from './schemas.ts';

const isoInstant = z.iso.datetime();
const version = z.number().int().min(1);

export const orderItemModifierDtoSchema = z.object({
  groupId: z.uuid(),
  optionId: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  priceDeltaSatang: z.number().int(),
});

export const orderItemDtoSchema = z.object({
  id: z.uuid(),
  menuItemId: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  /** Base price before modifiers, as saved when the order was placed. */
  unitPriceSatang: nonNegativeSatangSchema,
  qty: z.number().int().min(1),
  modifiers: z.array(orderItemModifierDtoSchema),
  note: z.string().nullable(),
  lineTotalSatang: nonNegativeSatangSchema,
});
export type OrderItemDto = z.infer<typeof orderItemDtoSchema>;

export const orderDtoSchema = z.object({
  id: z.uuid(),
  /** Display number such as S-012 (03 §5). */
  orderNo: z.string(),
  businessDate: isoDateSchema,
  channel: orderChannelSchema,
  fulfillment: fulfillmentSchema,
  roomNo: z.string().nullable(),
  /** Entrance delivery: the building, the recipient and their extra details; null otherwise. */
  deliveryBuilding: z.string().nullable(),
  recipientName: z.string().nullable(),
  deliveryNote: z.string().nullable(),
  customerId: z.uuid().nullable(),
  /**
   * The member profile as it was when the order was placed (owner, 2026-10-11), so staff can tell
   * who it is for: full name, nickname, building, phone. Personal data (PDPA). Null when the
   * customer gave none; absent from an older server.
   */
  member: memberProfileSchema.nullable().optional(),
  status: z.enum(ORDER_STATUSES),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUSES),
  subtotalSatang: nonNegativeSatangSchema,
  discountSatang: nonNegativeSatangSchema,
  totalSatang: nonNegativeSatangSchema,
  note: z.string().nullable(),
  createdByStaffId: z.uuid().nullable(),
  createdOnDeviceId: z.uuid().nullable(),
  placedAt: isoInstant,
  acceptedAt: isoInstant.nullable(),
  readyAt: isoInstant.nullable(),
  completedAt: isoInstant.nullable(),
  cancelledAt: isoInstant.nullable(),
  cancelReason: z.string().nullable(),
  /** Optimistic-lock counter: send it back as `expectedVersion`. */
  version,
  /** Position in the global sync sequence (D-04). */
  rev: z.number().int().min(0),
  items: z.array(orderItemDtoSchema),
});
export type OrderDto = z.infer<typeof orderDtoSchema>;

// ---------- Requests ----------

export const orderIdParamSchema = z.object({ id: z.uuid() });

/** `day` is a business date (cutoff-adjusted, 03 §1); it defaults to the current one. */
export const listOrdersQuerySchema = z.object({
  day: isoDateSchema.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  channel: orderChannelSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const listOrdersResponseSchema = z.object({
  day: isoDateSchema,
  orders: z.array(orderDtoSchema),
});
export type ListOrdersResponse = z.infer<typeof listOrdersResponseSchema>;

/**
 * PATCH changes only the non-money fields. Strict on purpose: a client that sends a total,
 * a status or items gets a 400 instead of having them silently dropped.
 */
export const patchOrderInputSchema = z
  .strictObject({
    expectedVersion: version,
    note: z.string().max(500).nullable().optional(),
    roomNo: z.string().trim().min(1).max(20).nullable().optional(),
  })
  .refine((v) => v.note !== undefined || v.roomNo !== undefined, {
    message: 'give note or roomNo',
    path: ['note'],
  });
export type PatchOrderInput = z.infer<typeof patchOrderInputSchema>;

export const transitionOrderInputSchema = z.object({
  to: z.enum(ORDER_STATUSES),
  reason: z.string().trim().max(200).optional(),
  /** Optional: the status check under the row lock already refuses a stale move. */
  expectedVersion: version.optional(),
});
export type TransitionOrderInput = z.infer<typeof transitionOrderInputSchema>;

export const cancelOrderInputSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  expectedVersion: version.optional(),
});
export type CancelOrderInput = z.infer<typeof cancelOrderInputSchema>;

// ---------- Owner correction of a past order (owner decision, 2026-10-11) ----------

/** What to do with a payment that was confirmed, when the order's money changes or the order is voided. */
export const PAST_ORDER_PAYMENT_ACTIONS = ['void', 'refund'] as const;
export type PastOrderPaymentAction = (typeof PAST_ORDER_PAYMENT_ACTIONS)[number];
export const pastOrderPaymentActionSchema = z.enum(PAST_ORDER_PAYMENT_ACTIONS);

/** Keeps a saved line at the price it was sold at; only the quantity and note can change. */
const keepLineSchema = z.strictObject({
  orderItemId: z.uuid(),
  qty: z.number().int().min(1).max(99),
  note: z.string().max(200).nullable().optional(),
});

/** A new line, priced from the menu as it is now. */
const newLineSchema = z.strictObject({
  menuItemId: z.uuid(),
  qty: z.number().int().min(1).max(99),
  modifierOptionIds: z.array(z.uuid()).max(20).default([]),
  note: z.string().max(200).optional(),
});

/**
 * PATCH /v1/orders/{id}/correction: owner only, fresh step-up, any order. `items` is the whole new
 * list: a saved line you leave out is removed (kept in the database, marked removed), a line with
 * `orderItemId` keeps its saved price, a line with `menuItemId` is new. The server recomputes every
 * total. When the total changes while a payment is claimed or confirmed, `paymentAction` must say
 * what to do with it: `void` or `refund` retire the payments whole (staff collect the new total
 * again), `adjust` keeps the confirmed money and settles only the difference (D-25).
 */
export const correctOrderInputSchema = z
  .strictObject({
    expectedVersion: version,
    reason: z.string().trim().min(1).max(200),
    note: z.string().max(500).nullable().optional(),
    items: z
      .array(z.union([keepLineSchema, newLineSchema]))
      .min(1)
      .max(50)
      .optional(),
    /**
     * `void` and `refund` retire a confirmed payment whole. `adjust` keeps it: a lower total returns
     * the difference (`refund` says how), a higher total leaves a difference staff then collect.
     */
    paymentAction: z.enum(CORRECTION_PAYMENT_ACTIONS).optional(),
    refund: adjustRefundInputSchema.optional(),
  })
  .refine((v) => v.note !== undefined || v.items !== undefined, {
    message: 'give note or items',
    path: ['items'],
  })
  .refine((v) => v.refund === undefined || v.paymentAction === 'adjust', {
    message: 'refund goes with paymentAction adjust',
    path: ['refund'],
  });
export type CorrectOrderInput = z.infer<typeof correctOrderInputSchema>;

/**
 * POST /v1/orders/{id}/void: owner only, fresh step-up, any order that is not already cancelled.
 * The order becomes `cancelled`; its payments are cancelled, or voided or refunded when confirmed
 * (`paymentAction` is then required). `clientRequestId` makes a retry safe.
 */
export const voidOrderInputSchema = z.strictObject({
  clientRequestId: z.uuid(),
  reason: z.string().trim().min(1).max(200),
  expectedVersion: version.optional(),
  paymentAction: pastOrderPaymentActionSchema.optional(),
});
export type VoidOrderInput = z.infer<typeof voidOrderInputSchema>;
