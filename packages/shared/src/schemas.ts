import { z } from 'zod';
import { businessDate } from './business-date.ts';
import { buildingNameSchema, deliveryNoteSchema, recipientNameSchema } from './delivery.ts';
import { FULFILLMENTS, ORDER_CHANNELS, PAYMENT_METHODS, STAFF_ROLES } from './enums.ts';
import { type Satang, satang } from './money.ts';

/** Satang crossing a boundary: a safe integer, branded after validation. */
export const satangSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, 'must be a safe integer')
  .transform((v): Satang => satang(v));

export const nonNegativeSatangSchema = satangSchema.refine((v) => v >= 0, 'must not be negative');

export const orderChannelSchema = z.enum(ORDER_CHANNELS);
export const fulfillmentSchema = z.enum(FULFILLMENTS);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const staffRoleSchema = z.enum(STAFF_ROLES);

export const isoDateSchema = z.iso.date();

/** settings.promptpay (01 P3). The ID is never hardcoded; it lives in settings. */
export const promptpaySettingsSchema = z.discriminatedUnion('idType', [
  z.object({ idType: z.literal('phone'), idValue: z.string().regex(/^0\d{9}$/) }),
  z.object({ idType: z.literal('national_id'), idValue: z.string().regex(/^\d{13}$/) }),
  z.object({ idType: z.literal('ewallet'), idValue: z.string().regex(/^\d{15}$/) }),
]);
export type PromptpaySettings = z.infer<typeof promptpaySettingsSchema>;

/** settings.business_day (D-11). */
export const businessDaySettingsSchema = z.object({
  cutoffMinutes: z.number().int().min(0).max(1439),
  timeZone: z.string().refine((tz) => {
    try {
      businessDate(new Date(0), 0, tz);
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone'),
});
export type BusinessDaySettings = z.infer<typeof businessDaySettingsSchema>;

/** POST /v1/orders body. Prices are NOT accepted from clients; the server computes them. */
export const createOrderInputSchema = z
  .object({
    clientRequestId: z.uuid(),
    channel: orderChannelSchema,
    fulfillment: fulfillmentSchema,
    roomNo: z.string().trim().min(1).max(20).optional(),
    /** Entrance delivery: where, to whom, and anything else the guard or the rider should know. */
    deliveryBuilding: buildingNameSchema.optional(),
    recipientName: recipientNameSchema.optional(),
    deliveryNote: deliveryNoteSchema.optional(),
    customerId: z.uuid().optional(),
    note: z.string().max(500).optional(),
    items: z
      .array(
        z.object({
          menuItemId: z.uuid(),
          qty: z.number().int().min(1).max(99),
          modifierOptionIds: z.array(z.uuid()).max(20).default([]),
          note: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine((o) => o.fulfillment !== 'room_delivery' || o.roomNo !== undefined, {
    message: 'roomNo is required for room delivery',
    path: ['roomNo'],
  })
  .superRefine((o, ctx) => {
    // An entrance delivery needs its building and recipient name; no other fulfilment carries
    // them (a refusal, never a silent drop). Whether the building is one of the configured ones,
    // and whether the channel offers this fulfilment, are decided by the server.
    const entrance = o.fulfillment === 'entrance_delivery';
    for (const field of ['deliveryBuilding', 'recipientName', 'deliveryNote'] as const) {
      const given = o[field] !== undefined;
      const required = field !== 'deliveryNote';
      if (entrance && required && !given) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required` });
      } else if (!entrance && given) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is only for entrance delivery`,
        });
      }
    }
  });
export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;
