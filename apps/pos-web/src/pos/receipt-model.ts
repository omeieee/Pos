import { canDownloadReceipt, type ReceiptOrder } from '@sds/i18n';
import type { OrderDto, PaymentDto, ReceiptResponse } from '@sds/shared';

/**
 * Is there anything to issue? Only a paid, uncancelled order with a payment received. This only
 * decides whether the button shows; the server decides whether a receipt can be issued.
 */
export const canIssueReceipt = (
  order: Pick<OrderDto, 'paymentStatus' | 'status'>,
  received: Pick<PaymentDto, 'method'> | undefined,
): boolean => received !== undefined && canDownloadReceipt(order);

/**
 * The receipt as the server issued it: its order, the method of its confirmed payment and the
 * shop's name, tax ID and address. Nothing is read from the order on screen, and nothing is
 * computed here.
 */
export function receiptFromResponse(response: ReceiptResponse): ReceiptOrder {
  const { order, payment, shop } = response;
  return {
    ...order,
    payment: { method: payment.method },
    shop: { nameTh: shop.nameTh, nameEn: shop.nameEn, taxId: shop.taxId, address: shop.address },
  };
}
