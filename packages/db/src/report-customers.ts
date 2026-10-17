/**
 * Customer report queries (P6), re-exported through `reportsRepo`. Read-only.
 */
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { customers, menuItems, orderItems, orders } from './schema.ts';

export interface ReportCustomerRow {
  id: string;
  /** Best name we hold: full name, then nickname, then the LINE display name. Null when none. */
  name: string | null;
  building: string | null;
  firstSeenAt: Date;
  lastOrderAt: Date | null;
  orderCount: number;
  totalSpentSatang: number;
}

/**
 * Customers for the owner's list. Personal data (PDPA): names and building only, no phone and no
 * LINE ids, and an anonymised customer is left out. Most recent order first, never-ordered last.
 *
 * `orderCount` and `totalSpentSatang` are worked out here from paid, not-cancelled orders (the
 * revenue rule of 03 §6: confirmed payments minus partial refunds), not read from the counters on
 * the customer row: `customers.order_count` also counts orders that were never paid or were
 * cancelled, and `customers.total_spent_satang` is never written.
 */
export async function listReportCustomers(db: Db): Promise<ReportCustomerRow[]> {
  // Written out with the table name: drizzle drops it in a one-table select, and `id` would then
  // be ambiguous inside the subqueries.
  const paidOrders = sql<number>`(
    select count(*) from orders o
    where o.customer_id = "customers"."id" and o.payment_status = 'paid' and o.status <> 'cancelled'
  )`.mapWith(Number);
  const spent = sql<number>`(
    coalesce((
      select sum(p.amount_satang) from payments p join orders o on o.id = p.order_id
      where o.customer_id = "customers"."id" and o.payment_status = 'paid' and o.status <> 'cancelled'
        and p.status = 'confirmed'
    ), 0) - coalesce((
      select sum(r.amount_satang) from payment_refunds r
        join payments p on p.id = r.payment_id join orders o on o.id = r.order_id
      where o.customer_id = "customers"."id" and o.payment_status = 'paid' and o.status <> 'cancelled'
        and p.status = 'confirmed'
    ), 0)
  )`.mapWith(Number);
  const rows = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      nickname: customers.nickname,
      displayName: customers.displayName,
      memberBuilding: customers.memberBuilding,
      building: customers.building,
      firstSeenAt: customers.firstSeenAt,
      lastOrderAt: customers.lastOrderAt,
      orderCount: paidOrders,
      totalSpentSatang: spent,
    })
    .from(customers)
    .where(isNull(customers.anonymizedAt))
    .orderBy(
      sql`${customers.lastOrderAt} desc nulls last`,
      desc(customers.firstSeenAt),
      asc(customers.id),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.fullName ?? r.nickname ?? r.displayName,
    building: r.memberBuilding ?? r.building,
    firstSeenAt: r.firstSeenAt,
    lastOrderAt: r.lastOrderAt,
    orderCount: r.orderCount,
    totalSpentSatang: r.totalSpentSatang,
  }));
}

/**
 * Units of each menu item each customer bought, over paid, not-cancelled orders and lines that
 * were not removed, for customers that are not anonymised. The item's current Thai name is used.
 */
export async function listCustomerItemUnits(
  db: Db,
): Promise<{ customerId: string; menuItemId: string; name: string; qty: number }[]> {
  const qty = sql<number>`sum(${orderItems.qty})`.mapWith(Number);
  const rows = await db
    .select({
      customerId: orders.customerId,
      menuItemId: orderItems.menuItemId,
      name: menuItems.nameTh,
      qty,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .innerJoin(menuItems, eq(menuItems.id, orderItems.menuItemId))
    .where(
      and(
        isNotNull(orders.customerId),
        eq(orders.paymentStatus, 'paid'),
        ne(orders.status, 'cancelled'),
        isNull(orderItems.removedAt),
        isNull(customers.anonymizedAt),
      ),
    )
    .groupBy(orders.customerId, orderItems.menuItemId, menuItems.nameTh);
  return rows.flatMap((r) => (r.customerId ? [{ ...r, customerId: r.customerId }] : []));
}
