/**
 * Report queries (P6). Read-only. They load what `@sds/finance` needs, in plain shapes that match
 * its `ReportOrder`; the maths (net of refunds, who counts) stays in that package. Only orders that
 * are `paid` and not cancelled are returned, because no other order can add revenue.
 */
import type {
  OrderChannel,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '@sds/shared';
import { and, asc, between, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from './client.ts';
import { orderItems, orders, paymentRefunds, payments } from './schema.ts';

export interface ReportOrderRow {
  id: string;
  businessDate: string;
  channel: OrderChannel;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  totalSatang: number;
  platformCommissionSatang: number | null;
  placedAt: Date;
  payments: { id: string; method: PaymentMethod; status: PaymentStatus; amountSatang: number }[];
  refunds: { paymentId: string; amountSatang: number }[];
  /** Lines still on the order (removed ones are left out). */
  items: { menuItemId: string; name: string; qty: number; lineTotalSatang: number }[];
}

/** Paid, not-cancelled orders with `business_date` from `from` to `to` (inclusive, `YYYY-MM-DD`). */
export async function listReportOrders(
  db: Db,
  from: string,
  to: string,
): Promise<ReportOrderRow[]> {
  if (from > to) throw new RangeError(`report range starts after it ends: ${from} > ${to}`);
  const inRange = and(
    between(orders.businessDate, from, to),
    eq(orders.paymentStatus, 'paid'),
    ne(orders.status, 'cancelled'),
  );
  const orderRows = await db
    .select({
      id: orders.id,
      businessDate: orders.businessDate,
      channel: orders.channel,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalSatang: orders.totalSatang,
      platformCommissionSatang: orders.platformCommissionSatang,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(inRange)
    .orderBy(asc(orders.businessDate), asc(orders.placedAt), asc(orders.id));
  const paymentRows = await db
    .select({
      orderId: payments.orderId,
      id: payments.id,
      method: payments.method,
      status: payments.status,
      amountSatang: payments.amountSatang,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(inRange);
  const refundRows = await db
    .select({
      orderId: paymentRefunds.orderId,
      paymentId: paymentRefunds.paymentId,
      amountSatang: paymentRefunds.amountSatang,
    })
    .from(paymentRefunds)
    .innerJoin(orders, eq(orders.id, paymentRefunds.orderId))
    .where(inRange);

  const itemRows = await db
    .select({
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      name: orderItems.nameThSnapshot,
      qty: orderItems.qty,
      lineTotalSatang: orderItems.lineTotalSatang,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inRange, isNull(orderItems.removedAt)));

  const paymentsOf = new Map<string, ReportOrderRow['payments']>();
  for (const { orderId, ...p } of paymentRows) {
    const list = paymentsOf.get(orderId) ?? [];
    list.push(p as ReportOrderRow['payments'][number]);
    paymentsOf.set(orderId, list);
  }
  const refundsOf = new Map<string, ReportOrderRow['refunds']>();
  for (const { orderId, ...r } of refundRows) {
    const list = refundsOf.get(orderId) ?? [];
    list.push(r);
    refundsOf.set(orderId, list);
  }
  const itemsOf = new Map<string, ReportOrderRow['items']>();
  for (const { orderId, ...i } of itemRows) {
    const list = itemsOf.get(orderId) ?? [];
    list.push(i);
    itemsOf.set(orderId, list);
  }
  return orderRows.map((o) => ({
    ...(o as Omit<ReportOrderRow, 'payments' | 'refunds'>),
    payments: paymentsOf.get(o.id) ?? [],
    refunds: refundsOf.get(o.id) ?? [],
    items: itemsOf.get(o.id) ?? [],
  }));
}

export * from './report-customers.ts';
