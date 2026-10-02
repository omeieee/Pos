/**
 * What the editor lists, from the entity store: the order a person sees is the order the server
 * reorders (`sort`, then id), and "live" rows are the ones a reorder covers (archived rows are not
 * siblings; deactivated categories are, because the server counts every category).
 */
import type { CategoryDto, ItemDto, OptionDto } from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';
import { type GroupWithOptions, groupsWithOptions } from '../realtime/selectors.ts';

export const bySort = (a: { sort: number; id: string }, b: { sort: number; id: string }) =>
  a.sort - b.sort || a.id.localeCompare(b.id);

type Rows = Pick<EntityState, 'categories' | 'items' | 'groups' | 'options'>;

/** Every category (a switched-off one stays in the list), in order. */
export const categoryRows = (state: Rows): CategoryDto[] =>
  [...state.categories.values()].sort(bySort);

export interface Split<T> {
  live: T[];
  archived: T[];
}

function split<T extends { sort: number; id: string }>(
  rows: Iterable<T>,
  isArchived: (row: T) => boolean,
): Split<T> {
  const live: T[] = [];
  const archived: T[] = [];
  for (const row of [...rows].sort(bySort)) (isArchived(row) ? archived : live).push(row);
  return { live, archived };
}

export function itemRowsOf(state: Rows, categoryId: string): Split<ItemDto> {
  return split(
    [...state.items.values()].filter((i) => i.categoryId === categoryId),
    (i) => i.archived,
  );
}

export const groupRows = (state: Rows): Split<GroupWithOptions> =>
  split(groupsWithOptions(state).values(), (g) => g.archived);

export const optionRowsOf = (group: GroupWithOptions): Split<OptionDto> =>
  split(group.options, (o) => o.archived);

/** The `sort` that puts a new row after the live ones. */
export const nextSort = (live: readonly { sort: number }[]): number =>
  live.reduce((max, row) => Math.max(max, row.sort + 1), 0);
