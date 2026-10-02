/**
 * Order API shapes (02 §6). Responses never carry cost fields: a kitchen device must not see
 * what a bowl costs. Requests never carry prices; the server computes every amount.
 */
import { z } from 'zod';
import { ORDER_PAYMENT_STATUSES, ORDER_STATUSES } from './enums.ts';
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
