/**
 * Schema v1 (03-data-model). This file is the source of truth once it exists;
 * keep docs/03-data-model.md in step with it.
 *
 * - IDs: UUIDv7 from uuid_generate_v7() (portable plpgsql, migration 0000).
 * - Money: bigint satang read as JS number (D-11 note).
 * - Synced tables: `version` (+1 on update) and `rev` (global rev_seq) are set by
 *   the sync trigger (migration 0002); `updated_at` too.
 */
import {
  AUDIT_ACTOR_TYPES,
  DEVICE_KINDS,
  EXPENSE_CATEGORIES,
  FULFILLMENTS,
  MENU_CHANNELS,
  ORDER_CHANNELS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SESSION_KINDS,
  STAFF_ROLES,
} from '@sds/shared';
import { type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const revSeq = pgSequence('rev_seq');

const id = () => uuid('id').primaryKey().default(sql`uuid_generate_v7()`);
const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const sync = {
  version: integer('version').notNull().default(1),
  rev: bigint('rev', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
};

function oneOf(column: string, values: readonly string[]): SQL {
  return sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);
}

// ---------- Menu ----------

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: id(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...sync,
  },
  (t) => [index('menu_categories_rev_idx').on(t.rev)],
);

export const menuItems = pgTable(
  'menu_items',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => menuCategories.id),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    descriptionTh: text('description_th'),
    descriptionEn: text('description_en'),
    priceSatang: money('price_satang').notNull(),
    estCostSatang: money('est_cost_satang').notNull().default(0),
    imageKey: text('image_key'),
    isAvailable: boolean('is_available').notNull().default(true),
    channels: text('channels').array().notNull().default(sql`'{storefront,line}'::text[]`),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
    ...sync,
  },
  (t) => [
    index('menu_items_rev_idx').on(t.rev),
    index('menu_items_category_id_idx').on(t.categoryId),
    check('menu_items_price_nonneg', sql`${t.priceSatang} >= 0 and ${t.estCostSatang} >= 0`),
    check(
      'menu_items_channels_valid',
      sql.raw(`channels <@ array[${MENU_CHANNELS.map((c) => `'${c}'`).join(',')}]::text[]`),
    ),
  ],
);

export const menuItemChannelPrices = pgTable(
  'menu_item_channel_prices',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => menuItems.id),
    channel: text('channel').notNull(),
    priceSatang: money('price_satang').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.channel] }),
    check('menu_item_channel_prices_channel', oneOf('channel', MENU_CHANNELS)),
    check('menu_item_channel_prices_nonneg', sql`${t.priceSatang} >= 0`),
  ],
);

export const modifierGroups = pgTable(
  'modifier_groups',
  {
    id: id(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    minSelect: integer('min_select').notNull().default(0),
    maxSelect: integer('max_select').notNull().default(1),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
    ...sync,
  },
  (t) => [
    index('modifier_groups_rev_idx').on(t.rev),
    check('modifier_groups_select_range', sql`0 <= min_select and min_select <= max_select`),
  ],
);

export const modifierOptions = pgTable(
  'modifier_options',
  {
    id: id(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    priceDeltaSatang: money('price_delta_satang').notNull().default(0),
    costDeltaSatang: money('cost_delta_satang').notNull().default(0),
    isAvailable: boolean('is_available').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
    ...sync,
  },
  (t) => [
    index('modifier_options_rev_idx').on(t.rev),
    index('modifier_options_group_id_idx').on(t.groupId),
  ],
);

export const menuItemModifierGroups = pgTable(
  'menu_item_modifier_groups',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => menuItems.id),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.groupId] }),
    index('menu_item_modifier_groups_group_id_idx').on(t.groupId),
  ],
);

// ---------- People and devices ----------

export const customers = pgTable(
  'customers',
  {
    id: id(),
    lineUserId: text('line_user_id'),
    displayName: text('display_name'),
    pictureUrl: text('picture_url'),
    nickname: text('nickname'),
    phone: text('phone'),
    roomNo: text('room_no'),
    note: text('note'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastOrderAt: ts('last_order_at'),
    orderCount: integer('order_count').notNull().default(0),
    totalSpentSatang: money('total_spent_satang').notNull().default(0),
    privacyAckAt: ts('privacy_ack_at'),
    marketingConsentAt: ts('marketing_consent_at'),
    unfollowedAt: ts('unfollowed_at'),
    anonymizedAt: ts('anonymized_at'),
    ...sync,
  },
  (t) => [
    uniqueIndex('customers_line_user_id_key').on(t.lineUserId),
    index('customers_rev_idx').on(t.rev),
  ],
);

export const staff = pgTable(
  'staff',
  {
    id: id(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    pinHash: text('pin_hash'),
    active: boolean('active').notNull().default(true),
    failedPinCount: integer('failed_pin_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    /** Step-up (a signed-in session re-entering the PIN) counts and locks apart from sign-in. */
    stepUpFailedCount: integer('step_up_failed_count').notNull().default(0),
    stepUpLockedUntil: ts('step_up_locked_until'),
    /** Lock cycles since the last success: 5 min, then 1 h, then 24 h. Reset on a successful sign-in. */
    pinLockLevel: integer('pin_lock_level').notNull().default(0),
    stepUpLockLevel: integer('step_up_lock_level').notNull().default(0),
    ...sync,
  },
  (t) => [index('staff_rev_idx').on(t.rev), check('staff_role', oneOf('role', STAFF_ROLES))],
);

export const ownerCredentials = pgTable('owner_credentials', {
  staffId: uuid('staff_id')
    .primaryKey()
    .references(() => staff.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  /** Step-up counts and locks apart from the public sign-in above. */
  stepUpFailedCount: integer('step_up_failed_count').notNull().default(0),
  stepUpLockedUntil: ts('step_up_locked_until'),
  /** Highest TOTP time step already accepted: a code is single use (RFC 6238 §5.2). */
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** HMAC hashes of the unused one-time recovery codes. */
  recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default(sql`'{}'::text[]`),
});

export const devices = pgTable(
  'devices',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
    ...sync,
  },
  (t) => [index('devices_rev_idx').on(t.rev), check('devices_kind', oneOf('kind', DEVICE_KINDS))],
);

/**
 * Login sessions (02 §7): opaque bearer tokens kept as a SHA-256 hash. Not synced to
 * clients, so there is no rev/version. Expiry is compared in application code.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id),
    /** The registered device a PIN session is bound to; null for an owner login without one. */
    deviceId: uuid('device_id').references(() => devices.id),
    /** Decides the idle timeout: a PIN session at the counter lives longer than an owner login. */
    kind: text('kind').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Absolute end of the session. */
    expiresAt: ts('expires_at').notNull(),
    /** Idle timeout is measured from here. */
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    /** Step-up (re-authentication) is valid until this instant. */
    stepUpUntil: ts('step_up_until'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('sessions_staff_id_idx').on(t.staffId),
    index('sessions_device_id_idx').on(t.deviceId),
    check('sessions_kind', oneOf('kind', SESSION_KINDS)),
  ],
);

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
    customerId: uuid('customer_id').references(() => customers.id),
    status: text('status').notNull(),
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    subtotalSatang: money('subtotal_satang').notNull(),
    discountSatang: money('discount_satang').notNull().default(0),
    discountReason: text('discount_reason'),
    totalSatang: money('total_satang').notNull(),
    platformOrderRef: text('platform_order_ref'),
    platformCommissionSatang: money('platform_commission_satang'),
    note: text('note'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
    createdOnDeviceId: uuid('created_on_device_id').references(() => devices.id),
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
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id),
    nameThSnapshot: text('name_th_snapshot').notNull(),
    nameEnSnapshot: text('name_en_snapshot'),
    unitPriceSatang: money('unit_price_satang').notNull(),
    unitCostSatang: money('unit_cost_satang').notNull().default(0),
    qty: integer('qty').notNull(),
    /** [{ groupId, optionId, name, priceDeltaSatang, costDeltaSatang }] snapshot. */
    modifiers: jsonb('modifiers').notNull().default([]),
    note: text('note'),
    lineTotalSatang: money('line_total_satang').notNull(),
  },
  (t) => [
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_menu_item_id_idx').on(t.menuItemId),
    check('order_items_qty', sql`qty >= 1`),
    check('order_items_line_total_nonneg', sql`line_total_satang >= 0`),
  ],
);

// ---------- Payments ----------

export const govCopaySchemes = pgTable(
  'gov_copay_schemes',
  {
    id: id(),
    code: text('code').notNull().unique(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    govShareBp: integer('gov_share_bp').notNull(),
    govDailyCapSatang: money('gov_daily_cap_satang'),
    govTotalCapSatang: money('gov_total_cap_satang'),
    activeFrom: date('active_from', { mode: 'string' }).notNull(),
    activeTo: date('active_to', { mode: 'string' }).notNull(),
    /** Minutes from local midnight, e.g. 06:00–23:00 → 360–1380. */
    activeFromMinute: integer('active_from_minute').notNull().default(0),
    activeToMinute: integer('active_to_minute').notNull().default(1440),
    channels: text('channels').array().notNull().default(sql`'{storefront}'::text[]`),
    settlementNote: text('settlement_note'),
    enabled: boolean('enabled').notNull().default(false),
    ...sync,
  },
  (t) => [
    index('gov_copay_schemes_rev_idx').on(t.rev),
    check('gov_copay_schemes_share', sql`gov_share_bp between 0 and 10000`),
    check('gov_copay_schemes_dates', sql`active_from <= active_to`),
    check(
      'gov_copay_schemes_minutes',
      sql`0 <= active_from_minute and active_from_minute < active_to_minute and active_to_minute <= 1440`,
    ),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    method: text('method').notNull(),
    status: text('status').notNull().default('pending'),
    amountSatang: money('amount_satang').notNull(),
    tenderedSatang: money('tendered_satang'),
    changeSatang: money('change_satang'),
    promptpayTargetMasked: text('promptpay_target_masked'),
    qrPayload: text('qr_payload'),
    schemeId: uuid('scheme_id').references(() => govCopaySchemes.id),
    estGovShareSatang: money('est_gov_share_satang'),
    estCustomerShareSatang: money('est_customer_share_satang'),
    slipImageKey: text('slip_image_key'),
    slipRef: text('slip_ref'),
    referenceNote: text('reference_note'),
    claimedAt: ts('claimed_at'),
    confirmedByStaffId: uuid('confirmed_by_staff_id').references(() => staff.id),
    confirmedAt: ts('confirmed_at'),
    voidReason: text('void_reason'),
    clientRequestId: uuid('client_request_id').notNull(),
    /** Fingerprint of the request that made this payment; null on rows saved before it existed. */
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    uniqueIndex('payments_client_request_id_key').on(t.clientRequestId),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_confirmed_by_staff_id_idx').on(t.confirmedByStaffId),
    index('payments_scheme_id_idx').on(t.schemeId),
    index('payments_open_status_idx').on(t.status).where(sql`status in ('pending', 'claimed')`),
    index('payments_rev_idx').on(t.rev),
    check('payments_method', oneOf('method', PAYMENT_METHODS)),
    check('payments_status', oneOf('status', PAYMENT_STATUSES)),
    check('payments_amount_nonneg', sql`amount_satang >= 0`),
    check(
      'payments_cash_change',
      sql`tendered_satang is null or (tendered_satang >= amount_satang and change_satang = tendered_satang - amount_satang)`,
    ),
    // Rule 2: a confirmed payment always names the staff member who confirmed it.
    check(
      'payments_confirmed_by_staff',
      sql`status not in ('confirmed', 'voided', 'refunded') or (confirmed_by_staff_id is not null and confirmed_at is not null)`,
    ),
  ],
);

// ---------- Money outside orders ----------

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    category: text('category').notNull(),
    amountSatang: money('amount_satang').notNull(),
    vendor: text('vendor'),
    note: text('note'),
    receiptImageKey: text('receipt_image_key'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
    ...sync,
  },
  (t) => [
    index('expenses_business_date_idx').on(t.businessDate),
    index('expenses_created_by_staff_id_idx').on(t.createdByStaffId),
    index('expenses_rev_idx').on(t.rev),
    check('expenses_category', oneOf('category', EXPENSE_CATEGORIES)),
    check('expenses_amount_nonneg', sql`amount_satang >= 0`),
  ],
);

export const taxProfiles = pgTable('tax_profiles', {
  year: integer('year').primaryKey(),
  filerType: text('filer_type').notNull().default('individual'),
  allowances: jsonb('allowances').notNull().default({}),
  methodPreference: text('method_preference'),
});

// ---------- Settings, integration, audit ----------

export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by').references(() => staff.id),
    ...sync,
  },
  (t) => [index('settings_rev_idx').on(t.rev), index('settings_updated_by_idx').on(t.updatedBy)],
);

export const lineEvents = pgTable('line_events', {
  webhookEventId: text('webhook_event_id').primaryKey(),
  type: text('type').notNull(),
  userId: text('user_id'),
  payload: jsonb('payload').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  error: text('error'),
});

export const lineMessageLog = pgTable(
  'line_message_log',
  {
    id: id(),
    customerId: uuid('customer_id').references(() => customers.id),
    kind: text('kind').notNull(),
    template: text('template').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    counted: boolean('counted').notNull(),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [
    index('line_message_log_sent_at_idx').on(t.sentAt),
    index('line_message_log_customer_id_idx').on(t.customerId),
    index('line_message_log_order_id_idx').on(t.orderId),
    check('line_message_log_kind', sql`kind in ('reply', 'push')`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    deviceId: uuid('device_id').references(() => devices.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_device_id_idx').on(t.deviceId),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    check('audit_log_actor_type', oneOf('actor_type', AUDIT_ACTOR_TYPES)),
  ],
);

/** Tables that get the sync trigger (rev/version/updated_at). */
export const SYNCED_TABLES = [
  'menu_categories',
  'menu_items',
  'modifier_groups',
  'modifier_options',
  'customers',
  'staff',
  'devices',
  'orders',
  'gov_copay_schemes',
  'payments',
  'expenses',
  'settings',
] as const;
