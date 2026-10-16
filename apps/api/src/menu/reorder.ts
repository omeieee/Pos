/**
 * Menu: the drag-and-drop order of categories, items, groups and options.
 */
import { type Db, insertAudit, menuRepo } from '@sds/db';
import type { ReorderInput, ReorderResponse } from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { conflict, notFound, versionConflict } from '../errors.ts';
import { type Emit, withTransaction } from '../tx.ts';
import { groupDto, toCategory, toItem, toOption } from './dto.ts';
import { actorOf, publish } from './internal.ts';

// ---------- Reorder ----------

const REORDER_ENTITY = {
  categories: 'menu_categories',
  items: 'menu_items',
  groups: 'modifier_groups',
  options: 'modifier_options',
} as const;

/** Writes one row's new `sort` guarded by its version and queues its event. Undefined when stale. */
async function writeSort(
  tx: Db,
  emit: Emit,
  kind: ReorderInput['kind'],
  id: string,
  version: number,
  sort: number,
  itemExtras: menuRepo.ItemExtras,
): Promise<{ version: number; rev: number } | undefined> {
  switch (kind) {
    case 'categories': {
      const row = await menuRepo.updateCategoryIfVersion(tx, id, version, { sort });
      if (row) publish(emit, 'category', id, row.rev, toCategory(row));
      return row;
    }
    case 'items': {
      const row = await menuRepo.updateItemIfVersion(tx, id, version, { sort });
      if (row) publish(emit, 'item', id, row.rev, toItem(row, itemExtras));
      return row;
    }
    case 'groups': {
      const row = await menuRepo.updateGroupIfVersion(tx, id, version, { sort });
      if (row) publish(emit, 'group', id, row.rev, await groupDto(tx, row));
      return row;
    }
    case 'options': {
      const row = await menuRepo.updateOptionIfVersion(tx, id, version, { sort });
      if (row) publish(emit, 'option', id, row.rev, toOption(row));
      return row;
    }
  }
}

/**
 * Sets `sort` to 0..n-1 for exactly one sibling set, in one transaction. The sent ids must be the
 * whole set (anything else is a 409 REORDER_SET_MISMATCH) and each needs its current version. Only
 * rows whose position changes are written, versioned, published and counted in the one audit row.
 * An order that is already right writes nothing and answers 200, whatever versions came with it:
 * that makes a retry after a lost answer safe.
 */
export async function reorder(
  ctx: AuthContext,
  actor: Principal,
  input: ReorderInput,
  meta: RequestMeta,
): Promise<ReorderResponse> {
  const { kind, parentId } = input;
  return withTransaction(ctx, async (tx, emit) => {
    if (
      kind === 'items' &&
      parentId !== undefined &&
      !(await menuRepo.findCategory(tx, parentId))
    ) {
      throw notFound('Category');
    }
    if (
      kind === 'options' &&
      parentId !== undefined &&
      (await menuRepo.findGroups(tx, [parentId])).length === 0
    ) {
      throw notFound('Modifier group');
    }
    const siblings = await menuRepo.lockSiblings(tx, kind, parentId);
    const current = new Map(siblings.map((s) => [s.id, s]));
    if (siblings.length !== input.order.length || input.order.some((o) => !current.has(o.id))) {
      throw conflict(
        'REORDER_SET_MISMATCH',
        'The list changed on another device. Reload and try again',
      );
    }
    const wanted = input.order.map((o, sort) => ({
      ...o,
      sort,
      was: current.get(o.id) as menuRepo.Sibling,
    }));
    const moved = wanted.filter((w) => w.was.sort !== w.sort);
    const answer = (
      changed: number,
      rows: { id: string; sort: number; version: number; rev: number }[],
    ): ReorderResponse => ({ kind, parentId: parentId ?? null, changed, rows });
    if (moved.length === 0) {
      return answer(
        0,
        wanted.map((w) => ({ id: w.id, sort: w.sort, version: w.was.version, rev: w.was.rev })),
      );
    }
    const stale = wanted.find((w) => w.was.version !== w.expectedVersion);
    if (stale) throw versionConflict(stale.was.version);

    const itemExtras =
      kind === 'items'
        ? await menuRepo.loadItemExtras(
            tx,
            moved.map((w) => w.id),
          )
        : { channelPrices: new Map(), groupIds: new Map() };
    const written = new Map<string, { version: number; rev: number }>();
    for (const w of moved) {
      const row = await writeSort(tx, emit, kind, w.id, w.was.version, w.sort, itemExtras);
      if (!row) throw versionConflict(w.was.version);
      written.set(w.id, row);
    }
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.reorder',
      entity: REORDER_ENTITY[kind],
      before: { kind, parentId: parentId ?? null, order: siblings.map((s) => s.id) },
      after: {
        kind,
        parentId: parentId ?? null,
        order: input.order.map((o) => o.id),
        changed: moved.length,
      },
    });
    return answer(
      moved.length,
      wanted.map((w) => ({
        id: w.id,
        sort: w.sort,
        version: written.get(w.id)?.version ?? w.was.version,
        rev: written.get(w.id)?.rev ?? w.was.rev,
      })),
    );
  });
}
