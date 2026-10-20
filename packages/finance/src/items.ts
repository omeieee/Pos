/**
 * Item sales (P6). Pure. Quantity and revenue per menu item over the orders that count as revenue
 * (`isCounted`). Item revenue is the sum of line totals: an order-level discount or a partial
 * refund is not spread across items, so these rows can add up to more than the day's revenue.
 * P7: each row also carries cost, gross profit and margin over the units that have a cost snapshot;
 * units with "no cost entered" (null) are left out of those and counted in `qty - costedQty`.
 */
import { marginBasisPoints, satang } from '@sds/shared';
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
  /**
   * Units sold with a cost snapshot. `qty - costedQty` units had "no cost entered" and are left out
   * of everything below (D-32): the margin is the margin of the costed units only.
   */
  costedQty: number;
  /** Line totals of the costed units (before any order discount or refund, like `revenueSatang`). */
  costedRevenueSatang: number;
  /** Σ unit cost × qty of the costed units; null when no unit has a cost ("no cost entered"). */
  costSatang: number | null;
  /** `costedRevenueSatang - costSatang`; negative for a loss; null when `costSatang` is. */
  grossProfitSatang: number | null;
  /** Gross profit / costed revenue in basis points, half away from zero; null when it cannot be stated. */
  marginBp: number | null;
}

function assertWhole(value: number, label: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${label} must be an integer of at least ${min}, got ${value}`);
  }
}

export function itemSales(orders: readonly ReportOrder[]): ItemSales[] {
  const byItem = new Map<
    string,
    {
      name: string;
      at: number;
      qty: number;
      revenue: number;
      costedQty: number;
      costedRevenue: number;
      cost: number;
    }
  >();
  let totalUnits = 0;
  for (const order of orders) {
    if (!isCounted(order)) continue;
    const at = order.placedAt.getTime();
    for (const line of order.items) {
      assertWhole(line.qty, 'item quantity', 1);
      assertWhole(line.lineTotalSatang, 'line total', 0);
      const row = byItem.get(line.menuItemId) ?? {
        name: line.name,
        at,
        qty: 0,
        revenue: 0,
        costedQty: 0,
        costedRevenue: 0,
        cost: 0,
      };
      row.qty += line.qty;
      row.revenue += line.lineTotalSatang;
      if (line.unitCostSatang !== null) {
        assertWhole(line.unitCostSatang, 'unit cost', 0);
        row.costedQty += line.qty;
        row.costedRevenue += line.lineTotalSatang;
        row.cost += line.unitCostSatang * line.qty;
      }
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
    costedQty: r.costedQty,
    costedRevenueSatang: r.costedRevenue,
    costSatang: r.costedQty > 0 ? r.cost : null,
    grossProfitSatang: r.costedQty > 0 ? r.costedRevenue - r.cost : null,
    marginBp:
      r.costedQty > 0
        ? marginBasisPoints(satang(r.costedRevenue - r.cost), satang(r.costedRevenue))
        : null,
  }));
  return rows.sort(
    (a, b) =>
      b.qty - a.qty ||
      b.revenueSatang - a.revenueSatang ||
      a.name.localeCompare(b.name) ||
      a.menuItemId.localeCompare(b.menuItemId),
  );
}
