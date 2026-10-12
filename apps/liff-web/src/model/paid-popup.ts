import type { MyOrder } from '@sds/shared';

/** Payment states that can still turn into "paid" while the customer watches. */
const OPEN: ReadonlySet<MyOrder['paymentStatus']> = new Set([
  'unpaid',
  'awaiting_confirmation',
  'partially_paid',
]);

/**
 * Whether the "money received" pop-up should rise now. Only for a PromptPay transfer that turns
 * paid while the page is open: `previous` is the status this page saw last (null on first load, so
 * an order that is already paid never pops up), and `alreadyShown` guards one pop-up per payment.
 */
export function shouldShowPaidPopup(
  previous: MyOrder['paymentStatus'] | null,
  order: Pick<MyOrder, 'paymentStatus' | 'payment'>,
  alreadyShown: boolean,
): boolean {
  return (
    !alreadyShown &&
    previous !== null &&
    OPEN.has(previous) &&
    order.paymentStatus === 'paid' &&
    order.payment?.method === 'promptpay'
  );
}

const key = (paymentId: string) => `sds.paidPopup.${paymentId}`;

/** Per-tab memory of the pop-ups already shown; storage may be blocked, so it never throws. */
export function paidPopupSeen(paymentId: string): boolean {
  try {
    return sessionStorage.getItem(key(paymentId)) === '1';
  } catch {
    return false;
  }
}

export function markPaidPopupSeen(paymentId: string): void {
  try {
    sessionStorage.setItem(key(paymentId), '1');
  } catch {
    // Private mode or blocked storage: the in-page state still guards this visit.
  }
}
