import type { MyOrder } from '@sds/shared';

/** One dot of the order tracker: finished, where the order is now, or still to come. */
export type StepState = 'done' | 'now' | 'todo';

/**
 * The four steps of the tracker, in order: ordered, payment, cooking, pick-up at the entrance.
 *
 * Payment is only the step to act on for a PromptPay order that is not paid yet (the customer
 * transfers first). Cash and ไทยช่วยไทย are paid with staff at the hand-over, so they do not hold
 * the order at step 2: the tracker moves on to cooking and the payment step stays open until it
 * is paid. A cancelled order has no tracker (`null`); the screen says so instead.
 */
export function orderSteps(
  order: Pick<MyOrder, 'status' | 'paymentStatus' | 'payment'>,
): [StepState, StepState, StepState, StepState] | null {
  if (order.status === 'cancelled') return null;
  const paid = order.paymentStatus === 'paid';
  const cooked = order.status === 'ready' || order.status === 'completed';
  const handedOver = order.status === 'completed';
  const transferFirst = order.payment?.method === 'promptpay';
  const payIsNext = !paid && transferFirst && !cooked;

  const done = [true, paid, cooked, handedOver];
  const next = [2, 3, 4].find((n) => !done[n - 1] && (n !== 2 || payIsNext));
  return [1, 2, 3, 4].map((n): StepState => {
    if (done[n - 1]) return 'done';
    return n === next ? 'now' : 'todo';
  }) as [StepState, StepState, StepState, StepState];
}

/** Staff checked the bank and found no transfer. A missing flag (older server) means no. */
export function isPaymentRejected(order: Pick<MyOrder, 'paymentRejected'>): boolean {
  return order.paymentRejected === true;
}

/**
 * A PromptPay order that is being cooked or is ready while staff have not confirmed the money.
 * Cash and ไทยช่วยไทย are paid on hand-over, so they never show this.
 */
export function awaitsTransferConfirmation(
  order: Pick<MyOrder, 'status' | 'paymentStatus' | 'payment' | 'paymentRejected'>,
): boolean {
  if (order.status === 'cancelled' || order.status === 'completed') return false;
  if (order.status === 'new') return false;
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') return false;
  if (isPaymentRejected(order)) return false;
  return order.payment?.method === 'promptpay';
}
