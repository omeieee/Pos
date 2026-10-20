/**
 * Cost of goods and gross profit over a period (P7, D-32). Pure.
 *
 * - Cost comes from the snapshot saved on each order line when it was sold (`unitCostSatang`, modifier
 *   costs included), never from today's menu. A line whose snapshot is null had "no cost entered".
 * - An order is **costed** only when it has lines and every line has a cost. The period margin is
 *   computed over costed orders only: revenue is their net paid (confirmed payments minus partial
 *   refunds, as in `netPaidSatang`), cost is Σ unit cost × qty of their lines. A discount or refund
 *   lowers revenue but not cost (the food was made).
 * - Orders that are not costed are left out of the margin and named (`uncostedOrderIds`), with the
 *   items that lack a cost (`uncostedMenuItemIds`) and the revenue left out. Nothing is guessed.
 * - Gross profit is before platform commission and before any expense; the commission is reported
 *   separately (`commission.ts`).
 */
import { marginBasisPoints, satang } from '@sds/shared';
import { isCounted, netPaidSatang, type ReportOrder } from './revenue.ts';

export interface OrderCost {
  /** True when the order has lines and every one has a cost. */
  costed: boolean;
  /** Σ unit cost × qty; 0 when the order is not costed (a partial sum would mislead). */
  costSatang: number;
  /** Items on this order whose cost was not entered, each once. */
  uncostedMenuItemIds: string[];
}

export function orderCost(order: ReportOrder): OrderCost {
  let cost = 0;
  const missing = new Set<string>();
  for (const line of order.items) {
    if (line.unitCostSatang === null) {
      missing.add(line.menuItemId);
      continue;
    }
    if (!Number.isSafeInteger(line.unitCostSatang) || line.unitCostSatang < 0) {
      throw new RangeError(
        `unit cost must be a whole number of satang, got ${line.unitCostSatang}`,
      );
    }
    cost += line.unitCostSatang * line.qty;
  }
  const costed = order.items.length > 0 && missing.size === 0;
  return { costed, costSatang: costed ? cost : 0, uncostedMenuItemIds: [...missing] };
}

export interface PeriodMargin {
  costedOrderCount: number;
  /** Net paid of the costed orders: the revenue the margin is stated over. */
  costedRevenueSatang: number;
  costSatang: number;
  /** `costedRevenueSatang - costSatang`; null when no order is costed. */
  grossProfitSatang: number | null;
  /** Gross profit / costed revenue in basis points; null when there is nothing to divide by. */
  marginBp: number | null;
  /** Counted orders left out of the margin, oldest first as given. */
  uncostedOrderIds: string[];
  /** Net paid of those orders. */
  uncostedRevenueSatang: number;
  /** Menu items with at least one uncosted line on a counted order, in first-seen order. */
  uncostedMenuItemIds: string[];
}

export function periodMargin(orders: readonly ReportOrder[]): PeriodMargin {
  let costedOrderCount = 0;
  let revenue = 0;
  let cost = 0;
  let uncostedRevenue = 0;
  const uncostedOrderIds: string[] = [];
  const uncostedItems = new Set<string>();
  for (const order of orders) {
    if (!isCounted(order)) continue;
    const net = netPaidSatang(order);
    const c = orderCost(order);
    for (const id of c.uncostedMenuItemIds) uncostedItems.add(id);
    if (c.costed) {
      costedOrderCount += 1;
      revenue += net;
      cost += c.costSatang;
    } else {
      uncostedOrderIds.push(order.id);
      uncostedRevenue += net;
    }
  }
  const profit = revenue - cost;
  return {
    costedOrderCount,
    costedRevenueSatang: revenue,
    costSatang: cost,
    grossProfitSatang: costedOrderCount > 0 ? profit : null,
    marginBp: costedOrderCount > 0 ? marginBasisPoints(satang(profit), satang(revenue)) : null,
    uncostedOrderIds,
    uncostedRevenueSatang: uncostedRevenue,
    uncostedMenuItemIds: [...uncostedItems],
  };
}
