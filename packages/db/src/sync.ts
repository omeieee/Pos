/**
 * Catch-up reads for `GET /v1/sync?since=<rev>` (D-04, 02 §5): everything in the feed with a rev
 * above the client's, oldest first, one page at a time.
 *
 * The feed is built from ALLOW-LISTS. Each synced table has one explicit column map below, and the
 * reader selects only those columns: there is no `select *`, so a column added to a table later
 * reaches nobody until someone lists it here. `SYNC_POLICY` also names every column that is NOT
 * sent, and the test in sync.test.ts fails when a column is in neither list, when a forbidden or
 * suspicious name is allowed, or when a table with a `rev` is neither in the feed nor excluded.
 *
 * What is not in the feed, and why, is in `SYNC_EXCLUDED`. Costs are in the feed for nobody: the
 * REST API never returns them either, so a cost reaches a device only through a report route.
 *
 * Row-level data is cut down here too: order-line `modifiers` (JSON) keep five known keys and lose
 * their cost snapshot, and the PromptPay setting leaves this module masked.
 *
 * Revs are taken when a row is written, so a slow transaction can commit after a newer one has
 * been served: clients rewind by `SYNC_SAFETY_REVS` before each catch-up (see `@sds/shared`).
 */
import { maskPromptpayId, promptpaySettingsSchema, SYNCED_SETTING_KEYS } from '@sds/shared';
import { and, asc, desc, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client.ts';
import {
  customers,
  govCopaySchemes,
  menuCategories,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
  orderItems,
  orders,
  payments,
  settings,
} from './schema.ts';

// ---------- The allow-lists (column maps) ----------

const orderColumns = {
  id: orders.id,
  orderNo: orders.orderNo,
  businessDate: orders.businessDate,
  channel: orders.channel,
  fulfillment: orders.fulfillment,
  roomNo: orders.roomNo,
  customerId: orders.customerId,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  subtotalSatang: orders.subtotalSatang,
  discountSatang: orders.discountSatang,
  totalSatang: orders.totalSatang,
  note: orders.note,
  createdByStaffId: orders.createdByStaffId,
  createdOnDeviceId: orders.createdOnDeviceId,
  placedAt: orders.placedAt,
  acceptedAt: orders.acceptedAt,
  readyAt: orders.readyAt,
  completedAt: orders.completedAt,
  cancelledAt: orders.cancelledAt,
  cancelReason: orders.cancelReason,
  version: orders.version,
  rev: orders.rev,
};

const orderItemColumns = {
  id: orderItems.id,
  orderId: orderItems.orderId,
  menuItemId: orderItems.menuItemId,
  nameThSnapshot: orderItems.nameThSnapshot,
  nameEnSnapshot: orderItems.nameEnSnapshot,
  unitPriceSatang: orderItems.unitPriceSatang,
  qty: orderItems.qty,
  modifiers: orderItems.modifiers,
  note: orderItems.note,
  lineTotalSatang: orderItems.lineTotalSatang,
};

const paymentColumns = {
  id: payments.id,
  orderId: payments.orderId,
  method: payments.method,
  status: payments.status,
  amountSatang: payments.amountSatang,
  tenderedSatang: payments.tenderedSatang,
  changeSatang: payments.changeSatang,
  promptpayTargetMasked: payments.promptpayTargetMasked,
  schemeId: payments.schemeId,
  estGovShareSatang: payments.estGovShareSatang,
  estCustomerShareSatang: payments.estCustomerShareSatang,
  referenceNote: payments.referenceNote,
  claimedAt: payments.claimedAt,
  confirmedByStaffId: payments.confirmedByStaffId,
  confirmedAt: payments.confirmedAt,
  voidReason: payments.voidReason,
  version: payments.version,
  rev: payments.rev,
};

const categoryColumns = {
  id: menuCategories.id,
  nameTh: menuCategories.nameTh,
  nameEn: menuCategories.nameEn,
  sort: menuCategories.sort,
  active: menuCategories.active,
  version: menuCategories.version,
  rev: menuCategories.rev,
};

const itemColumns = {
  id: menuItems.id,
  categoryId: menuItems.categoryId,
  nameTh: menuItems.nameTh,
  nameEn: menuItems.nameEn,
  descriptionTh: menuItems.descriptionTh,
  descriptionEn: menuItems.descriptionEn,
  priceSatang: menuItems.priceSatang,
  imageKey: menuItems.imageKey,
  isAvailable: menuItems.isAvailable,
  channels: menuItems.channels,
  sort: menuItems.sort,
  archivedAt: menuItems.archivedAt,
  version: menuItems.version,
  rev: menuItems.rev,
};

const groupColumns = {
  id: modifierGroups.id,
  nameTh: modifierGroups.nameTh,
  nameEn: modifierGroups.nameEn,
  minSelect: modifierGroups.minSelect,
  maxSelect: modifierGroups.maxSelect,
  sort: modifierGroups.sort,
  archivedAt: modifierGroups.archivedAt,
  version: modifierGroups.version,
  rev: modifierGroups.rev,
};

const optionColumns = {
  id: modifierOptions.id,
  groupId: modifierOptions.groupId,
  nameTh: modifierOptions.nameTh,
  nameEn: modifierOptions.nameEn,
  priceDeltaSatang: modifierOptions.priceDeltaSatang,
  isAvailable: modifierOptions.isAvailable,
  sort: modifierOptions.sort,
  archivedAt: modifierOptions.archivedAt,
  version: modifierOptions.version,
  rev: modifierOptions.rev,
};

const channelPriceColumns = {
  itemId: menuItemChannelPrices.itemId,
  channel: menuItemChannelPrices.channel,
  priceSatang: menuItemChannelPrices.priceSatang,
};

const itemGroupColumns = {
  itemId: menuItemModifierGroups.itemId,
  groupId: menuItemModifierGroups.groupId,
  sort: menuItemModifierGroups.sort,
};

/** Small on purpose (PDPA): what staff need to greet a customer, no LINE id, phone, picture or note. */
const customerColumns = {
  id: customers.id,
  displayName: customers.displayName,
  nickname: customers.nickname,
  roomNo: customers.roomNo,
  firstSeenAt: customers.firstSeenAt,
  lastOrderAt: customers.lastOrderAt,
  orderCount: customers.orderCount,
  totalSpentSatang: customers.totalSpentSatang,
  anonymizedAt: customers.anonymizedAt,
  version: customers.version,
  rev: customers.rev,
};

/** `value` is JSON: which keys are read is decided in `readSettings`, and the ID is masked there. */
const settingColumns = {
  key: settings.key,
  value: settings.value,
  version: settings.version,
  rev: settings.rev,
};

const schemeColumns = {
  id: govCopaySchemes.id,
  code: govCopaySchemes.code,
  nameTh: govCopaySchemes.nameTh,
  nameEn: govCopaySchemes.nameEn,
  govShareBp: govCopaySchemes.govShareBp,
  govDailyCapSatang: govCopaySchemes.govDailyCapSatang,
  govTotalCapSatang: govCopaySchemes.govTotalCapSatang,
  activeFrom: govCopaySchemes.activeFrom,
  activeTo: govCopaySchemes.activeTo,
  activeFromMinute: govCopaySchemes.activeFromMinute,
  activeToMinute: govCopaySchemes.activeToMinute,
  channels: govCopaySchemes.channels,
  settlementNote: govCopaySchemes.settlementNote,
  enabled: govCopaySchemes.enabled,
  version: govCopaySchemes.version,
  rev: govCopaySchemes.rev,
};

type Selected<T extends PgTable, C> = Pick<T['$inferSelect'], keyof C & keyof T['$inferSelect']>;

export type SyncOrderRow = Selected<typeof orders, typeof orderColumns>;
export type SyncOrderItemRow = Selected<typeof orderItems, typeof orderItemColumns>;
export type SyncPaymentRow = Selected<typeof payments, typeof paymentColumns>;
export type SyncCategoryRow = Selected<typeof menuCategories, typeof categoryColumns>;
export type SyncItemRow = Selected<typeof menuItems, typeof itemColumns>;
export type SyncGroupRow = Selected<typeof modifierGroups, typeof groupColumns>;
export type SyncOptionRow = Selected<typeof modifierOptions, typeof optionColumns>;
export type SyncCustomerRow = Selected<typeof customers, typeof customerColumns>;
export type SyncSchemeRow = Selected<typeof govCopaySchemes, typeof schemeColumns>;
/** A setting row as it leaves this module: the PromptPay value is already `{idType, idMasked}`. */
export interface SyncSettingRow {
  key: (typeof SYNCED_SETTING_KEYS)[number];
  value: unknown;
  version: number;
  rev: number;
}

/**
 * Per table: the table, the columns that are sent (read off the real column map, so the list and
 * the query cannot differ) and the columns that are deliberately not sent.
 */
function policy<T extends PgTable>(
  table: T,
  columns: Record<string, unknown>,
  deny: readonly (keyof T['$inferSelect'] & string)[],
) {
  return {
    table: table as PgTable,
    allow: Object.keys(columns) as readonly string[],
    deny: deny as readonly string[],
  };
}

export const SYNC_POLICY = {
  orders: policy(orders, orderColumns, [
    'platformOrderRef',
    'platformCommissionSatang',
    'discountReason',
    'clientRequestId',
    'requestHash',
    'updatedAt',
  ]),
  order_items: policy(orderItems, orderItemColumns, ['unitCostSatang']),
  payments: policy(payments, paymentColumns, [
    'qrPayload',
    'slipImageKey',
    'slipRef',
    'clientRequestId',
    'requestHash',
    'updatedAt',
  ]),
  menu_categories: policy(menuCategories, categoryColumns, ['updatedAt']),
  menu_items: policy(menuItems, itemColumns, ['estCostSatang', 'updatedAt']),
  menu_item_channel_prices: policy(menuItemChannelPrices, channelPriceColumns, []),
  menu_item_modifier_groups: policy(menuItemModifierGroups, itemGroupColumns, []),
  modifier_groups: policy(modifierGroups, groupColumns, ['updatedAt']),
  modifier_options: policy(modifierOptions, optionColumns, ['costDeltaSatang', 'updatedAt']),
  customers: policy(customers, customerColumns, [
    'lineUserId',
    'pictureUrl',
    'phone',
    'note',
    'privacyAckAt',
    'marketingConsentAt',
    'unfollowedAt',
    'updatedAt',
  ]),
  settings: policy(settings, settingColumns, ['updatedBy', 'updatedAt']),
  gov_copay_schemes: policy(govCopaySchemes, schemeColumns, ['updatedAt']),
} as const;

/**
 * Synced tables that are NOT in the feed, with the reason. Failed PIN attempts bump `staff.version`
 * and a device's last-seen time bumps `devices.version`: neither belongs in a feed of what the
 * shop is doing, and each would flood it.
 */
export const SYNC_EXCLUDED: Record<string, string> = {
  staff:
    'Holds PIN hashes and lock counters, and every failed PIN bumps its rev. Staff tiles come from GET /v1/auth/staff and /v1/staff.',
  devices:
    'Holds token hashes and last-seen times that change every few minutes. Devices come from GET /v1/devices (device.manage).',
  expenses:
    'Money outside orders belongs to the back office (expense.edit, report.view) and gets its own routes and audience when it is built.',
};

// ---------- Reading ----------

export interface SyncInclude {
  orders: boolean;
  payments: boolean;
  menu: boolean;
  settings: boolean;
  customers: boolean;
}

export type SyncEntry =
  | { kind: 'order'; rev: number; order: SyncOrderRow; items: SyncOrderItemRow[] }
  | { kind: 'payment'; rev: number; payment: SyncPaymentRow }
  | { kind: 'category'; rev: number; category: SyncCategoryRow }
  | {
      kind: 'item';
      rev: number;
      item: SyncItemRow;
      channelPrices: Record<string, number>;
      groupIds: string[];
    }
  | { kind: 'group'; rev: number; group: SyncGroupRow; options: SyncOptionRow[] }
  | { kind: 'option'; rev: number; option: SyncOptionRow }
  | { kind: 'customer'; rev: number; customer: SyncCustomerRow }
  | { kind: 'setting'; rev: number; setting: SyncSettingRow }
  | { kind: 'gov_copay'; rev: number; scheme: SyncSchemeRow };

export interface SyncBatch {
  /** Oldest rev first, at most `limit`. */
  entries: SyncEntry[];
  hasMore: boolean;
}

const MODIFIER_KEYS = ['groupId', 'optionId', 'nameTh', 'nameEn', 'priceDeltaSatang'] as const;

/**
 * Order-line modifiers are stored as a JSON snapshot that also holds the cost of each option.
 * This keeps the five keys devices show and drops the rest; anything that is not a list of
 * objects becomes an empty list.
 */
export function sanitizeModifiers(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    return [
      Object.fromEntries(MODIFIER_KEYS.filter((k) => k in source).map((k) => [k, source[k]])),
    ];
  });
}

/** The newest rev handed out so far (0 before the first write). Excluded tables use revs too. */
export async function currentRev(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: sql<string | null>`last_value` })
    .from(sql`pg_sequences`)
    .where(sql`sequencename = 'rev_seq'`);
  return row?.value == null ? 0 : Number(row.value);
}

async function readOrders(db: Db, since: number, take: number): Promise<SyncEntry[]> {
  const rows = await db
    .select(orderColumns)
    .from(orders)
    .where(gt(orders.rev, since))
    .orderBy(asc(orders.rev))
    .limit(take);
  return rows.map((order) => ({ kind: 'order', rev: order.rev, order, items: [] }));
}

async function attachOrderItems(db: Db, entries: SyncEntry[]): Promise<void> {
  const byId = new Map<string, SyncOrderItemRow[]>();
  const ids = entries.flatMap((e) => (e.kind === 'order' ? [e.order.id] : []));
  if (ids.length === 0) return;
  const rows = await db
    .select(orderItemColumns)
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids))
    .orderBy(asc(orderItems.id));
  for (const row of rows) {
    const list = byId.get(row.orderId) ?? [];
    list.push({ ...row, modifiers: sanitizeModifiers(row.modifiers) });
    byId.set(row.orderId, list);
  }
  for (const e of entries) if (e.kind === 'order') e.items = byId.get(e.order.id) ?? [];
}

async function readPayments(db: Db, since: number, take: number): Promise<SyncEntry[]> {
  const rows = await db
    .select(paymentColumns)
    .from(payments)
    .where(gt(payments.rev, since))
    .orderBy(asc(payments.rev))
    .limit(take);
  return rows.map((payment) => ({ kind: 'payment', rev: payment.rev, payment }));
}

async function readMenu(db: Db, since: number, take: number): Promise<SyncEntry[]> {
  const [categories, items, groups, options] = await Promise.all([
    db
      .select(categoryColumns)
      .from(menuCategories)
      .where(gt(menuCategories.rev, since))
      .orderBy(asc(menuCategories.rev))
      .limit(take),
    db
      .select(itemColumns)
      .from(menuItems)
      .where(gt(menuItems.rev, since))
      .orderBy(asc(menuItems.rev))
      .limit(take),
    db
      .select(groupColumns)
      .from(modifierGroups)
      .where(gt(modifierGroups.rev, since))
      .orderBy(asc(modifierGroups.rev))
      .limit(take),
    db
      .select(optionColumns)
      .from(modifierOptions)
      .where(gt(modifierOptions.rev, since))
      .orderBy(asc(modifierOptions.rev))
      .limit(take),
  ]);
  const entries: SyncEntry[] = [
    ...categories.map((category): SyncEntry => ({ kind: 'category', rev: category.rev, category })),
    ...items.map(
      (item): SyncEntry => ({
        kind: 'item',
        rev: item.rev,
        item,
        channelPrices: {},
        groupIds: [],
      }),
    ),
    ...groups.map((group): SyncEntry => ({ kind: 'group', rev: group.rev, group, options: [] })),
    ...options.map((option): SyncEntry => ({ kind: 'option', rev: option.rev, option })),
  ];
  return entries;
}

/** Channel prices, attached groups and live options for the menu entries that made the page. */
async function attachMenuExtras(db: Db, entries: SyncEntry[]): Promise<void> {
  const itemIds = entries.flatMap((e) => (e.kind === 'item' ? [e.item.id] : []));
  if (itemIds.length > 0) {
    const prices = await db
      .select(channelPriceColumns)
      .from(menuItemChannelPrices)
      .where(inArray(menuItemChannelPrices.itemId, itemIds));
    const links = await db
      .select(itemGroupColumns)
      .from(menuItemModifierGroups)
      .where(inArray(menuItemModifierGroups.itemId, itemIds))
      .orderBy(asc(menuItemModifierGroups.sort), asc(menuItemModifierGroups.groupId));
    for (const e of entries) {
      if (e.kind !== 'item') continue;
      e.channelPrices = Object.fromEntries(
        prices.filter((p) => p.itemId === e.item.id).map((p) => [p.channel, p.priceSatang]),
      );
      e.groupIds = links.filter((l) => l.itemId === e.item.id).map((l) => l.groupId);
    }
  }
  const groupIds = entries.flatMap((e) => (e.kind === 'group' ? [e.group.id] : []));
  if (groupIds.length > 0) {
    const options = await db
      .select(optionColumns)
      .from(modifierOptions)
      .where(and(inArray(modifierOptions.groupId, groupIds), isNull(modifierOptions.archivedAt)))
      .orderBy(asc(modifierOptions.sort), asc(modifierOptions.id));
    for (const e of entries) {
      if (e.kind === 'group') e.options = options.filter((o) => o.groupId === e.group.id);
    }
  }
}

async function readCustomers(db: Db, since: number, take: number): Promise<SyncEntry[]> {
  const rows = await db
    .select(customerColumns)
    .from(customers)
    .where(gt(customers.rev, since))
    .orderBy(asc(customers.rev))
    .limit(take);
  return rows.map((customer) => ({ kind: 'customer', rev: customer.rev, customer }));
}

/** Only the listed keys are read; the PromptPay value is masked, or the row is skipped if it will not parse. */
async function readSettings(db: Db, since: number, take: number): Promise<SyncEntry[]> {
  const rows = await db
    .select(settingColumns)
    .from(settings)
    .where(and(gt(settings.rev, since), inArray(settings.key, [...SYNCED_SETTING_KEYS])))
    .orderBy(asc(settings.rev))
    .limit(take);
  const entries: SyncEntry[] = [];
  for (const row of rows) {
    const key = row.key as SyncSettingRow['key'];
    let value: unknown = row.value;
    if (key === 'promptpay') {
      const parsed = promptpaySettingsSchema.safeParse(row.value);
      if (!parsed.success) continue;
      value = { idType: parsed.data.idType, idMasked: maskPromptpayId(parsed.data.idValue) };
    }
    entries.push({
      kind: 'setting',
      rev: row.rev,
      setting: { key, value, version: row.version, rev: row.rev },
    });
  }
  return entries;
}

/** The scheme the shop uses (the round that ends last), if it changed after `since`. */
async function readScheme(db: Db, since: number): Promise<SyncEntry[]> {
  const [scheme] = await db
    .select(schemeColumns)
    .from(govCopaySchemes)
    .orderBy(desc(govCopaySchemes.activeTo), desc(govCopaySchemes.id))
    .limit(1);
  return scheme && scheme.rev > since ? [{ kind: 'gov_copay', rev: scheme.rev, scheme }] : [];
}

/**
 * The next page of changes in `include`'s families with a rev above `since`. Each family is read
 * for `limit + 1` rows and the lot is merged by rev, so a page never skips a row and `hasMore` is
 * exact.
 */
export async function readChanges(
  db: Db,
  request: { since: number; limit: number; include: SyncInclude },
): Promise<SyncBatch> {
  const { since, limit, include } = request;
  const take = limit + 1;
  const parts = await Promise.all([
    include.orders ? readOrders(db, since, take) : [],
    include.payments ? readPayments(db, since, take) : [],
    include.menu ? readMenu(db, since, take) : [],
    include.customers ? readCustomers(db, since, take) : [],
    include.settings ? readSettings(db, since, take) : [],
    include.settings ? readScheme(db, since) : [],
  ]);
  const merged = parts.flat().sort((a, b) => a.rev - b.rev);
  const page = merged.slice(0, limit);
  await attachOrderItems(db, page);
  await attachMenuExtras(db, page);
  return { entries: page, hasMore: merged.length > limit };
}
