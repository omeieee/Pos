/**
 * Payments: the staff alert for a slip that ends in review (D-42). Ids and the order number only.
 */
import type { ordersRepo, paymentsRepo } from '@sds/db';
import type { Emit } from '../tx.ts';

/** Payment + picture pairs already announced in this process; bounded, oldest dropped first. */
const announced = new Set<string>();
const MAX_ANNOUNCED = 2000;

/**
 * True when this payment's slip has ended in a state only staff can settle: the payment is still
 * `claimed`, a picture is on it and no automatic reading is still running on it.
 */
export function slipNeedsReview(payment: paymentsRepo.PaymentRow): boolean {
  return (
    payment.status === 'claimed' &&
    payment.slipImageKey !== null &&
    payment.slipCheck !== 'pending' &&
    payment.slipVerify !== 'pending'
  );
}

/**
 * Emits `alert.payment {kind: 'slip_review'}` once per payment and picture. Whatever the reading
 * found (Slip2Go valid but held back from auto-confirm, wrong amount, unchecked, unreadable), the
 * customer's slip is now staff's to look at. Call it with the order lock held, after the payment
 * row was written; the event goes out with the transaction's other events, after the commit.
 */
export function emitSlipReview(
  emit: Emit,
  order: Pick<ordersRepo.OrderRow, 'id' | 'orderNo'>,
  payment: paymentsRepo.PaymentRow,
): void {
  if (!slipNeedsReview(payment)) return;
  const key = `${payment.id}:${payment.slipImageHash ?? ''}`;
  if (announced.has(key)) return;
  announced.add(key);
  if (announced.size > MAX_ANNOUNCED) {
    const oldest = announced.values().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }
  emit({ type: 'alert.payment', orderId: order.id, orderNo: order.orderNo, kind: 'slip_review' });
}
