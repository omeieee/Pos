/**
 * Delivery rules (owner decision, 2026-10-02). The condominium bans outside visitors, so customers
 * never come to the shop: the shop delivers only to the building entrance, where a security guard
 * is stationed, and the customer comes down to receive the order. There is no delivery fee.
 * Platform orders (Grab, LINE MAN) are handed to the platform's rider.
 *
 * Pure: no I/O.
 */
import { z } from 'zod';
import type { Fulfillment, OrderChannel } from './enums.ts';

/**
 * A building name as the owner enters it and as an order carries it (A1, B2 ...): trimmed, 1 to 10
 * characters. Whether a building is one the shop delivers to is decided against the saved list
 * (`settings.delivery`), which only the server can read.
 */
export const buildingNameSchema = z.string().trim().min(1).max(10);

const ENTRANCE_ONLY: readonly Fulfillment[] = ['entrance_delivery'];
const PLATFORM_ONLY: readonly Fulfillment[] = ['platform_delivery'];

/**
 * Who receives an entrance delivery (owner, 2026-10-02): the building, a name, and an optional
 * free-text note ("other details") such as a room or what the customer is wearing. The order's own
 * `note` stays the kitchen note. This is personal data (PDPA): it never goes into a log line, an
 * alert or a notification.
 */
export const recipientNameSchema = z.string().trim().min(1).max(60);
export const deliveryNoteSchema = z.string().trim().max(200);

/**
 * The key that matches a recipient to a remembered one: the name with Unicode normalised (NFC),
 * trimmed, runs of whitespace collapsed to one space and lower-cased, so "B1 + Fah" matches
 * however it was typed. One definition, used both to store and to look up (never `lower()` in SQL).
 */
export function recipientKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * The fulfilments a new order on this channel may use. Storefront, LINE and phone orders are
 * delivered to the building entrance; Grab and LINE MAN orders go by the platform. The legacy
 * values (`dine_in`, `takeaway`, `pickup`, `room_delivery`) are never offered.
 */
export function allowedFulfillments(channel: OrderChannel): readonly Fulfillment[] {
  switch (channel) {
    case 'storefront':
    case 'line':
    case 'phone':
      return ENTRANCE_ONLY;
    case 'grab':
    case 'lineman':
      return PLATFORM_ONLY;
  }
}
