import { botText, type ReceiptItem } from '@sds/line';
import type { MyOrder } from '@sds/shared';

/** The template name in `line_message_log`: one counted push per order and template. */
export const READY_RECEIPT_TEMPLATE = 'ready_receipt';

/** How the customer paid, in words, for the receipt. */
export function methodLabelOf(order: Pick<MyOrder, 'payment' | 'paymentStatus'>): string {
  if (!order.payment || order.payment.status === 'cancelled') {
    return botText(`status.payment.${order.paymentStatus}`).text;
  }
  return botText(`payment.method.${order.payment.method}`).text;
}

/** The order's lines as the receipt and confirmation cards show them. */
export function receiptItems(order: Pick<MyOrder, 'items'>): ReceiptItem[] {
  return order.items.map((i) => ({
    name: i.nameTh,
    quantity: i.qty,
    lineTotalSatang: i.lineTotalSatang,
  }));
}
