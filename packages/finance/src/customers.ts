/**
 * Customer segments and favourite items (P6, requirement C2). Pure.
 *
 * Segments are working defaults, not owner-set rules: LAPSED if the last order was more than
 * `LAPSED_AFTER_DAYS` ago (a customer who never ordered counts from the day first seen); otherwise
 * REGULAR with `REGULAR_MIN_ORDERS` or more orders; otherwise NEW.
 */
export const LAPSED_AFTER_DAYS = 30;
export const REGULAR_MIN_ORDERS = 2;

export type CustomerSegment = 'new' | 'regular' | 'lapsed';

export interface CustomerFacts {
  id: string;
  firstSeenAt: Date;
  lastOrderAt: Date | null;
  orderCount: number;
}

const DAY_MS = 86_400_000;

export function segmentOf(customer: CustomerFacts, now: Date): CustomerSegment {
  const since = (customer.lastOrderAt ?? customer.firstSeenAt).getTime();
  if (now.getTime() - since > LAPSED_AFTER_DAYS * DAY_MS) return 'lapsed';
  return customer.orderCount >= REGULAR_MIN_ORDERS ? 'regular' : 'new';
}

export function segmentSummary(
  customers: readonly CustomerFacts[],
  now: Date,
): Record<CustomerSegment, number> {
  const out: Record<CustomerSegment, number> = { new: 0, regular: 0, lapsed: 0 };
  for (const c of customers) out[segmentOf(c, now)] += 1;
  return out;
}

export interface CustomerItemUnits {
  customerId: string;
  menuItemId: string;
  name: string;
  qty: number;
}

export interface FavouriteItem {
  menuItemId: string;
  name: string;
  qty: number;
}

/** The `limit` items each customer bought most, by units, then name, then id. */
export function favouriteItems(
  rows: readonly CustomerItemUnits[],
  limit: number,
): Map<string, FavouriteItem[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be an integer of at least 1, got ${limit}`);
  }
  const totals = new Map<string, Map<string, FavouriteItem>>();
  for (const r of rows) {
    if (!Number.isSafeInteger(r.qty) || r.qty < 1) {
      throw new RangeError(`quantity must be an integer of at least 1, got ${r.qty}`);
    }
    const items = totals.get(r.customerId) ?? new Map<string, FavouriteItem>();
    const item = items.get(r.menuItemId) ?? { menuItemId: r.menuItemId, name: r.name, qty: 0 };
    item.qty += r.qty;
    items.set(r.menuItemId, item);
    totals.set(r.customerId, items);
  }
  const out = new Map<string, FavouriteItem[]>();
  for (const [customerId, items] of totals) {
    out.set(
      customerId,
      [...items.values()]
        .sort(
          (a, b) =>
            b.qty - a.qty ||
            a.name.localeCompare(b.name) ||
            a.menuItemId.localeCompare(b.menuItemId),
        )
        .slice(0, limit),
    );
  }
  return out;
}
