/**
 * Two flags on an order that come from its payment (D-38, D-42), as pure functions: it is waiting
 * for the customer to pay first (so the kitchen does not see it yet), and it needs the shop to
 * confirm the payment by hand. The rule "LINE + PromptPay is pay-first" is the shared `isPayFirst`;
 * this only finds out the order's payment method from what the device has.
 *
 * The order DTO carries both facts (`paymentMethod`, `needsManualConfirm`) and is trusted first, so
 * the kitchen (which receives no payments) works from the order alone. Only an older server leaves
 * the fields out (`undefined`); then the device derives them from the payments in the store (staff
 * roles with `payment.record`) and `claimWithoutSlip`. A `null` method is an answer, not a gap:
 * the order has no live payment.
 */

import type { StaffRole } from '@sds/shared';
import { isPayFirst, type OrderDto, type PaymentDto, type PaymentStatus } from '@sds/shared';

/** A payment still in play: not cancelled by a change of method, not undone after confirming. */
const LIVE: ReadonlySet<PaymentStatus> = new Set(['pending', 'claimed', 'confirmed']);

type OrderFacts = Pick<OrderDto, 'id' | 'channel' | 'status' | 'paymentStatus' | 'paymentMethod'>;

/** The order ids that have a live PromptPay payment. Built once per render, not per order. */
export function promptpayOrderIds(payments: Iterable<PaymentDto>): Set<string> {
  const ids = new Set<string>();
  for (const payment of payments) {
    if (payment.method === 'promptpay' && LIVE.has(payment.status)) ids.add(payment.orderId);
  }
  return ids;
}

/** A LINE order paid by PromptPay (D-38): the order's own method, else (older server) the stored payments. */
export function isPayFirstOrder(order: OrderFacts, promptpayIds: ReadonlySet<string>): boolean {
  const paymentMethod =
    order.paymentMethod !== undefined
      ? order.paymentMethod
      : promptpayIds.has(order.id)
        ? 'promptpay'
        : null;
  return isPayFirst({ channel: order.channel, paymentMethod });
}

/**
 * Left out of the kitchen: a pay-first order that is still `new` and not paid. The server moves it
 * to `preparing` when the money is confirmed, and the kitchen shows it from then on.
 */
export function heldBackFromKitchen(order: OrderFacts, promptpayIds: ReadonlySet<string>): boolean {
  return (
    order.status === 'new' && order.paymentStatus !== 'paid' && isPayFirstOrder(order, promptpayIds)
  );
}

/** The muted "รอชำระ" badge: pay-first, still `new`, and the customer has not paid or claimed yet. */
export function awaitingCustomerPayment(
  order: OrderFacts,
  promptpayIds: ReadonlySet<string>,
): boolean {
  return order.paymentStatus === 'unpaid' && heldBackFromKitchen(order, promptpayIds);
}

/**
 * The icon "confirm by hand": a claimed payment whose slip the bank accepted but the server did
 * not confirm (ceiling, flagged customer, blocked), so the shop checks the bank app (D-42). The
 * server sends the answer as `needsManualConfirm`.
 *
 * Fallback for an older server (field `undefined`): a claim with a slip picture that is not
 * confirmed. That cannot tell a slip still being checked from one held back, so the icon may show
 * for a moment too early; `claimWithoutSlip` absent as well means unknown, so nothing is shown.
 */
export function needsManualConfirm(
  order: Pick<OrderDto, 'status' | 'paymentStatus' | 'claimWithoutSlip' | 'needsManualConfirm'>,
): boolean {
  if (order.status === 'cancelled') return false;
  if (order.needsManualConfirm !== undefined) return order.needsManualConfirm;
  return order.paymentStatus === 'awaiting_confirmation' && order.claimWithoutSlip === false;
}

/**
 * What staff may do to start a `new` order (D-38): `normal` is the plain accept; `wait` is a
 * pay-first order that is not paid, which the server refuses with PAYMENT_REQUIRED (it starts by
 * itself when the payment is confirmed), so no accept button is offered; `override` is the same
 * order seen by a manager or owner, who may start it unpaid with a reason (audited on the server).
 */
export type StartPlan = 'normal' | 'wait' | 'override';

export function startPlan(
  order: OrderFacts,
  role: StaffRole,
  promptpayIds: ReadonlySet<string>,
): StartPlan {
  if (!heldBackFromKitchen(order, promptpayIds)) return 'normal';
  return role === 'manager' || role === 'owner' ? 'override' : 'wait';
}
