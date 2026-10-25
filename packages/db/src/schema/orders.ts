/**
 * Schema: order numbering counters, orders and order items.
 */
import { FULFILLMENTS, ORDER_CHANNELS, ORDER_PAYMENT_STATUSES, ORDER_STATUSES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid7.ts';
import { id, money, oneOf, sync, ts } from './columns.ts';
import { menuItems } from './menu.ts';
import { customers, devices, staff } from './people.ts';

// ---------- Orders ----------

export const dailyCounters = pgTable('daily_counters', {
  businessDate: date('business_date', { mode: 'string' }).primaryKey(),
  lastSeq: integer('last_seq').notNull().default(0),
});

export const orders = pgTable(
  'orders',
  {
    id: id(),
    orderNo: text('order_no').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    channel: text('channel').notNull(),
    fulfillment: text('fulfillment').notNull(),
    roomNo: text('room_no'),
    /**
     * Entrance delivery (owner, 2026-10-02): the building whose entrance the order goes to, who
     * receives it, and optional free-text details. Personal data (PDPA): when the order's customer
     * is anonymised the details are cleared and `recipientName` becomes the text
     * `ANONYMIZED_RECIPIENT_NAME` (the check below needs a name), while the building stays because
     * orders are tax records. The retention job replaces name and building 30 days after the order
     * is completed or cancelled (`ANONYMIZED_BUILDING`). The order's `note` stays the kitchen note. Null on platform and
     * legacy orders.
     */
    deliveryBuilding: text('delivery_building'),
    recipientName: text('recipient_name'),
    deliveryNote: text('delivery_note'),
    customerId: uuid('customer_id').references(() => customers.id),
    /**
     * The customer's member profile as it was when the order was placed (owner, 2026-10-11), so
     * staff can tell who it is for. Personal data (PDPA): cleared with the customer
     * (`anonymizeCustomer`) and 30 days after the order is finished (`anonymizeOrderSnapshotsBatch`).
     */
    memberFullName: text('member_full_name'),
    memberNickname: text('member_nickname'),
    memberBuilding: text('member_building'),
    memberPhone: text('member_phone'),
    /**
     * The customer's LINE display name and picture as they were at placement (owner, 2026-10-12),
     * so the kitchen can tell who a LINE order is for. Personal data (PDPA): cleared and retained
     * exactly like the member snapshot above.
     */
    lineDisplayName: text('line_display_name'),
    linePictureUrl: text('line_picture_url'),
    status: text('status').notNull(),
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    /**
     * True while a payment of the order is `claimed` ("โอนแล้ว") and has no slip picture, so the
     * board can flag it without reading payments. Written by the payment code in the transaction
     * that changes the payment (and by `refreshClaimWithoutSlip` where a slip key is cleared), so
     * the order gets a new rev and the change reaches every device. A boolean only: no key leaves.
     */
    claimWithoutSlip: boolean('claim_without_slip').notNull().default(false),
    subtotalSatang: money('subtotal_satang').notNull(),
    discountSatang: money('discount_satang').notNull().default(0),
    discountReason: text('discount_reason'),
    totalSatang: money('total_satang').notNull(),
    platformOrderRef: text('platform_order_ref'),
    platformCommissionSatang: money('platform_commission_satang'),
    note: text('note'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
    createdOnDeviceId: uuid('created_on_device_id').references(() => devices.id),
    /**
     * Set only when the owner took over a device's offline outbox: the staff member who took the
     * order, while `createdByStaffId` is the owner who sent it. Null otherwise.
     */
    originalStaffId: uuid('original_staff_id').references(() => staff.id),
    clientRequestId: uuid('client_request_id').notNull(),
    /**
     * Fingerprint of the request that created the order. A second POST with the same client request
     * id and a different fingerprint is refused instead of returning this order. Null on orders
     * saved before the column existed, which are treated as plain retries.
     */
    requestHash: text('request_hash'),
    placedAt: ts('placed_at').notNull().defaultNow(),
    acceptedAt: ts('accepted_at'),
    readyAt: ts('ready_at'),
    completedAt: ts('completed_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    ...sync,
  },
  (t) => [
    uniqueIndex('orders_client_request_id_key').on(t.clientRequestId),
    uniqueIndex('orders_business_date_order_no_key').on(t.businessDate, t.orderNo),
    index('orders_business_date_idx').on(t.businessDate),
    index('orders_open_status_idx')
      .on(t.status)
      .where(sql`status in ('new', 'preparing', 'ready')`),
    index('orders_customer_id_idx').on(t.customerId),
    index('orders_created_by_staff_id_idx').on(t.createdByStaffId),
    index('orders_created_on_device_id_idx').on(t.createdOnDeviceId),
    index('orders_original_staff_id_idx').on(t.originalStaffId),
    index('orders_rev_idx').on(t.rev),
    check('orders_channel', oneOf('channel', ORDER_CHANNELS)),
    check('orders_fulfillment', oneOf('fulfillment', FULFILLMENTS)),
    check('orders_status', oneOf('status', ORDER_STATUSES)),
    check('orders_payment_status', oneOf('payment_status', ORDER_PAYMENT_STATUSES)),
    check(
      'orders_totals',
      sql`subtotal_satang >= 0 and discount_satang >= 0 and discount_satang <= subtotal_satang and total_satang = subtotal_satang - discount_satang`,
    ),
    check('orders_room_delivery_room', sql`fulfillment <> 'room_delivery' or room_no is not null`),
    check(
      'orders_entrance_delivery_recipient',
      sql`fulfillment <> 'entrance_delivery' or (delivery_building is not null and btrim(delivery_building) <> '' and recipient_name is not null and btrim(recipient_name) <> '')`,
    ),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    /**
     * Made in the app on every ORM insert so the lines of one insert keep their cart order: readers
     * sort by id, and the SQL default is random within a millisecond. The SQL default stays for
     * raw inserts.
     */
    id: id().$defaultFn(() => uuidv7()),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id),
    nameThSnapshot: text('name_th_snapshot').notNull(),
    nameEnSnapshot: text('name_en_snapshot'),
    unitPriceSatang: money('unit_price_satang').notNull(),
    /** Cost snapshot per unit, modifiers included. Null = no cost was entered when it was sold (D-32). */
    unitCostSatang: money('unit_cost_satang'),
    qty: integer('qty').notNull(),
    /** [{ groupId, optionId, name, priceDeltaSatang, costDeltaSatang }] snapshot. */
    modifiers: jsonb('modifiers').notNull().default([]),
    note: text('note'),
    lineTotalSatang: money('line_total_satang').notNull(),
    /**
     * Set when the owner removed this line from a past order (2026-10-11). Rows are never deleted:
     * every reader of an order's lines skips a removed one, and the audit log keeps the before/after.
     */
    removedAt: ts('removed_at'),
  },
  (t) => [
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_menu_item_id_idx').on(t.menuItemId),
    check('order_items_qty', sql`qty >= 1`),
    check('order_items_line_total_nonneg', sql`line_total_satang >= 0`),
  ],
);
