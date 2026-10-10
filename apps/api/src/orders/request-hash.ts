import { createHash } from 'node:crypto';
import type { CreateOrderInput, MemberInput } from '@sds/shared';

/**
 * A fingerprint of what an order request asks for, to tell a genuine retry (same request id,
 * same content: return the original order) from a reused id (same request id, different content:
 * refuse). The request id itself is the key, not content, so it is left out. An option list is a
 * set, so its ids are sorted; the item order is kept because it is the order on the ticket.
 * Everything that reaches the order is in it; prices are not, because the client sends none.
 */
export function orderRequestHash(input: CreateOrderInput, member?: MemberInput): string {
  const canonical = JSON.stringify({
    channel: input.channel,
    fulfillment: input.fulfillment,
    roomNo: input.roomNo ?? null,
    customerId: input.customerId ?? null,
    note: input.note ?? null,
    // Added only when present, so an order without a recipient keeps the fingerprint it was
    // saved with. An empty details field is the same as none.
    ...(input.deliveryBuilding !== undefined
      ? {
          deliveryBuilding: input.deliveryBuilding,
          recipientName: input.recipientName ?? null,
          deliveryNote: input.deliveryNote || null,
        }
      : {}),
    // Added only when the form was sent, so every order saved before it keeps its fingerprint.
    ...(member !== undefined
      ? {
          member: {
            fullName: member.fullName,
            nickname: member.nickname,
            building: member.building,
            phone: member.phone,
          },
        }
      : {}),
    items: input.items.map((item) => ({
      menuItemId: item.menuItemId,
      qty: item.qty,
      modifierOptionIds: [...item.modifierOptionIds].sort(),
      note: item.note ?? null,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
