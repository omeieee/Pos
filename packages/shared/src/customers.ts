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
 * The same for the building of an entrance-delivery order whose personal details were erased by
 * the retention job (owner, 2026-10-03: name and building go 30 days after completion). The
 * database check needs a non-empty building, so the text stands in for it.
 */
export const ANONYMIZED_BUILDING = 'ลบข้อมูลแล้ว';

/** The same for the room number of a legacy room-delivery order (`orders_room_delivery_room`). */
export const ANONYMIZED_ROOM_NO = 'ลบข้อมูลแล้ว';

/**
 * How long personal data is kept (owner decisions, 2026-10-03; design/privacy-notice-th.md §3).
 * Days after: a LINE webhook event arrived; an order was completed (or cancelled); a remembered
 * recipient last ordered. Slip images (90 days) are not here: nothing stores slip images yet.
 */
export const RETENTION_DAYS = { lineEvents: 30, orderPersonalData: 30, recipientBook: 30 } as const;

/**
 * The version of the privacy notice a customer acknowledges (`customers.privacy_ack_version`):
 * the date of design/privacy-notice-th.md (and the bot's short summary in `lineBot.privacy.*`).
 * Change it whenever the notice changes in a way customers should see again; the next
 * acknowledgement then records the new version and time. Still the draft's date until the owner
 * approves and publishes the notice.
 */
export const PRIVACY_NOTICE_VERSION = '2026-10-03';

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
