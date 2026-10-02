/**
 * Delivery rules (owner decision, 2026-10-02). The condominium bans outside visitors, so customers
 * never come to the shop: the shop delivers only to the building entrance, where a security guard
 * is stationed, and the customer comes down to receive the order. There is no delivery fee.
 * Platform orders (Grab, LINE MAN) are handed to the platform's rider.
 *
 * Pure: no I/O.
 */
import type { Fulfillment, OrderChannel } from './enums.ts';

const ENTRANCE_ONLY: readonly Fulfillment[] = ['entrance_delivery'];
const PLATFORM_ONLY: readonly Fulfillment[] = ['platform_delivery'];

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
