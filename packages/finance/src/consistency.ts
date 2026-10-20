/**
 * Guard for the reports (P6 follow-up). One order whose refunds add up to more than its payment is
 * a data fault, not a reason to fail a whole report. Such an order is left out of the figures and
 * named, so the owner can look at it. Nothing is clamped: its numbers are simply not trusted.
 */
import { isCounted, keptPayments, type ReportOrder } from './revenue.ts';

export interface SplitOrders {
  usable: ReportOrder[];
  excludedOrderIds: string[];
}

export function splitInconsistent(orders: readonly ReportOrder[]): SplitOrders {
  const usable: ReportOrder[] = [];
  const excludedOrderIds: string[] = [];
  for (const order of orders) {
    if (isCounted(order)) {
      try {
        keptPayments(order);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        excludedOrderIds.push(order.id);
        continue;
      }
    }
    usable.push(order);
  }
  return { usable, excludedOrderIds };
}
