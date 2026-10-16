/**
 * Menu: items (create, change, archive, sold out).
 */
import { type Db, insertAudit, menuRepo } from '@sds/db';
import type { AvailabilityInput, CreateItemInput, ItemDto, PatchItemInput } from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { notFound, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { itemDto, toItem } from './dto.ts';
import {
  actorOf,
  type Created,
  diff,
  idempotentCreate,
  priceRecord,
  publish,
  requestKey,
  unknownCategory,
  unknownGroup,
} from './internal.ts';
import { menuRequestHash } from './request-hash.ts';

// ---------- Items ----------

async function assertCategory(tx: Db, id: string) {
  if (!(await menuRepo.findCategory(tx, id))) throw unknownCategory();
}

async function assertGroups(tx: Db, ids: readonly string[]) {
  if (ids.length === 0) return;
  const found = await menuRepo.findGroups(tx, ids);
  if (found.length !== ids.length || found.some((g) => g.archivedAt !== null)) throw unknownGroup();
}

const itemAuditView = (row: menuRepo.ItemRow, extras: menuRepo.ItemExtras) => ({
  categoryId: row.categoryId,
  nameTh: row.nameTh,
  nameEn: row.nameEn,
  descriptionTh: row.descriptionTh,
  descriptionEn: row.descriptionEn,
  priceSatang: row.priceSatang,
  estCostSatang: row.estCostSatang,
  imageUrl: row.imageKey,
  channels: row.channels,
  channelPrices: extras.channelPrices.get(row.id) ?? {},
  modifierGroupIds: extras.groupIds.get(row.id) ?? [],
  sort: row.sort,
  isAvailable: row.isAvailable,
  archived: row.archivedAt !== null,
});

export async function createItem(
  ctx: AuthContext,
  actor: Principal,
  input: CreateItemInput,
  meta: RequestMeta,
): Promise<Created<ItemDto>> {
  const hash = menuRequestHash('item', input);
  return idempotentCreate(
    ctx,
    input.clientRequestId,
    hash,
    menuRepo.findItemByClientRequestId,
    (db, row) => itemDto(db, row),
    () => insertItemOnce(ctx, actor, input, meta, hash),
  );
}

function insertItemOnce(
  ctx: AuthContext,
  actor: Principal,
  input: CreateItemInput,
  meta: RequestMeta,
  hash: string,
): Promise<ItemDto> {
  return withTransaction(ctx, async (tx, emit) => {
    await assertCategory(tx, input.categoryId);
    await assertGroups(tx, input.modifierGroupIds ?? []);
    const row = await menuRepo.insertItem(tx, {
      categoryId: input.categoryId,
      nameTh: input.nameTh,
      nameEn: input.nameEn ?? null,
      descriptionTh: input.descriptionTh ?? null,
      descriptionEn: input.descriptionEn ?? null,
      priceSatang: input.priceSatang,
      estCostSatang: input.estCostSatang,
      imageKey: input.imageUrl ?? null,
      channels: input.channels,
      sort: input.sort,
      isAvailable: input.isAvailable,
      ...requestKey(input.clientRequestId, hash),
    });
    await menuRepo.replaceItemChannelPrices(tx, row.id, priceRecord(input.channelPrices ?? {}));
    await menuRepo.replaceItemGroups(tx, row.id, input.modifierGroupIds ?? []);
    const dto = await itemDto(tx, row);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.item_create',
      entity: 'menu_items',
      entityId: row.id,
      after: itemAuditView(row, await menuRepo.loadItemExtras(tx, [row.id])),
    });
    publish(emit, 'item', row.id, row.rev, dto);
    return dto;
  });
}

export async function patchItem(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchItemInput,
  meta: RequestMeta,
): Promise<ItemDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockItem(tx, id);
    if (!row) throw notFound('Menu item');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    const extras = await menuRepo.loadItemExtras(tx, [id]);
    const was = itemAuditView(row, extras);

    if (input.categoryId !== undefined && input.categoryId !== row.categoryId) {
      await assertCategory(tx, input.categoryId);
    }
    if (input.modifierGroupIds !== undefined) await assertGroups(tx, input.modifierGroupIds);

    const wants = {
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}),
      ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
      ...(input.descriptionTh !== undefined ? { descriptionTh: input.descriptionTh } : {}),
      ...(input.descriptionEn !== undefined ? { descriptionEn: input.descriptionEn } : {}),
      ...(input.priceSatang !== undefined ? { priceSatang: input.priceSatang } : {}),
      ...(input.estCostSatang !== undefined ? { estCostSatang: input.estCostSatang } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.channelPrices !== undefined
        ? { channelPrices: priceRecord(input.channelPrices) }
        : {}),
      ...(input.modifierGroupIds !== undefined ? { modifierGroupIds: input.modifierGroupIds } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    };
    const change = diff(was, wants);
    if (!change.changed) return toItem(row, extras);

    const patch: menuRepo.ItemPatch = { updatedAt: ctx.now() }; // always touches the row: links alone count as a change
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.nameTh !== undefined) patch.nameTh = input.nameTh;
    if (input.nameEn !== undefined) patch.nameEn = input.nameEn;
    if (input.descriptionTh !== undefined) patch.descriptionTh = input.descriptionTh;
    if (input.descriptionEn !== undefined) patch.descriptionEn = input.descriptionEn;
    if (input.priceSatang !== undefined) patch.priceSatang = input.priceSatang;
    if (input.estCostSatang !== undefined) patch.estCostSatang = input.estCostSatang;
    if (input.imageUrl !== undefined) patch.imageKey = input.imageUrl;
    if (input.channels !== undefined) patch.channels = input.channels;
    if (input.sort !== undefined) patch.sort = input.sort;
    if (input.isAvailable !== undefined) patch.isAvailable = input.isAvailable;
    if (input.archived !== undefined) patch.archivedAt = input.archived ? ctx.now() : null;

    const updated = await menuRepo.updateItemIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version);
    if (input.channelPrices !== undefined) {
      await menuRepo.replaceItemChannelPrices(tx, id, priceRecord(input.channelPrices));
    }
    if (input.modifierGroupIds !== undefined)
      await menuRepo.replaceItemGroups(tx, id, input.modifierGroupIds);

    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.item_update',
      entity: 'menu_items',
      entityId: id,
      before: change.before,
      after: change.after,
    });
    const dto = await itemDto(tx, updated);
    publish(emit, 'item', id, updated.rev, dto);
    return dto;
  });
}

/** Soft delete: the item leaves the menu and cannot be sold, its row stays for past orders. */
export async function archiveItem(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<ItemDto> {
  const row = await menuRepo.findItem(ctx.db, id);
  if (!row) throw notFound('Menu item');
  if (row.archivedAt) return itemDto(ctx.db, row);
  return patchItem(ctx, actor, id, { expectedVersion: row.version, archived: true }, meta);
}

/** The "sold out" toggle (หมด). The target state is explicit, so a version is optional. */
export async function setItemAvailability(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: AvailabilityInput,
  meta: RequestMeta,
): Promise<ItemDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockItem(tx, id);
    if (!row) throw notFound('Menu item');
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw versionConflict(row.version);
    }
    if (row.isAvailable === input.isAvailable) return itemDto(tx, row);

    const updated = await menuRepo.updateItemIfVersion(tx, id, row.version, {
      isAvailable: input.isAvailable,
    });
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.availability',
      entity: 'menu_items',
      entityId: id,
      before: { isAvailable: row.isAvailable },
      after: { isAvailable: input.isAvailable },
    });
    const dto = await itemDto(tx, updated);
    publish(emit, 'item', id, updated.rev, dto);
    return dto;
  });
}
