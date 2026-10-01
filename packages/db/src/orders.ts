/**
 * Queries for orders, their items, the daily order counter and the menu data needed to price
 * an order. Only packages/db imports the ORM, so apps/api calls these inside its own
 * transaction. Rules (state machine, pricing, who may do what) stay in apps/api and
 * packages/shared.
 */
import {
  type CatalogGroup,
  type CatalogItem,
  type CatalogOption,
  type Fulfillment,
  type MenuChannel,
  type OrderChannel,
  type OrderStatus,
  type PricedModifier,
  satang,
} from '@sds/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  customers,
  dailyCounters,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
  orderItems,
  orders,
} from './schema.ts';

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

/** Fields a state change or PATCH may write. Everything else on an order is fixed at creation. */
export interface OrderPatch {
  status?: OrderStatus;
  acceptedAt?: Date;
  readyAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  note?: string | null;
  roomNo?: string | null;
}

export interface NewOrder {
  orderNo: string;
  businessDate: string;
  channel: OrderChannel;
  fulfillment: Fulfillment;
  roomNo: string | null;
  customerId: string | null;
  status: OrderStatus;
  subtotalSatang: number;
  discountSatang: number;
  totalSatang: number;
  note: string | null;
  createdByStaffId: string | null;
  createdOnDeviceId: string | null;
  clientRequestId: string;
  requestHash: string;
  placedAt: Date;
  acceptedAt: Date | null;
}

export interface NewOrderItem {
  menuItemId: string;
  nameThSnapshot: string;
  nameEnSnapshot: string | null;
  unitPriceSatang: number;
  unitCostSatang: number;
  qty: number;
  modifiers: PricedModifier[];
  note: string | null;
  lineTotalSatang: number;
}

/**
 * Takes the next number of the business day with ONE statement: INSERT ... ON CONFLICT DO
 * UPDATE locks the day's counter row, so two orders at the same moment cannot read the same
 * value. Run it inside the order's transaction: if the order fails, the number is not used.
 */
export async function nextDailySeq(db: Db, businessDate: string): Promise<number> {
  const [row] = await db
    .insert(dailyCounters)
    .values({ businessDate, lastSeq: 1 })
    .onConflictDoUpdate({
      target: dailyCounters.businessDate,
      set: { lastSeq: sql`${dailyCounters.lastSeq} + 1` },
    })
    .returning({ lastSeq: dailyCounters.lastSeq });
  if (!row) throw new Error('daily counter returned no row');
  return row.lastSeq;
}

export async function findOrderByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<OrderRow | undefined> {
  const [row] = await db
    .select()
    .from(orders)
    .where(eq(orders.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

export async function findOrderById(db: Db, id: string): Promise<OrderRow | undefined> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row;
}

/** Locks the order row until the transaction ends, so two state changes queue up. */
export async function lockOrderById(db: Db, id: string): Promise<OrderRow | undefined> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).for('update').limit(1);
  return row;
}

export async function listOrders(
  db: Db,
  filter: { businessDate: string; status?: OrderStatus; channel?: OrderChannel },
): Promise<OrderRow[]> {
  const conditions = [eq(orders.businessDate, filter.businessDate)];
  if (filter.status) conditions.push(eq(orders.status, filter.status));
  if (filter.channel) conditions.push(eq(orders.channel, filter.channel));
  return db
    .select()
    .from(orders)
    .where(and(...conditions))
    .orderBy(asc(orders.placedAt), asc(orders.id));
}

export async function loadOrderItems(
  db: Db,
  orderIds: readonly string[],
): Promise<Map<string, OrderItemRow[]>> {
  const byOrder = new Map<string, OrderItemRow[]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, [...orderIds]))
    .orderBy(asc(orderItems.id));
  for (const row of rows) {
    const list = byOrder.get(row.orderId);
    if (list) list.push(row);
    else byOrder.set(row.orderId, [row]);
  }
  return byOrder;
}

/**
 * Inserts the order, or returns undefined when another request with the same client request id
 * got there first (the unique index decides, even for two requests at the same instant).
 */
export async function insertOrder(db: Db, order: NewOrder): Promise<OrderRow | undefined> {
  const [row] = await db
    .insert(orders)
    .values(order)
    .onConflictDoNothing({ target: orders.clientRequestId })
    .returning();
  return row;
}

export async function insertOrderItems(
  db: Db,
  orderId: string,
  items: readonly NewOrderItem[],
): Promise<OrderItemRow[]> {
  return db
    .insert(orderItems)
    .values(items.map((item) => ({ ...item, orderId })))
    .returning();
}

/**
 * One UPDATE guarded by the version the caller saw. No row back means the order is missing or
 * changed since; the caller reads it again to tell which. The sync trigger bumps version and rev.
 */
export async function updateOrderIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: OrderPatch,
): Promise<OrderRow | undefined> {
  const [row] = await db
    .update(orders)
    .set(patch)
    .where(and(eq(orders.id, id), eq(orders.version, expectedVersion)))
    .returning();
  return row;
}

export async function customerExists(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);
  return rows.length > 0;
}

/** The menu rows needed to price these items: the item, its channel prices, groups and options. */
export async function loadCatalog(
  db: Db,
  itemIds: readonly string[],
): Promise<Map<string, CatalogItem>> {
  const catalog = new Map<string, CatalogItem>();
  if (itemIds.length === 0) return catalog;
  const ids = [...itemIds];

  const items = await db.select().from(menuItems).where(inArray(menuItems.id, ids));
  const prices = await db
    .select()
    .from(menuItemChannelPrices)
    .where(inArray(menuItemChannelPrices.itemId, ids));
  const links = await db
    .select({ itemId: menuItemModifierGroups.itemId, group: modifierGroups })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.groupId))
    .where(inArray(menuItemModifierGroups.itemId, ids))
    .orderBy(asc(menuItemModifierGroups.sort), asc(modifierGroups.id));
  const groupIds = [...new Set(links.map((l) => l.group.id))];
  const options =
    groupIds.length === 0
      ? []
      : await db.select().from(modifierOptions).where(inArray(modifierOptions.groupId, groupIds));

  const optionsByGroup = new Map<string, CatalogOption[]>();
  for (const o of options) {
    const option: CatalogOption = {
      id: o.id,
      nameTh: o.nameTh,
      nameEn: o.nameEn,
      priceDeltaSatang: satang(o.priceDeltaSatang),
      costDeltaSatang: satang(o.costDeltaSatang),
      isAvailable: o.isAvailable,
      archived: o.archivedAt !== null,
    };
    const list = optionsByGroup.get(o.groupId);
    if (list) list.push(option);
    else optionsByGroup.set(o.groupId, [option]);
  }

  const groupsByItem = new Map<string, CatalogGroup[]>();
  for (const { itemId, group } of links) {
    const entry: CatalogGroup = {
      id: group.id,
      nameTh: group.nameTh,
      nameEn: group.nameEn,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      archived: group.archivedAt !== null,
      options: optionsByGroup.get(group.id) ?? [],
    };
    const list = groupsByItem.get(itemId);
    if (list) list.push(entry);
    else groupsByItem.set(itemId, [entry]);
  }

  const pricesByItem = new Map<string, Partial<Record<MenuChannel, ReturnType<typeof satang>>>>();
  for (const p of prices) {
    const channelPrices = pricesByItem.get(p.itemId) ?? {};
    channelPrices[p.channel as MenuChannel] = satang(p.priceSatang);
    pricesByItem.set(p.itemId, channelPrices);
  }

  for (const item of items) {
    catalog.set(item.id, {
      id: item.id,
      nameTh: item.nameTh,
      nameEn: item.nameEn,
      priceSatang: satang(item.priceSatang),
      estCostSatang: satang(item.estCostSatang),
      isAvailable: item.isAvailable,
      archived: item.archivedAt !== null,
      channels: item.channels as MenuChannel[],
      channelPrices: pricesByItem.get(item.id) ?? {},
      groups: groupsByItem.get(item.id) ?? [],
    });
  }
  return catalog;
}
