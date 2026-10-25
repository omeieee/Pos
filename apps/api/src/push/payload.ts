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
import type { SecurityAlertEvent } from '../events.ts';

const WORDS = {
  newOrder: 'ออเดอร์ใหม่',
  items: 'รายการ',
  alert: 'แจ้งเตือนระบบ',
  urgent: 'แจ้งเตือนด่วน',
  order: 'ออเดอร์',
} as const;

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

/**
 * What a security or ops alert push says (OPS-02): urgent or not, the alert kind as the code the
 * Sentry e-mail also shows, and the order number when there is one. Built field by field like
 * `alertReport`, so nothing else of the event (staff, device, Slip2Go details) can ride along.
 */
export function securityAlertPayload(event: SecurityAlertEvent): PushPayload {
  return {
    title: event.severity === 'critical' ? WORDS.urgent : WORDS.alert,
    body: event.orderNo ? `${event.kind} · ${WORDS.order} #${event.orderNo}` : event.kind,
    url: event.subject ? `/#/orders/${event.subject.orderId}` : '/#/settings',
    // One per alert: a repeat of the same kind is a new notification, not a silent replace.
    tag: `alert-${event.kind}-${event.at}`,
  };
}
