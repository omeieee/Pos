/**
 * Queries for the menu: categories, items (with channel prices and attached modifier groups),
 * modifier groups and their options. Costs are read only where a writer needs the old value for
 * the audit row; apps/api never puts them in a response.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  menuCategories,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItemPhotos,
  menuItems,
  modifierGroups,
  modifierOptions,
} from './schema.ts';

export type CategoryRow = typeof menuCategories.$inferSelect;
export type ItemRow = typeof menuItems.$inferSelect;
export type GroupRow = typeof modifierGroups.$inferSelect;
export type OptionRow = typeof modifierOptions.$inferSelect;

/**
 * Idempotency of the create routes (migration 0015): a client request id and the fingerprint of the
 * request that carried it. Both are optional; a row made without them has none.
 */
export interface RequestKey {
  clientRequestId?: string | undefined;
  requestHash?: string | undefined;
}

/**
 * A keyed insert found another row with the same client request id (a concurrent request that
 * committed first). Thrown so the caller's transaction rolls back; the caller then reads the
 * winner and decides between a replay and a reuse conflict.
 */
export class DuplicateClientRequest extends Error {
  constructor() {
    super('another request with the same client request id committed first');
    this.name = 'DuplicateClientRequest';
  }
}

// ---------- Categories ----------

export async function listCategories(db: Db): Promise<CategoryRow[]> {
  return db.select().from(menuCategories).orderBy(asc(menuCategories.sort), asc(menuCategories.id));
}

export async function lockCategory(db: Db, id: string): Promise<CategoryRow | undefined> {
  const [row] = await db
    .select()
    .from(menuCategories)
    .where(eq(menuCategories.id, id))
    .for('update')
    .limit(1);
  return row;
}

export async function findCategory(db: Db, id: string): Promise<CategoryRow | undefined> {
  const [row] = await db.select().from(menuCategories).where(eq(menuCategories.id, id)).limit(1);
  return row;
}

export async function findCategoryByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<CategoryRow | undefined> {
  const [row] = await db
    .select()
    .from(menuCategories)
    .where(eq(menuCategories.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

export async function insertCategory(
  db: Db,
  input: { nameTh: string; nameEn: string | null; sort: number } & RequestKey,
): Promise<CategoryRow> {
  const [row] = await db
    .insert(menuCategories)
    .values(input)
    .onConflictDoNothing({ target: menuCategories.clientRequestId })
    .returning();
  if (!row) throw new DuplicateClientRequest();
  return row;
}

export async function updateCategoryIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: Partial<Pick<CategoryRow, 'nameTh' | 'nameEn' | 'sort' | 'active'>>,
): Promise<CategoryRow | undefined> {
  const [row] = await db
    .update(menuCategories)
    .set(patch)
    .where(and(eq(menuCategories.id, id), eq(menuCategories.version, expectedVersion)))
    .returning();
  return row;
}

// ---------- Items ----------

export interface ItemExtras {
  channelPrices: Map<string, Record<string, number>>;
  groupIds: Map<string, string[]>;
}

export async function listItems(db: Db, options: { includeArchived: boolean }): Promise<ItemRow[]> {
  const query = db.select().from(menuItems);
  return (options.includeArchived ? query : query.where(isNull(menuItems.archivedAt))).orderBy(
    asc(menuItems.sort),
    asc(menuItems.id),
  );
}

export async function findItem(db: Db, id: string): Promise<ItemRow | undefined> {
  const [row] = await db.select().from(menuItems).where(eq(menuItems.id, id)).limit(1);
  return row;
}

export async function lockItem(db: Db, id: string): Promise<ItemRow | undefined> {
  const [row] = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.id, id))
    .for('update')
    .limit(1);
  return row;
}

/** Channel price overrides and attached group ids (in display order) for these items. */
export async function loadItemExtras(db: Db, itemIds: readonly string[]): Promise<ItemExtras> {
  const extras: ItemExtras = { channelPrices: new Map(), groupIds: new Map() };
  if (itemIds.length === 0) return extras;
  const ids = [...itemIds];
  const prices = await db
    .select()
    .from(menuItemChannelPrices)
    .where(inArray(menuItemChannelPrices.itemId, ids));
  for (const p of prices) {
    const map = extras.channelPrices.get(p.itemId) ?? {};
    map[p.channel] = p.priceSatang;
    extras.channelPrices.set(p.itemId, map);
  }
  const links = await db
    .select()
    .from(menuItemModifierGroups)
    .where(inArray(menuItemModifierGroups.itemId, ids))
    .orderBy(asc(menuItemModifierGroups.sort), asc(menuItemModifierGroups.groupId));
  for (const l of links) {
    const list = extras.groupIds.get(l.itemId) ?? [];
    list.push(l.groupId);
    extras.groupIds.set(l.itemId, list);
  }
  return extras;
}

export async function findItemByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<ItemRow | undefined> {
  const [row] = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

export interface NewItem {
  categoryId: string;
  nameTh: string;
  nameEn: string | null;
  descriptionTh: string | null;
  descriptionEn: string | null;
  priceSatang: number;
  estCostSatang: number;
  /** The photo URL (stored in the image_key column until photos have their own store). */
  imageKey: string | null;
  channels: string[];
  sort: number;
  isAvailable: boolean;
}

export async function insertItem(db: Db, input: NewItem & RequestKey): Promise<ItemRow> {
  const [row] = await db
    .insert(menuItems)
    .values(input)
    .onConflictDoNothing({ target: menuItems.clientRequestId })
    .returning();
  if (!row) throw new DuplicateClientRequest();
  return row;
}

export type ItemPatch = Partial<NewItem> & {
  archivedAt?: Date | null;
  updatedAt?: Date;
  photoVersion?: number | null;
};

/** One UPDATE guarded by the version the caller saw; the sync trigger bumps version and rev. */
export async function updateItemIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: ItemPatch,
): Promise<ItemRow | undefined> {
  const [row] = await db
    .update(menuItems)
    .set(patch)
    .where(and(eq(menuItems.id, id), eq(menuItems.version, expectedVersion)))
    .returning();
  return row;
}

export async function replaceItemChannelPrices(
  db: Db,
  itemId: string,
  prices: Record<string, number>,
): Promise<void> {
  await db.delete(menuItemChannelPrices).where(eq(menuItemChannelPrices.itemId, itemId));
  const rows = Object.entries(prices).map(([channel, priceSatang]) => ({
    itemId,
    channel,
    priceSatang,
  }));
  if (rows.length > 0) await db.insert(menuItemChannelPrices).values(rows);
}

export async function replaceItemGroups(
  db: Db,
  itemId: string,
  groupIds: readonly string[],
): Promise<void> {
  await db.delete(menuItemModifierGroups).where(eq(menuItemModifierGroups.itemId, itemId));
  if (groupIds.length > 0) {
    await db
      .insert(menuItemModifierGroups)
      .values(groupIds.map((groupId, index) => ({ itemId, groupId, sort: index + 1 })));
  }
}

// ---------- Item photos (D-21) ----------

export type PhotoRow = typeof menuItemPhotos.$inferSelect;

export interface NewPhoto {
  contentType: string;
  bytes: Buffer;
  width: number;
  height: number;
  version: number;
}

export async function findPhoto(db: Db, itemId: string): Promise<PhotoRow | undefined> {
  const [row] = await db
    .select()
    .from(menuItemPhotos)
    .where(eq(menuItemPhotos.menuItemId, itemId))
    .limit(1);
  return row;
}

/** Inserts or replaces the item's one photo row. */
export async function setPhoto(db: Db, itemId: string, photo: NewPhoto): Promise<void> {
  const values = {
    contentType: photo.contentType,
    bytes: photo.bytes,
    byteSize: photo.bytes.length,
    width: photo.width,
    height: photo.height,
    version: photo.version,
    updatedAt: new Date(),
  };
  await db
    .insert(menuItemPhotos)
    .values({ menuItemId: itemId, ...values })
    .onConflictDoUpdate({ target: menuItemPhotos.menuItemId, set: values });
}

/** True when there was a photo to remove. */
export async function deletePhoto(db: Db, itemId: string): Promise<boolean> {
  const removed = await db
    .delete(menuItemPhotos)
    .where(eq(menuItemPhotos.menuItemId, itemId))
    .returning({ id: menuItemPhotos.menuItemId });
  return removed.length > 0;
}

/** What decides whether a photo may be served and which ETag it has: never the bytes. */
export interface ServablePhoto {
  contentType: string;
  version: number;
}

/**
 * What the PUBLIC photo route may serve (no session): the photo the item points at (`photo_version`
 * equals the stored version), for an item that is not archived and sits in an active category.
 * Sold-out items count: staff tills show their tiles with the picture. One query, so a caller cannot
 * tell "no such item" from "archived" from "no photo". It leaves the 200 KB `bytes` column alone, so
 * a 304 costs no image read; `findPhotoBytes` loads them once the answer is a 200.
 */
export async function findServablePhoto(
  db: Db,
  itemId: string,
): Promise<ServablePhoto | undefined> {
  const [row] = await db
    .select({
      contentType: menuItemPhotos.contentType,
      version: menuItemPhotos.version,
    })
    .from(menuItems)
    .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
    .innerJoin(
      menuItemPhotos,
      and(
        eq(menuItemPhotos.menuItemId, menuItems.id),
        eq(menuItemPhotos.version, menuItems.photoVersion),
      ),
    )
    .where(
      and(eq(menuItems.id, itemId), isNull(menuItems.archivedAt), eq(menuCategories.active, true)),
    )
    .limit(1);
  return row;
}

/** The image bytes at exactly this version (undefined when the photo changed or went meanwhile). */
export async function findPhotoBytes(
  db: Db,
  itemId: string,
  version: number,
): Promise<Buffer | undefined> {
  const [row] = await db
    .select({ bytes: menuItemPhotos.bytes })
    .from(menuItemPhotos)
    .where(and(eq(menuItemPhotos.menuItemId, itemId), eq(menuItemPhotos.version, version)))
    .limit(1);
  return row?.bytes;
}

// ---------- Reorder ----------

export type SiblingKind = 'categories' | 'items' | 'groups' | 'options';

/** One row of a sibling set as the reorder needs it. */
export interface Sibling {
  id: string;
  sort: number;
  version: number;
  rev: number;
}

/**
 * The sibling set of a reorder, locked FOR UPDATE in id order (so two reorders cannot deadlock),
 * listed in display order. Categories: all. Items: live ones of the category. Groups: live ones.
 * Options: live ones of the group.
 */
export async function lockSiblings(
  db: Db,
  kind: SiblingKind,
  parentId: string | undefined,
): Promise<Sibling[]> {
  if ((kind === 'items' || kind === 'options') && parentId === undefined) {
    throw new Error(`reordering ${kind} needs a parent id`);
  }
  let rows: Sibling[];
  switch (kind) {
    case 'categories':
      rows = await db
        .select({
          id: menuCategories.id,
          sort: menuCategories.sort,
          version: menuCategories.version,
          rev: menuCategories.rev,
        })
        .from(menuCategories)
        .orderBy(asc(menuCategories.id))
        .for('update');
      break;
    case 'items':
      rows = await db
        .select({
          id: menuItems.id,
          sort: menuItems.sort,
          version: menuItems.version,
          rev: menuItems.rev,
        })
        .from(menuItems)
        .where(and(eq(menuItems.categoryId, parentId as string), isNull(menuItems.archivedAt)))
        .orderBy(asc(menuItems.id))
        .for('update');
      break;
    case 'groups':
      rows = await db
        .select({
          id: modifierGroups.id,
          sort: modifierGroups.sort,
          version: modifierGroups.version,
          rev: modifierGroups.rev,
        })
        .from(modifierGroups)
        .where(isNull(modifierGroups.archivedAt))
        .orderBy(asc(modifierGroups.id))
        .for('update');
      break;
    case 'options':
      rows = await db
        .select({
          id: modifierOptions.id,
          sort: modifierOptions.sort,
          version: modifierOptions.version,
          rev: modifierOptions.rev,
        })
        .from(modifierOptions)
        .where(
          and(eq(modifierOptions.groupId, parentId as string), isNull(modifierOptions.archivedAt)),
        )
        .orderBy(asc(modifierOptions.id))
        .for('update');
      break;
  }
  return rows.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
}

// ---------- Costs (read by the editor only) ----------

/** Every item and option cost, archived rows included. Never mapped into an item or option DTO. */
export async function listCosts(db: Db) {
  const items = await db
    .select({ id: menuItems.id, estCostSatang: menuItems.estCostSatang })
    .from(menuItems)
    .orderBy(asc(menuItems.id));
  const options = await db
    .select({ id: modifierOptions.id, costDeltaSatang: modifierOptions.costDeltaSatang })
    .from(modifierOptions)
    .orderBy(asc(modifierOptions.id));
  return { items, options };
}

// ---------- Modifier groups and options ----------

export async function listGroups(
  db: Db,
  options: { includeArchived: boolean },
): Promise<GroupRow[]> {
  const query = db.select().from(modifierGroups);
  return (options.includeArchived ? query : query.where(isNull(modifierGroups.archivedAt))).orderBy(
    asc(modifierGroups.sort),
    asc(modifierGroups.id),
  );
}

export async function findGroups(db: Db, ids: readonly string[]): Promise<GroupRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(modifierGroups)
    .where(inArray(modifierGroups.id, [...ids]));
}

export async function lockGroup(db: Db, id: string): Promise<GroupRow | undefined> {
  const [row] = await db
    .select()
    .from(modifierGroups)
    .where(eq(modifierGroups.id, id))
    .for('update')
    .limit(1);
  return row;
}

export async function findGroupByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<GroupRow | undefined> {
  const [row] = await db
    .select()
    .from(modifierGroups)
    .where(eq(modifierGroups.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

export async function insertGroup(
  db: Db,
  input: {
    nameTh: string;
    nameEn: string | null;
    minSelect: number;
    maxSelect: number;
    sort: number;
  } & RequestKey,
): Promise<GroupRow> {
  const [row] = await db
    .insert(modifierGroups)
    .values(input)
    .onConflictDoNothing({ target: modifierGroups.clientRequestId })
    .returning();
  if (!row) throw new DuplicateClientRequest();
  return row;
}

export async function updateGroupIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<GroupRow, 'nameTh' | 'nameEn' | 'minSelect' | 'maxSelect' | 'sort' | 'archivedAt'>
  >,
): Promise<GroupRow | undefined> {
  const [row] = await db
    .update(modifierGroups)
    .set(patch)
    .where(and(eq(modifierGroups.id, id), eq(modifierGroups.version, expectedVersion)))
    .returning();
  return row;
}

export async function listOptions(
  db: Db,
  groupIds: readonly string[],
  options: { includeArchived: boolean },
): Promise<OptionRow[]> {
  if (groupIds.length === 0) return [];
  const where = options.includeArchived
    ? inArray(modifierOptions.groupId, [...groupIds])
    : and(inArray(modifierOptions.groupId, [...groupIds]), isNull(modifierOptions.archivedAt));
  return db
    .select()
    .from(modifierOptions)
    .where(where)
    .orderBy(asc(modifierOptions.sort), asc(modifierOptions.id));
}

export interface NewOption {
  groupId: string;
  nameTh: string;
  nameEn: string | null;
  priceDeltaSatang: number;
  costDeltaSatang: number;
  isAvailable: boolean;
  sort: number;
}

export async function findOptionByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<OptionRow | undefined> {
  const [row] = await db
    .select()
    .from(modifierOptions)
    .where(eq(modifierOptions.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

/** Throws `DuplicateClientRequest` when a keyed row loses to a request id that already exists. */
export async function insertOptions(
  db: Db,
  rows: readonly (NewOption & RequestKey)[],
): Promise<OptionRow[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(modifierOptions)
    .values([...rows])
    .onConflictDoNothing({ target: modifierOptions.clientRequestId })
    .returning();
  if (inserted.length !== rows.length) throw new DuplicateClientRequest();
  return inserted;
}

export async function lockOption(db: Db, id: string): Promise<OptionRow | undefined> {
  const [row] = await db
    .select()
    .from(modifierOptions)
    .where(eq(modifierOptions.id, id))
    .for('update')
    .limit(1);
  return row;
}

export async function updateOptionIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: Partial<Omit<NewOption, 'groupId'>> & { archivedAt?: Date | null },
): Promise<OptionRow | undefined> {
  const [row] = await db
    .update(modifierOptions)
    .set(patch)
    .where(and(eq(modifierOptions.id, id), eq(modifierOptions.version, expectedVersion)))
    .returning();
  return row;
}

// ---------- The public menu ----------

export interface PublicMenuRows {
  categories: CategoryRow[];
  items: ItemRow[];
  prices: { itemId: string; channel: string; priceSatang: number }[];
  links: { itemId: string; groupId: string }[];
  groups: GroupRow[];
  options: OptionRow[];
}

/**
 * What a customer or a till may order on a channel: active categories, items that are available,
 * not archived and offered on the channel, with their live groups and available options.
 */
export async function loadPublicMenu(db: Db, channel: string): Promise<PublicMenuRows> {
  const categories = await db
    .select()
    .from(menuCategories)
    .where(eq(menuCategories.active, true))
    .orderBy(asc(menuCategories.sort), asc(menuCategories.id));
  const items = await db
    .select()
    .from(menuItems)
    .where(
      and(
        eq(menuItems.isAvailable, true),
        isNull(menuItems.archivedAt),
        sql`${channel} = any(${menuItems.channels})`,
      ),
    )
    .orderBy(asc(menuItems.sort), asc(menuItems.id));
  const itemIds = items.map((i) => i.id);
  const prices =
    itemIds.length === 0
      ? []
      : await db
          .select()
          .from(menuItemChannelPrices)
          .where(
            and(
              inArray(menuItemChannelPrices.itemId, itemIds),
              eq(menuItemChannelPrices.channel, channel),
            ),
          );
  const links =
    itemIds.length === 0
      ? []
      : await db
          .select()
          .from(menuItemModifierGroups)
          .where(inArray(menuItemModifierGroups.itemId, itemIds))
          .orderBy(asc(menuItemModifierGroups.sort), asc(menuItemModifierGroups.groupId));
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groups =
    groupIds.length === 0
      ? []
      : await db
          .select()
          .from(modifierGroups)
          .where(and(inArray(modifierGroups.id, groupIds), isNull(modifierGroups.archivedAt)));
  const options =
    groups.length === 0
      ? []
      : await db
          .select()
          .from(modifierOptions)
          .where(
            and(
              inArray(
                modifierOptions.groupId,
                groups.map((g) => g.id),
              ),
              eq(modifierOptions.isAvailable, true),
              isNull(modifierOptions.archivedAt),
            ),
          )
          .orderBy(asc(modifierOptions.sort), asc(modifierOptions.id));
  return { categories, items, prices, links, groups, options };
}
