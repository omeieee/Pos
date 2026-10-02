/**
 * Customer erasure (PDPA, reviewer M2, 2026-10-02). `POST /v1/customers/{id}/anonymize` is the
 * owner's, with step-up. The response never carries personal data.
 */
import { z } from 'zod';

/**
 * Orders are tax records, so an erased customer's orders stay, with the recipient's name replaced
 * by this text (an entrance-delivery order must keep a non-empty name: the database check
 * `orders_entrance_delivery_recipient`) and the delivery note cleared. The building stays. A screen
 * that shows an order's recipient should show this value through i18n as "erased", never raw.
 */
export const ANONYMIZED_RECIPIENT_NAME = 'ลบข้อมูลแล้ว';

/**
 * Why, as a fixed word and not free text: the reason is written to the audit log, which can never
 * be edited, and staff must not be able to type a name into it.
 */
export const ANONYMIZE_REASONS = ['customer_request', 'retention', 'other'] as const;

export const anonymizeCustomerInputSchema = z.strictObject({
  reason: z.enum(ANONYMIZE_REASONS).optional(),
});
export type AnonymizeCustomerInput = z.infer<typeof anonymizeCustomerInputSchema>;

export const anonymizeCustomerResponseSchema = z.object({
  id: z.uuid(),
  anonymizedAt: z.iso.datetime(),
  version: z.number().int().min(1),
});
export type AnonymizeCustomerResponse = z.infer<typeof anonymizeCustomerResponseSchema>;
