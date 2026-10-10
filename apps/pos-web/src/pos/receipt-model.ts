import { canDownloadReceipt, type ReceiptOrder } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';

/**
 * The receipt of a paid order: the server's order (its total and lines) with the method of the
 * payment that was received. Nothing is computed here. Null while there is nothing to issue: the
 * order is not paid, is cancelled, or no confirmed payment is known.
 */
export function receiptFor(
  order: OrderDto,
  received: Pick<PaymentDto, 'method'> | undefined,
): ReceiptOrder | null {
  if (!received || !canDownloadReceipt(order)) return null;
  return { ...order, payment: { method: received.method } };
}
