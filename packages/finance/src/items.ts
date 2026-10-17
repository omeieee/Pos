/**
 * Item sales (P6). Pure. Quantity and revenue per menu item over the orders that count as revenue
 * (`isCounted`). Item revenue is the sum of line totals: an order-level discount or a partial
 * refund is not spread across items, so these rows can add up to more than the day's revenue.
 * Margin needs item costs and comes in P7.
 */
import { isCounted, type ReportOrder } from './revenue.ts';

export interface ItemSales {
  menuItemId: string;
  /** The name on the newest counted order line of this item. */
  name: string;
  qty: number;
  revenueSatang: number;
  /** This item's share of all units sold, in basis points (rounded half up). */
  unitShareBp: number;
  /** Menu-engineering popularity: share of units at least 70% of an even share (1 / items). */
  popular: boolean;
}

function assertWhole(value: number, label: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${label} must be an integer of at least ${min}, got ${value}`);
  }
}

export function itemSales(orders: readonly ReportOrder[]): ItemSales[] {
  const byItem = new Map<string, { name: string; at: number; qty: number; revenue: number }>();
  let totalUnits = 0;
  for (const order of orders) {
    if (!isCounted(order)) continue;
    const at = order.placedAt.getTime();
    for (const line of order.items) {
      assertWhole(line.qty, 'item quantity', 1);
      assertWhole(line.lineTotalSatang, 'line total', 0);
      const row = byItem.get(line.menuItemId) ?? { name: line.name, at, qty: 0, revenue: 0 };
      row.qty += line.qty;
      row.revenue += line.lineTotalSatang;
      if (at >= row.at) {
        row.name = line.name;
        row.at = at;
      }
      byItem.set(line.menuItemId, row);
      totalUnits += line.qty;
    }
  }
  const count = byItem.size;
  const rows = [...byItem.entries()].map(([menuItemId, r]) => ({
    menuItemId,
    name: r.name,
    qty: r.qty,
    revenueSatang: r.revenue,
    unitShareBp: Math.floor((2 * r.qty * 10000 + totalUnits) / (2 * totalUnits)),
    popular: r.qty * count * 10 >= totalUnits * 7,
  }));
  return rows.sort(
    (a, b) =>
      b.qty - a.qty ||
      b.revenueSatang - a.revenueSatang ||
      a.name.localeCompare(b.name) ||
      a.menuItemId.localeCompare(b.menuItemId),
  );
}
