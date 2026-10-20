/**
 * Daily revenue (03-data-model §6). Pure: it takes orders already loaded with their payments and
 * partial refunds, and returns one row per business date.
 *
 * - Only orders that are `paid` and not cancelled count; partly paid, unpaid and awaiting ones do not.
 * - An order's revenue is its confirmed payments minus their partial refunds (net paid). Pending,
 *   claimed, cancelled, voided and wholly refunded payments count nothing.
 * - Everything lands on the order's own `business_date`, so a refund made after midnight still
 *   counts against the day of the original order.
 * - A platform order counts the platform price; the commission is reported beside it, not netted.
 * - A co-pay payment's amount is the full amount due (government share plus customer share).
 */
import type {
  OrderChannel,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '@sds/shared';

export interface ReportPayment {
  id: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountSatang: number;
}

export interface ReportRefund {
  paymentId: string;
  amountSatang: number;
}

export interface ReportItem {
  menuItemId: string;
  /** The Thai name as saved on the order line. */
  name: string;
  qty: number;
  lineTotalSatang: number;
  /**
   * The cost snapshot of one unit (modifier costs included) saved on the order line when it was
   * sold, or null when no cost had been entered then (D-32). 0 is a real cost, never "unknown".
   */
  unitCostSatang: number | null;
}

export interface ReportOrder {
  id: string;
  /** ISO `YYYY-MM-DD`, as stored on the order. */
  businessDate: string;
  channel: OrderChannel;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  totalSatang: number;
  platformCommissionSatang: number | null;
  placedAt: Date;
  payments: readonly ReportPayment[];
  refunds: readonly ReportRefund[];
  /** Lines that were not removed from the order. */
  items: readonly ReportItem[];
}

export interface DayRevenue {
  businessDate: string;
  revenueSatang: number;
  orderCount: number;
  /** Revenue / orders, rounded half up to one satang. */
  averageTicketSatang: number;
  commissionSatang: number;
  byChannel: Partial<Record<OrderChannel, number>>;
  byMethod: Partial<Record<PaymentMethod, number>>;
}

function assertSatang(value: number, label: string): void {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be an integer, got ${value}`);
}

function refundedByPayment(refunds: readonly ReportRefund[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of refunds) {
    assertSatang(r.amountSatang, 'refund amount');
    out.set(r.paymentId, (out.get(r.paymentId) ?? 0) + r.amountSatang);
  }
  return out;
}

/** Whether an order can add revenue at all: paid, and not cancelled. */
export function isCounted(order: Pick<ReportOrder, 'status' | 'paymentStatus'>): boolean {
  return order.status !== 'cancelled' && order.paymentStatus === 'paid';
}

/** What each confirmed payment of a counted order keeps after its own partial refunds. */
export function keptPayments(order: ReportOrder): { method: PaymentMethod; kept: number }[] {
  const refunded = refundedByPayment(order.refunds);
  const out: { method: PaymentMethod; kept: number }[] = [];
  for (const p of order.payments) {
    if (p.status !== 'confirmed') continue;
    assertSatang(p.amountSatang, 'payment amount');
    const back = refunded.get(p.id) ?? 0;
    if (back > p.amountSatang) {
      throw new RangeError(
        `refunds of payment ${p.id} (${back}) exceed its amount (${p.amountSatang})`,
      );
    }
    out.push({ method: p.method, kept: p.amountSatang - back });
  }
  return out;
}

/** Net paid of a counted order: confirmed payments minus their partial refunds. */
export function netPaidSatang(order: ReportOrder): number {
  let net = 0;
  for (const p of keptPayments(order)) net += p.kept;
  return net;
}

export function revenueByDay(orders: readonly ReportOrder[]): DayRevenue[] {
  const days = new Map<string, DayRevenue>();
  for (const order of orders) {
    if (!isCounted(order)) continue;
    let day = days.get(order.businessDate);
    if (!day) {
      day = {
        businessDate: order.businessDate,
        revenueSatang: 0,
        orderCount: 0,
        averageTicketSatang: 0,
        commissionSatang: 0,
        byChannel: {},
        byMethod: {},
      };
      days.set(order.businessDate, day);
    }
    let net = 0;
    for (const p of keptPayments(order)) {
      net += p.kept;
      day.byMethod[p.method] = (day.byMethod[p.method] ?? 0) + p.kept;
    }
    day.revenueSatang += net;
    day.orderCount += 1;
    day.byChannel[order.channel] = (day.byChannel[order.channel] ?? 0) + net;
    if (order.platformCommissionSatang !== null) {
      assertSatang(order.platformCommissionSatang, 'platform commission');
      day.commissionSatang += order.platformCommissionSatang;
    }
  }
  const rows = [...days.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  for (const d of rows) {
    d.averageTicketSatang = Math.floor((2 * d.revenueSatang + d.orderCount) / (2 * d.orderCount));
  }
  return rows;
}
