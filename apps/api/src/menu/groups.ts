/**
 * Menu: modifier groups and their options.
 */
import { insertAudit, menuRepo } from '@sds/db';
import type {
  AvailabilityInput,
  CreateGroupInput,
  CreateOptionInput,
  GroupDto,
  OptionDto,
  PatchGroupInput,
  PatchOptionInput,
} from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, notFound, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { groupDto, toGroup, toOption } from './dto.ts';
import {
  actorOf,
  type Created,
  diff,
  idempotentCreate,
  publish,
  requestKey,
  unknownGroup,
} from './internal.ts';
import { menuRequestHash } from './request-hash.ts';

// ---------- Modifier groups and options ----------

export async function createGroup(
  ctx: AuthContext,
  actor: Principal,
  input: CreateGroupInput,
  meta: RequestMeta,
): Promise<Created<GroupDto>> {
  const hash = menuRequestHash('group', input);
  return idempotentCreate(
    ctx,
    input.clientRequestId,
    hash,
    menuRepo.findGroupByClientRequestId,
    (db, row) => groupDto(db, row),
    () => insertGroupOnce(ctx, actor, input, meta, hash),
  );
}

function insertGroupOnce(
  ctx: AuthContext,
  actor: Principal,
  input: CreateGroupInput,
  meta: RequestMeta,
  hash: string,
): Promise<GroupDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.insertGroup(tx, {
      nameTh: input.nameTh,
      nameEn: input.nameEn ?? null,
      minSelect: input.minSelect,
      maxSelect: input.maxSelect,
      sort: input.sort,
      ...requestKey(input.clientRequestId, hash),
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
): Promise<Created<OptionDto>> {
  const hash = menuRequestHash('option', input, groupId);
  return idempotentCreate(
    ctx,
    input.clientRequestId,
    hash,
    menuRepo.findOptionByClientRequestId,
    async (_db, row) => toOption(row),
    () => insertOptionOnce(ctx, actor, groupId, input, meta, hash),
  );
}

function insertOptionOnce(
  ctx: AuthContext,
  actor: Principal,
  groupId: string,
  input: CreateOptionInput,
  meta: RequestMeta,
  hash: string,
): Promise<OptionDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const group = await menuRepo.lockGroup(tx, groupId);
    if (!group) throw notFound('Modifier group');
    if (group.archivedAt !== null) throw unknownGroup(); // restore the group first
    const [row] = await menuRepo.insertOptions(tx, [
      {
        groupId,
        nameTh: input.nameTh,
        nameEn: input.nameEn ?? null,
        priceDeltaSatang: input.priceDeltaSatang,
        costDeltaSatang: input.costDeltaSatang,
        isAvailable: input.isAvailable,
        sort: input.sort,
        ...requestKey(input.clientRequestId, hash),
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
