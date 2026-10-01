/**
 * Menu (02 §6, 03 §3): categories, items, modifier groups and options. Every write is one
 * transaction: lock the row, check `expectedVersion`, write (the sync trigger bumps version and
 * rev), audit with before/after of what changed, publish `menu.upserted` after commit.
 *
 * Prices are integer satang. Estimated costs are accepted and stored but are in no response.
 * Nothing is ever hard-deleted: DELETE archives (or deactivates a category), so past orders keep
 * pointing at a real row and keep the names and prices they were sold with.
 */
import { type Db, insertAudit, menuRepo } from '@sds/db';
import {
  type AvailabilityInput,
  type CategoryDto,
  type CreateCategoryInput,
  type CreateGroupInput,
  type CreateItemInput,
  type CreateOptionInput,
  categoryDtoSchema,
  type GroupDto,
  groupDtoSchema,
  hasPermission,
  type ItemDto,
  itemDtoSchema,
  type MENU_CHANNELS,
  type OptionDto,
  optionDtoSchema,
  type PatchCategoryInput,
  type PatchGroupInput,
  type PatchItemInput,
  type PatchOptionInput,
  type PublicMenuResponse,
  publicMenuResponseSchema,
  type StaffRole,
} from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, forbidden, notFound, versionConflict } from '../errors.ts';
import { type Emit, withTransaction } from '../tx.ts';

type MenuKind = 'category' | 'item' | 'group' | 'option';

const unknownCategory = () => new ApiError(422, 'UNKNOWN_CATEGORY', 'That category does not exist');
const unknownGroup = () =>
  new ApiError(422, 'UNKNOWN_GROUP', 'A modifier group does not exist or has been removed');

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The channel price overrides as a plain channel -> satang record (no undefined entries). */
function priceRecord(prices: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(prices).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

/** Fields whose value differs, as before/after objects for the audit row. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!same(before[key], after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

// ---------- Mapping rows to the API shapes (no cost anywhere) ----------

const toCategory = (r: menuRepo.CategoryRow): CategoryDto =>
  categoryDtoSchema.parse({
    id: r.id,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    sort: r.sort,
    active: r.active,
    version: r.version,
    rev: r.rev,
  });

const toOption = (r: menuRepo.OptionRow): OptionDto =>
  optionDtoSchema.parse({
    id: r.id,
    groupId: r.groupId,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    priceDeltaSatang: r.priceDeltaSatang,
    isAvailable: r.isAvailable,
    sort: r.sort,
    archived: r.archivedAt !== null,
    version: r.version,
    rev: r.rev,
  });

const toGroup = (r: menuRepo.GroupRow, options: readonly menuRepo.OptionRow[]): GroupDto =>
  groupDtoSchema.parse({
    id: r.id,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    minSelect: r.minSelect,
    maxSelect: r.maxSelect,
    sort: r.sort,
    archived: r.archivedAt !== null,
    options: options.map(toOption),
    version: r.version,
    rev: r.rev,
  });

function toItem(r: menuRepo.ItemRow, extras: menuRepo.ItemExtras): ItemDto {
  return itemDtoSchema.parse({
    id: r.id,
    categoryId: r.categoryId,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    descriptionTh: r.descriptionTh,
    descriptionEn: r.descriptionEn,
    priceSatang: r.priceSatang,
    imageUrl: r.imageKey,
    isAvailable: r.isAvailable,
    channels: r.channels,
    channelPrices: extras.channelPrices.get(r.id) ?? {},
    modifierGroupIds: extras.groupIds.get(r.id) ?? [],
    sort: r.sort,
    archived: r.archivedAt !== null,
    version: r.version,
    rev: r.rev,
  });
}

async function itemDto(db: Db, row: menuRepo.ItemRow): Promise<ItemDto> {
  return toItem(row, await menuRepo.loadItemExtras(db, [row.id]));
}

async function groupDto(
  db: Db,
  row: menuRepo.GroupRow,
  includeArchived = false,
): Promise<GroupDto> {
  return toGroup(row, await menuRepo.listOptions(db, [row.id], { includeArchived }));
}

function publish(emit: Emit, kind: MenuKind, id: string, rev: number, data: unknown) {
  emit({ type: 'menu.upserted', kind, id, rev, data });
}

const actorOf = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});

// ---------- Reads ----------

export async function listCategories(ctx: AuthContext) {
  return { categories: (await menuRepo.listCategories(ctx.db)).map(toCategory) };
}

/** Archived rows are for people who can edit the menu. */
function mayIncludeArchived(role: StaffRole, requested: boolean): boolean {
  if (!requested) return false;
  if (!hasPermission(role, 'menu.edit')) throw forbidden();
  return true;
}

export async function listItems(
  ctx: AuthContext,
  actor: Principal,
  includeArchivedRequested: boolean,
) {
  const includeArchived = mayIncludeArchived(actor.role, includeArchivedRequested);
  const rows = await menuRepo.listItems(ctx.db, { includeArchived });
  const extras = await menuRepo.loadItemExtras(
    ctx.db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toItem(r, extras)) };
}

export async function getItem(ctx: AuthContext, id: string): Promise<ItemDto> {
  const row = await menuRepo.findItem(ctx.db, id);
  if (!row) throw notFound('Menu item');
  return itemDto(ctx.db, row);
}

export async function listGroups(
  ctx: AuthContext,
  actor: Principal,
  includeArchivedRequested: boolean,
) {
  const includeArchived = mayIncludeArchived(actor.role, includeArchivedRequested);
  const groups = await menuRepo.listGroups(ctx.db, { includeArchived });
  const options = await menuRepo.listOptions(
    ctx.db,
    groups.map((g) => g.id),
    { includeArchived },
  );
  return {
    groups: groups.map((g) =>
      toGroup(
        g,
        options.filter((o) => o.groupId === g.id),
      ),
    ),
  };
}

/** The public menu: what can be ordered on a channel, at that channel's price. No costs. */
export async function publicMenu(
  ctx: AuthContext,
  channel: (typeof MENU_CHANNELS)[number],
): Promise<PublicMenuResponse> {
  const rows = await menuRepo.loadPublicMenu(ctx.db, channel);
  const priceOf = new Map(rows.prices.map((p) => [p.itemId, p.priceSatang]));
  const groupsById = new Map(rows.groups.map((g) => [g.id, g]));
  const optionsByGroup = new Map<string, menuRepo.OptionRow[]>();
  for (const o of rows.options) {
    const list = optionsByGroup.get(o.groupId) ?? [];
    list.push(o);
    optionsByGroup.set(o.groupId, list);
  }
  const groupIdsByItem = new Map<string, string[]>();
  for (const l of rows.links) {
    const list = groupIdsByItem.get(l.itemId) ?? [];
    list.push(l.groupId);
    groupIdsByItem.set(l.itemId, list);
  }
  return publicMenuResponseSchema.parse({
    channel,
    categories: rows.categories.map((category) => ({
      id: category.id,
      nameTh: category.nameTh,
      nameEn: category.nameEn,
      items: rows.items
        .filter((item) => item.categoryId === category.id)
        .flatMap((item) => {
          const modifierGroups = (groupIdsByItem.get(item.id) ?? []).flatMap((groupId) => {
            const group = groupsById.get(groupId);
            if (!group) return [];
            return [
              {
                id: group.id,
                nameTh: group.nameTh,
                nameEn: group.nameEn,
                minSelect: group.minSelect,
                maxSelect: group.maxSelect,
                options: (optionsByGroup.get(group.id) ?? []).map((o) => ({
                  id: o.id,
                  nameTh: o.nameTh,
                  nameEn: o.nameEn,
                  priceDeltaSatang: o.priceDeltaSatang,
                })),
              },
            ];
          });
          // A required group with fewer available options than it needs (every option sold out)
          // makes the item impossible to order (GROUP_TOO_FEW), so it is not offered.
          if (modifierGroups.some((g) => g.options.length < g.minSelect)) return [];
          return [
            {
              id: item.id,
              nameTh: item.nameTh,
              nameEn: item.nameEn,
              descriptionTh: item.descriptionTh,
              descriptionEn: item.descriptionEn,
              priceSatang: priceOf.get(item.id) ?? item.priceSatang,
              imageUrl: item.imageKey,
              modifierGroups,
            },
          ];
        }),
    })),
  });
}

// ---------- Categories ----------

export async function createCategory(
  ctx: AuthContext,
  actor: Principal,
  input: CreateCategoryInput,
  meta: RequestMeta,
): Promise<CategoryDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.insertCategory(tx, {
      nameTh: input.nameTh,
      nameEn: input.nameEn ?? null,
      sort: input.sort,
    });
    const dto = toCategory(row);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.category_create',
      entity: 'menu_categories',
      entityId: row.id,
      after: { nameTh: row.nameTh, sort: row.sort },
    });
    publish(emit, 'category', row.id, row.rev, dto);
    return dto;
  });
}

export async function patchCategory(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchCategoryInput,
  meta: RequestMeta,
): Promise<CategoryDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockCategory(tx, id);
    if (!row) throw notFound('Category');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);

    const patch: Partial<Pick<menuRepo.CategoryRow, 'nameTh' | 'nameEn' | 'sort' | 'active'>> = {};
    if (input.nameTh !== undefined) patch.nameTh = input.nameTh;
    if (input.nameEn !== undefined) patch.nameEn = input.nameEn;
    if (input.sort !== undefined) patch.sort = input.sort;
    if (input.active !== undefined) patch.active = input.active;
    const change = diff(row as unknown as Record<string, unknown>, patch);
    if (!change.changed) return toCategory(row);

    const updated = await menuRepo.updateCategoryIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.category_update',
      entity: 'menu_categories',
      entityId: id,
      before: change.before,
      after: change.after,
    });
    const dto = toCategory(updated);
    publish(emit, 'category', id, updated.rev, dto);
    return dto;
  });
}

/** Deactivates the category: it and its items leave the menu; nothing is deleted. */
export async function deactivateCategory(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<CategoryDto> {
  const row = await menuRepo.findCategory(ctx.db, id);
  if (!row) throw notFound('Category');
  if (!row.active) return toCategory(row);
  return patchCategory(ctx, actor, id, { expectedVersion: row.version, active: false }, meta);
}

// ---------- Modifier groups and options ----------

export async function createGroup(
  ctx: AuthContext,
  actor: Principal,
  input: CreateGroupInput,
  meta: RequestMeta,
): Promise<GroupDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.insertGroup(tx, {
      nameTh: input.nameTh,
      nameEn: input.nameEn ?? null,
      minSelect: input.minSelect,
      maxSelect: input.maxSelect,
      sort: input.sort,
    });
    const options = await menuRepo.insertOptions(
      tx,
      (input.options ?? []).map((o, index) => ({
        groupId: row.id,
        nameTh: o.nameTh,
        nameEn: o.nameEn ?? null,
        priceDeltaSatang: o.priceDeltaSatang,
        costDeltaSatang: o.costDeltaSatang,
        isAvailable: o.isAvailable,
        sort: o.sort || index + 1,
      })),
    );
    const dto = toGroup(row, options);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.group_create',
      entity: 'modifier_groups',
      entityId: row.id,
      after: {
        nameTh: row.nameTh,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        options: options.length,
      },
    });
    publish(emit, 'group', row.id, row.rev, dto);
    for (const option of options) publish(emit, 'option', option.id, option.rev, toOption(option));
    return dto;
  });
}

export async function patchGroup(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchGroupInput,
  meta: RequestMeta,
): Promise<GroupDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockGroup(tx, id);
    if (!row) throw notFound('Modifier group');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);

    const minSelect = input.minSelect ?? row.minSelect;
    const maxSelect = input.maxSelect ?? row.maxSelect;
    if (minSelect > maxSelect) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The request is not valid', {
        issues: [{ path: 'minSelect', code: 'custom' }],
      });
    }
    const patch: Parameters<typeof menuRepo.updateGroupIfVersion>[3] = {};
    if (input.nameTh !== undefined) patch.nameTh = input.nameTh;
    if (input.nameEn !== undefined) patch.nameEn = input.nameEn;
    if (input.minSelect !== undefined) patch.minSelect = input.minSelect;
    if (input.maxSelect !== undefined) patch.maxSelect = input.maxSelect;
    if (input.sort !== undefined) patch.sort = input.sort;
    if (input.archived !== undefined) patch.archivedAt = input.archived ? ctx.now() : null;

    const view = {
      ...patch,
      archivedAt: undefined,
      ...(input.archived === undefined ? {} : { archived: input.archived }),
    };
    const change = diff(
      { ...(row as unknown as Record<string, unknown>), archived: row.archivedAt !== null },
      view,
    );
    if (!change.changed) return groupDto(tx, row);

    const updated = await menuRepo.updateGroupIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.group_update',
      entity: 'modifier_groups',
      entityId: id,
      before: change.before,
      after: change.after,
    });
    const dto = await groupDto(tx, updated);
    publish(emit, 'group', id, updated.rev, dto);
    return dto;
  });
}

export async function archiveGroup(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<GroupDto> {
  const row = await menuRepo.findGroups(ctx.db, [id]);
  const group = row[0];
  if (!group) throw notFound('Modifier group');
  if (group.archivedAt) return groupDto(ctx.db, group);
  return patchGroup(ctx, actor, id, { expectedVersion: group.version, archived: true }, meta);
}

export async function createOption(
  ctx: AuthContext,
  actor: Principal,
  groupId: string,
  input: CreateOptionInput,
  meta: RequestMeta,
): Promise<OptionDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const group = await menuRepo.lockGroup(tx, groupId);
    if (!group) throw notFound('Modifier group');
    const [row] = await menuRepo.insertOptions(tx, [
      {
        groupId,
        nameTh: input.nameTh,
        nameEn: input.nameEn ?? null,
        priceDeltaSatang: input.priceDeltaSatang,
        costDeltaSatang: input.costDeltaSatang,
        isAvailable: input.isAvailable,
        sort: input.sort,
      },
    ]);
    if (!row) throw new Error('option insert returned no row');
    const dto = toOption(row);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.option_create',
      entity: 'modifier_options',
      entityId: row.id,
      after: { groupId, nameTh: row.nameTh, priceDeltaSatang: row.priceDeltaSatang },
    });
    publish(emit, 'option', row.id, row.rev, dto);
    return dto;
  });
}

async function changeOption(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  expectedVersion: number | undefined,
  patchIn: Omit<PatchOptionInput, 'expectedVersion'>,
  meta: RequestMeta,
  action: string,
): Promise<OptionDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockOption(tx, id);
    if (!row) throw notFound('Modifier option');
    if (expectedVersion !== undefined && row.version !== expectedVersion)
      throw versionConflict(row.version);

    const patch: Parameters<typeof menuRepo.updateOptionIfVersion>[3] = {};
    if (patchIn.nameTh !== undefined) patch.nameTh = patchIn.nameTh;
    if (patchIn.nameEn !== undefined) patch.nameEn = patchIn.nameEn;
    if (patchIn.priceDeltaSatang !== undefined) patch.priceDeltaSatang = patchIn.priceDeltaSatang;
    if (patchIn.costDeltaSatang !== undefined) patch.costDeltaSatang = patchIn.costDeltaSatang;
    if (patchIn.isAvailable !== undefined) patch.isAvailable = patchIn.isAvailable;
    if (patchIn.sort !== undefined) patch.sort = patchIn.sort;
    if (patchIn.archived !== undefined) patch.archivedAt = patchIn.archived ? ctx.now() : null;

    const { archivedAt: _a, ...plain } = patch;
    const change = diff(
      { ...(row as unknown as Record<string, unknown>), archived: row.archivedAt !== null },
      { ...plain, ...(patchIn.archived === undefined ? {} : { archived: patchIn.archived }) },
    );
    if (!change.changed) return toOption(row);

    const updated = await menuRepo.updateOptionIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action,
      entity: 'modifier_options',
      entityId: id,
      before: change.before,
      after: change.after,
    });
    const dto = toOption(updated);
    publish(emit, 'option', id, updated.rev, dto);
    return dto;
  });
}

export const patchOption = (
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchOptionInput,
  meta: RequestMeta,
) => {
  const { expectedVersion, ...rest } = input;
  return changeOption(ctx, actor, id, expectedVersion, rest, meta, 'menu.option_update');
};

export const setOptionAvailability = (
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: AvailabilityInput,
  meta: RequestMeta,
) =>
  changeOption(
    ctx,
    actor,
    id,
    input.expectedVersion,
    { isAvailable: input.isAvailable },
    meta,
    'menu.availability',
  );

export async function archiveOption(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<OptionDto> {
  return changeOption(ctx, actor, id, undefined, { archived: true }, meta, 'menu.option_update');
}

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
