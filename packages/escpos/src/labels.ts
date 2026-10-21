/**
 * The words printed on a kitchen ticket. The ticket model carries codes (channel, fulfillment) and
 * the print program picks the wording, so the paper's vocabulary lives here in one place.
 */
import { t } from '@sds/i18n';
import type { Fulfillment, OrderChannel } from '@sds/shared';

/** Channel and way-of-receiving words come from the shared Thai catalogue, so paper and screens agree. */
export const channelBadge = (channel: OrderChannel): string => t('th', `orders.channel.${channel}`);

export const fulfillmentLabel = (fulfillment: Fulfillment): string =>
  t('th', `pos.orderEntry.fulfilment.${fulfillment}`);

/** Words that exist only on the ticket. Not in `@sds/i18n` yet: move them there when that catalogue is open for edits. */
export const TICKET_TEXT = {
  reprint: (copy: number) => (copy > 0 ? `พิมพ์ซ้ำ ครั้งที่ ${copy}` : 'พิมพ์ซ้ำ'),
  who: 'ชื่อ',
  building: 'อาคาร',
  room: 'ห้อง',
  deliveryNote: 'ฝากบอก',
  orderNote: 'หมายเหตุ',
  placed: 'สั่งเมื่อ',
  noItems: '(ไม่มีรายการ)',
} as const;

/** `2026-10-22` becomes `22/10/2569` (Buddhist Era, as the Thai locale shows dates). */
export function thaiDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${Number(year) + 543}`;
}
