/**
 * The words for the reason on a cancelled order. The server writes a few fixed reasons itself
 * (`unpaid_timeout`, `merged:<order no>`, `customer_cancel`); everything else is what staff typed
 * and is shown as written. Pure: returns a catalog key and its params, the screen translates.
 */
import type { MessageKey, MessageParams } from '@sds/i18n';
import { parseOrderReason } from '@sds/shared';

export interface CancelReasonText {
  key: MessageKey;
  params?: MessageParams;
}

export function cancelReasonText(reason: string | null | undefined): CancelReasonText | null {
  if (!reason) return null;
  const parsed = parseOrderReason(reason);
  switch (parsed.kind) {
    case 'unpaid_timeout':
      return { key: 'order.cancel.why.unpaidTimeout' };
    case 'customer_cancel':
      return { key: 'order.cancel.why.customer' };
    case 'merged':
      return { key: 'order.cancel.why.merged', params: { orderNo: parsed.orderNo } };
    default:
      return { key: 'order.cancel.reasonShown', params: { reason } };
  }
}
