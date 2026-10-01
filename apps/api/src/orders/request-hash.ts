import { createHash } from 'node:crypto';
import type { CreateOrderInput } from '@sds/shared';

/**
 * A fingerprint of what an order request asks for, to tell a genuine retry (same request id,
 * same content: return the original order) from a reused id (same request id, different content:
 * refuse). The request id itself is the key, not content, so it is left out. An option list is a
 * set, so its ids are sorted; the item order is kept because it is the order on the ticket.
 * Everything that reaches the order is in it; prices are not, because the client sends none.
 */
export function orderRequestHash(input: CreateOrderInput): string {
  const canonical = JSON.stringify({
    channel: input.channel,
    fulfillment: input.fulfillment,
    roomNo: input.roomNo ?? null,
    customerId: input.customerId ?? null,
    note: input.note ?? null,
    items: input.items.map((item) => ({
      menuItemId: item.menuItemId,
      qty: item.qty,
      modifierOptionIds: [...item.modifierOptionIds].sort(),
      note: item.note ?? null,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
