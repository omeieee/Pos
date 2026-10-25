import type { OrderChannel, OrderStatus } from './enums.ts';
import { makeMachine } from './state-machine.ts';

/** Order fulfilment status (03 §4). Every order status change goes through this machine. */
export const orderMachine = makeMachine<OrderStatus>([
  // `system`: a pay-first LINE order starts preparing when its payment is confirmed (D-38).
  { from: 'new', to: 'preparing', staff: 'order.accept', system: true },
  {
    from: 'new',
    to: 'cancelled',
    staff: 'order.cancel_new',
    customer: true,
    system: true,
    reasonRequired: true,
  },
  { from: 'preparing', to: 'ready', staff: 'order.advance' },
  { from: 'ready', to: 'completed', staff: 'order.advance' },
  {
    from: 'preparing',
    to: 'cancelled',
    staff: 'order.cancel_in_progress',
    reasonRequired: true,
  },
  { from: 'ready', to: 'cancelled', staff: 'order.cancel_in_progress', reasonRequired: true },
  // Owner only, with step-up: voiding an order that was already finished (decision 2026-10-11).
  { from: 'completed', to: 'cancelled', staff: 'order.edit_past', reasonRequired: true },
]);

/**
 * LINE and platform orders arrive as `new` and wait for staff to accept them.
 * Orders keyed in by staff (storefront, phone) go straight to `preparing`.
 */
export function initialOrderStatus(channel: OrderChannel): OrderStatus {
  return channel === 'storefront' || channel === 'phone' ? 'preparing' : 'new';
}

/**
 * The reasons the server and the customer write on order transitions (D-38 to D-41). Free text
 * written by staff is not listed here. A merged order stores `merged:<orderNo of the survivor>`.
 */
export const ORDER_REASONS = {
  paid: 'paid',
  customer_cancel: 'customer_cancel',
  unpaid_timeout: 'unpaid_timeout',
  merged: 'merged',
} as const;

const MERGED_PREFIX = `${ORDER_REASONS.merged}:`;

/** The stored reason of an order merged into `targetOrderNo`. */
export function mergedReason(targetOrderNo: string): string {
  return `${MERGED_PREFIX}${targetOrderNo}`;
}

export type ParsedOrderReason =
  | { kind: 'paid' | 'customer_cancel' | 'unpaid_timeout' | 'other' }
  | { kind: 'merged'; orderNo: string };

/** Reads a stored reason back, for the customer's order page. Anything unknown is `other`. */
export function parseOrderReason(reason: string | null | undefined): ParsedOrderReason {
  if (reason === ORDER_REASONS.paid) return { kind: 'paid' };
  if (reason === ORDER_REASONS.customer_cancel) return { kind: 'customer_cancel' };
  if (reason === ORDER_REASONS.unpaid_timeout) return { kind: 'unpaid_timeout' };
  if (reason?.startsWith(MERGED_PREFIX) && reason.length > MERGED_PREFIX.length) {
    return { kind: 'merged', orderNo: reason.slice(MERGED_PREFIX.length) };
  }
  return { kind: 'other' };
}
