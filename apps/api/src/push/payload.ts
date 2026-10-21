/**
 * What a new-order push says. Built field by field from the order number, the channel and a count:
 * it cannot carry a customer's name, phone, room, address or note, and a push service and the lock
 * screen both see it. The click-through path opens the order in the POS (a hash-router path).
 *
 * The words are Thai, as everywhere in the shop's tools. "ออเดอร์ใหม่" and "รายการ" are not in the
 * `@sds/i18n` catalogue yet (the channel names are); move them there when that file is open for edits.
 */
import { t } from '@sds/i18n';
import type { OrderChannel, PushPayload } from '@sds/shared';

const WORDS = { newOrder: 'ออเดอร์ใหม่', items: 'รายการ' } as const;

export function newOrderPayload(
  order: { id: string; orderNo: string; channel: OrderChannel },
  itemCount: number,
): PushPayload {
  return {
    title: `${WORDS.newOrder} #${order.orderNo} (${t('th', `orders.channel.${order.channel}`)})`,
    body: itemCount > 0 ? `${itemCount} ${WORDS.items}` : '',
    // The POS routes by hash: `/#/orders/<id>` opens the order page.
    url: `/#/orders/${order.id}`,
    // A second alert for the same order replaces the first on the lock screen.
    tag: `order-${order.id}`,
  };
}
