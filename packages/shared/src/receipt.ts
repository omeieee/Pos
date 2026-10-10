/**
 * Receipts (owner decisions 2026-10-11). The shop's tax ID and address are two settings the owner
 * enters (`settings.receipt`: owner only, step-up, audit); nothing real ships in the code or the
 * seed, and both stay empty until then (the receipt then simply omits those lines).
 * Issuing a receipt is an audited, idempotent staff action that returns what the receipt prints.
 *
 * Pure: no I/O.
 */
import { z } from 'zod';
import { orderDtoSchema } from './orders.ts';
import { paymentDtoSchema } from './payments.ts';

const expectedVersion = z.number().int().min(0);
const isoInstant = z.iso.datetime();
const addressText = z.string().trim().min(1).max(200);

/** Thai tax ID (and national ID): 13 digits, the last one a check digit over the first 12. */
export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

export const thaiTaxIdSchema = z
  .string()
  .refine(isValidThaiTaxId, { message: 'a 13-digit Thai tax ID with a valid check digit' });

export const receiptSettingsSchema = z.object({
  taxId: thaiTaxIdSchema.nullable().default(null),
  address: addressText.nullable().default(null),
});
export type ReceiptSettings = z.infer<typeof receiptSettingsSchema>;

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = { taxId: null, address: null };

export const receiptPatchInputSchema = z
  .strictObject({
    expectedVersion,
    taxId: thaiTaxIdSchema.nullable().optional(),
    address: addressText.nullable().optional(),
  })
  .refine((v) => v.taxId !== undefined || v.address !== undefined, {
    message: 'give at least one field to change',
    path: ['expectedVersion'],
  });
export type ReceiptPatchInput = z.infer<typeof receiptPatchInputSchema>;

/** `clientRequestId` is the idempotency key. Nothing else is sent: the server knows the order. */
export const issueReceiptInputSchema = z.strictObject({ clientRequestId: z.uuid() });
export type IssueReceiptInput = z.infer<typeof issueReceiptInputSchema>;

export const receiptResponseSchema = z.object({
  issuedAt: isoInstant,
  shop: z.object({
    nameTh: z.string(),
    nameEn: z.string().nullable(),
    phone: z.string().nullable(),
    /** Empty until the owner enters it in Settings: print no tax ID line then. */
    taxId: z.string().nullable(),
    /** The receipt address, empty until the owner enters it: print no address line then. */
    address: z.string().nullable(),
  }),
  order: orderDtoSchema,
  /** The confirmed payment this receipt is for. */
  payment: paymentDtoSchema,
});
export type ReceiptResponse = z.infer<typeof receiptResponseSchema>;
