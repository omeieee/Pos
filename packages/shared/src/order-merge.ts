/**
 * Pay-first LINE orders: who may edit, cancel or merge them, and when two carts are the same
 * (D-38, D-39). Pure; no I/O. The server decides with these; the apps only show the answer.
 */
import type { OrderChannel, OrderStatus, PaymentMethod, PaymentStatus } from './enums.ts';

/** A payment as far as these rules care: its status and whether a slip picture is on it. */
export interface PaymentFacts {
  status: PaymentStatus;
  hasSlip: boolean;
}

/** Everything the merge rules read about one order. */
export interface MergeFacts {
  customerId: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  /** ISO date (YYYY-MM-DD). */
  businessDate: string;
  deliveryBuilding: string | null;
  recipientName: string | null;
  payments: readonly PaymentFacts[];
}

/** A LINE order paid by PromptPay waits for the money before the kitchen sees it (D-38). */
export function isPayFirst(order: {
  channel: OrderChannel;
  paymentMethod: PaymentMethod | null;
}): boolean {
  return order.channel === 'line' && order.paymentMethod === 'promptpay';
}

/** A payment that moves the order past "unpaid, untouched": claimed, confirmed or undone after. */
const TOUCHED_PAYMENT: ReadonlySet<PaymentStatus> = new Set([
  'claimed',
  'confirmed',
  'voided',
  'refunded',
]);

/**
 * The customer may change or cancel the order (A4): it is still `new`, no payment is claimed or
 * confirmed, and no slip was ever sent on any payment (a slip may already be in a bank's hands, so
 * the amount must stay as the customer paid it).
 */
export function canCustomerEdit(
  order: { status: OrderStatus },
  payments: readonly PaymentFacts[],
): boolean {
  return (
    order.status === 'new' && !payments.some((p) => TOUCHED_PAYMENT.has(p.status) || p.hasSlip)
  );
}

const fold = (value: string | null): string | null => value?.trim().toLowerCase() || null;

/**
 * The target and every source can become one order: the same customer (never a guest), channel
 * `line`, all `new`, the same business date, the same building and recipient name (trimmed and
 * case-folded), and each one still editable by the customer. A claimed payment without a slip
 * makes an order ineligible too. At least one source is required.
 */
export function mergeEligible(target: MergeFacts, sources: readonly MergeFacts[]): boolean {
  if (sources.length === 0) return false;
  const building = fold(target.deliveryBuilding);
  const name = fold(target.recipientName);
  if (target.customerId === null || building === null || name === null) return false;
  return [target, ...sources].every(
    (o) =>
      o.customerId === target.customerId &&
      o.channel === 'line' &&
      o.businessDate === target.businessDate &&
      fold(o.deliveryBuilding) === building &&
      fold(o.recipientName) === name &&
      canCustomerEdit(o, o.payments),
  );
}

export interface CartLineFacts {
  menuItemId: string;
  qty: number;
  modifierOptionIds: readonly string[];
}

const lineKey = (l: CartLineFacts): string =>
  `${l.menuItemId}|${l.qty}|${[...l.modifierOptionIds].sort().join(',')}`;

/**
 * The cart holds the same dishes as an open order: the same menu item, quantity and option choice
 * on every line, in any order. Notes are ignored. An empty cart is never a duplicate.
 */
export function isDuplicateCart(
  cartLines: readonly CartLineFacts[],
  orderLines: readonly CartLineFacts[],
): boolean {
  if (cartLines.length === 0 || cartLines.length !== orderLines.length) return false;
  const a = cartLines.map(lineKey).sort();
  const b = orderLines.map(lineKey).sort();
  return a.every((key, i) => key === b[i]);
}
