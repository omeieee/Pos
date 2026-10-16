/**
 * Menu: create, change and deactivate categories.
 */
import { insertAudit, menuRepo } from '@sds/db';
import type { CategoryDto, CreateCategoryInput, PatchCategoryInput } from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { notFound, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { toCategory } from './dto.ts';
import { actorOf, type Created, diff, idempotentCreate, publish, requestKey } from './internal.ts';
import { menuRequestHash } from './request-hash.ts';

// ---------- Categories ----------

export async function createCategory(
  ctx: AuthContext,
  actor: Principal,
  input: CreateCategoryInput,
  meta: RequestMeta,
): Promise<Created<CategoryDto>> {
  const hash = menuRequestHash('category', input);
  return idempotentCreate(
    ctx,
    input.clientRequestId,
    hash,
    menuRepo.findCategoryByClientRequestId,
    async (_db, row) => toCategory(row),
    () => insertCategoryOnce(ctx, actor, input, meta, hash),
  );
}

function insertCategoryOnce(
  ctx: AuthContext,
  actor: Principal,
  input: CreateCategoryInput,
  meta: RequestMeta,
  hash: string,
): Promise<CategoryDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.insertCategory(tx, {
      nameTh: input.nameTh,
      nameEn: input.nameEn ?? null,
      sort: input.sort,
      ...requestKey(input.clientRequestId, hash),
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
