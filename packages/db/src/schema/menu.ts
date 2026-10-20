/**
 * Schema: menu categories, items, photos, channel prices, modifier groups and options.
 */
import { MENU_CHANNELS, PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, money, oneOf, sync, ts } from './columns.ts';

// ---------- Menu ----------

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: id(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
    /**
     * Idempotency (CLAUDE.md rule 6) for the create route, like `orders.client_request_id`: the
     * client's request id, and a fingerprint of the request body. Both null on rows made without
     * one (every row before migration 0015, and any create sent without `clientRequestId`). A
     * second create with the same id and the same fingerprint returns this row; with another
     * fingerprint it is refused. The unique index allows many nulls.
     */
    clientRequestId: uuid('client_request_id'),
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    index('menu_categories_rev_idx').on(t.rev),
    uniqueIndex('menu_categories_client_request_id_key').on(t.clientRequestId),
  ],
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
    /** Null = the owner has not entered a cost (D-32); 0 is a real cost of nothing. */
    estCostSatang: money('est_cost_satang'),
    imageKey: text('image_key'),
    /**
     * The version of this item's photo (D-21), or null when it has none. It travels in the feed so
     * clients know when to refetch `GET /v1/menu/items/:id/photo?v=`; the bytes never do (they are
     * in `menu_item_photos`). Set to the item's next `version`, so it only ever grows for an item
     * and a deleted-then-replaced photo never reuses a URL a browser has cached as immutable.
     */
    photoVersion: integer('photo_version'),
    isAvailable: boolean('is_available').notNull().default(true),
    channels: text('channels').array().notNull().default(sql`'{storefront,line}'::text[]`),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
    /**
     * Idempotency (CLAUDE.md rule 6) for the create route, like `orders.client_request_id`: the
     * client's request id, and a fingerprint of the request body. Both null on rows made without
     * one (every row before migration 0015, and any create sent without `clientRequestId`). A
     * second create with the same id and the same fingerprint returns this row; with another
     * fingerprint it is refused. The unique index allows many nulls.
     */
    clientRequestId: uuid('client_request_id'),
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    index('menu_items_rev_idx').on(t.rev),
    uniqueIndex('menu_items_client_request_id_key').on(t.clientRequestId),
    index('menu_items_category_id_idx').on(t.categoryId),
    check('menu_items_price_nonneg', sql`${t.priceSatang} >= 0 and ${t.estCostSatang} >= 0`),
    check(
      'menu_items_channels_valid',
      sql.raw(`channels <@ array[${MENU_CHANNELS.map((c) => `'${c}'`).join(',')}]::text[]`),
    ),
  ],
);

/**
 * The photo of a menu item (D-21), apart from `menu_items` so the bytes never reach the sync feed
 * or an item query. At most one per item; the API validates the bytes (magic numbers, size) before
 * it writes. Not a synced table: it has no rev, and a change is announced by `menu_items`.
 */
export const menuItemPhotos = pgTable(
  'menu_item_photos',
  {
    menuItemId: uuid('menu_item_id')
      .primaryKey()
      .references(() => menuItems.id),
    contentType: text('content_type').notNull(),
    bytes: bytea('bytes').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    version: integer('version').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('menu_item_photos_type', oneOf('content_type', PHOTO_CONTENT_TYPES)),
    check(
      'menu_item_photos_size',
      sql.raw(`byte_size between 1 and ${PHOTO_MAX_BYTES} and octet_length(bytes) = byte_size`),
    ),
    check('menu_item_photos_dimensions', sql`${t.width} > 0 and ${t.height} > 0`),
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
    /**
     * Idempotency (CLAUDE.md rule 6) for the create route, like `orders.client_request_id`: the
     * client's request id, and a fingerprint of the request body. Both null on rows made without
     * one (every row before migration 0015, and any create sent without `clientRequestId`). A
     * second create with the same id and the same fingerprint returns this row; with another
     * fingerprint it is refused. The unique index allows many nulls.
     */
    clientRequestId: uuid('client_request_id'),
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    index('modifier_groups_rev_idx').on(t.rev),
    uniqueIndex('modifier_groups_client_request_id_key').on(t.clientRequestId),
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
    /**
     * Idempotency (CLAUDE.md rule 6) for the create route, like `orders.client_request_id`: the
     * client's request id, and a fingerprint of the request body. Both null on rows made without
     * one (every row before migration 0015, and any create sent without `clientRequestId`). A
     * second create with the same id and the same fingerprint returns this row; with another
     * fingerprint it is refused. The unique index allows many nulls.
     */
    clientRequestId: uuid('client_request_id'),
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    index('modifier_options_rev_idx').on(t.rev),
    uniqueIndex('modifier_options_client_request_id_key').on(t.clientRequestId),
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
