/**
 * The checkout warning and the edit/merge helpers (D-39). Pure, no React. The server decides every
 * edit and merge; these rules only choose what the customer is asked, so the same words never
 * promise something the server will refuse. `isDuplicateCart` and `mergeEligible` come from the
 * shared rules (the `order-merge` subpath carries no schema library into this bundle).
 */
import type { AppOpenOrder } from '@sds/shared';
import { isDuplicateCart, type MergeFacts, mergeEligible } from '@sds/shared/order-merge';
import { addLine, type Cart, toOrderItems } from './cart.ts';

type Recipient = { building: string; name: string };

/** What the checkout asks about: one open order, and what may be offered for it. */
export interface CheckoutWarning {
  order: AppOpenOrder;
  /** The cart holds the same dishes as that order: the wording is stronger. */
  duplicate: boolean;
  /** "รวมกับออเดอร์เดิม" may be offered (same name and building). */
  canMerge: boolean;
}

/**
 * The customer is changing an unpaid order: the cart was filled from its lines and saving replaces
 * them (D-39). `stash` is the cart they had before, put back when the change is saved or dropped.
 */
export interface EditSession {
  orderId: string;
  orderNo: string;
  /** The order version the lines were read at; the server refuses a change made on a stale one. */
  version: number;
  stash: Cart;
}

/** Start changing this order: the cart becomes its lines. */
export function startEditSession(
  order: AppOpenOrder,
  stash: Cart,
): { session: EditSession; cart: Cart } {
  return {
    session: { orderId: order.id, orderNo: order.orderNo, version: order.version, stash },
    cart: cartFromOrder(order),
  };
}

/** An open order's dishes as the cart holds them. */
export function cartFromOrder(order: AppOpenOrder): Cart {
  return order.items.reduce<Cart>(
    (cart, line) =>
      addLine(cart, {
        menuItemId: line.menuItemId,
        optionIds: line.modifierOptionIds,
        note: line.note ?? '',
        qty: line.qty,
      }),
    [],
  );
}

const facts = (who: Recipient, businessDate: string): MergeFacts => ({
  // Same customer by construction: the list holds only this customer's orders.
  customerId: 'self',
  channel: 'line',
  status: 'new',
  businessDate,
  deliveryBuilding: who.building,
  recipientName: who.name,
  payments: [],
});

/**
 * Whether the cart being placed could join this open order: the rule is the shared one, with the
 * form's building and name as the new order. The cart has no business date yet; the order's own
 * date is used, and the server still refuses a merge across days.
 */
export function canMergeCart(order: AppOpenOrder, form: Recipient): boolean {
  return mergeEligible(
    facts(
      { building: order.deliveryBuilding ?? '', name: order.recipientName ?? '' },
      order.businessDate,
    ),
    [facts(form, order.businessDate)],
  );
}

/**
 * Which open order to ask about, or null when there is none. The same dishes first, then an order
 * the cart could join, then the newest.
 */
export function checkoutWarning(
  open: readonly AppOpenOrder[],
  cart: Cart,
  form: Recipient,
): CheckoutWarning | null {
  if (open.length === 0) return null;
  const lines = cart.map((l) => ({
    menuItemId: l.menuItemId,
    qty: l.qty,
    modifierOptionIds: l.optionIds,
  }));
  const newestFirst = [...open].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  const sameDishes = newestFirst.find((o) => isDuplicateCart(lines, o.items));
  const mergeable = newestFirst.find((o) => canMergeCart(o, form));
  const order = sameDishes ?? mergeable ?? newestFirst[0];
  if (!order) return null;
  return { order, duplicate: sameDishes !== undefined, canMerge: canMergeCart(order, form) };
}

/** The open order's lines plus the cart, equal lines added together (the body of the merging `PUT`). */
export function mergedItems(order: AppOpenOrder, cart: Cart) {
  const combined = cart.reduce<Cart>(
    (all, l) =>
      addLine(all, { menuItemId: l.menuItemId, optionIds: l.optionIds, note: l.note, qty: l.qty }),
    cartFromOrder(order),
  );
  return toOrderItems(combined);
}

/** This order from the open list, which carries the version and the dish ids the order page lacks. */
export function openOrderFor(
  open: readonly AppOpenOrder[],
  orderId: string,
): AppOpenOrder | undefined {
  return open.find((o) => o.id === orderId);
}

/** "#L-001 + #L-002" for the combine question. */
export function orderNoList(orderNos: readonly string[]): string {
  return orderNos.map((no) => `#${no}`).join(' + ');
}

export type CancelReasonView =
  | { key: 'unpaid_timeout' | 'customer_cancel' | 'mergedUnknown' }
  | { key: 'merged'; orderNo: string };

/** The reason line on a cancelled order's page, or null when the server gave none worth telling. */
export function cancelReasonView(order: {
  cancelReason?: 'customer_cancel' | 'unpaid_timeout' | 'merged' | 'other' | null;
  mergedInto?: string | null;
}): CancelReasonView | null {
  switch (order.cancelReason) {
    case 'unpaid_timeout':
    case 'customer_cancel':
      return { key: order.cancelReason };
    case 'merged':
      return order.mergedInto
        ? { key: 'merged', orderNo: order.mergedInto }
        : { key: 'mergedUnknown' };
    default:
      return null;
  }
}
