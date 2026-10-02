/**
 * The POS menu, built from the entity store (the staff DTOs that arrive through sync), not from
 * `GET /v1/menu`: the public menu leaves sold-out dishes out, but the till keeps them in place
 * (dimmed, "หมด") so the grid does not move under a cashier's thumb.
 *
 * Which dishes can be ordered is the shared rule (`isOrderable`), the same one the server applies.
 * Options are joined to groups from the option rows themselves (`groupsWithOptions`).
 */
import {
  availableOptions,
  isOrderable,
  type MenuChannel,
  menuChannelFor,
  type OrderChannel,
} from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';
import { groupsWithOptions } from '../realtime/selectors.ts';

export interface MenuOptionView {
  id: string;
  nameTh: string;
  nameEn: string | null;
  priceDeltaSatang: number;
  /** False: sold out (shown dimmed, not selectable). */
  available: boolean;
}

export interface MenuGroupView {
  id: string;
  nameTh: string;
  nameEn: string | null;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  options: MenuOptionView[];
}

export interface MenuItemView {
  id: string;
  categoryId: string;
  nameTh: string;
  nameEn: string | null;
  /** The price on the channel: its override if there is one, else the base price. */
  priceSatang: number;
  imageUrl: string | null;
  orderable: boolean;
  /** Shown but not orderable: sold out, or a required group with nothing left to pick. */
  soldOut: boolean;
  groups: MenuGroupView[];
}

export interface MenuCategoryView {
  id: string;
  nameTh: string;
  nameEn: string | null;
  items: MenuItemView[];
}

const bySort = (a: { sort: number; id: string }, b: { sort: number; id: string }) =>
  a.sort - b.sort || a.id.localeCompare(b.id);

export function buildMenu(
  state: EntityState,
  channel: OrderChannel = 'storefront',
): MenuCategoryView[] {
  const menuChannel: MenuChannel = menuChannelFor(channel);
  const groups = groupsWithOptions(state);
  const categories = [...state.categories.values()].filter((c) => c.active).sort(bySort);
  const itemsByCategory = new Map<string, MenuItemView[]>();

  for (const item of [...state.items.values()].sort(bySort)) {
    if (item.archived || !item.channels.includes(menuChannel)) continue;
    const category = state.categories.get(item.categoryId);
    if (!category?.active) continue;
    const orderable = isOrderable(item, category, groups, channel);
    const views: MenuGroupView[] = [];
    for (const id of item.modifierGroupIds) {
      const group = groups.get(id);
      if (!group || group.archived) continue;
      views.push({
        id: group.id,
        nameTh: group.nameTh,
        nameEn: group.nameEn,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        required: group.minSelect > 0,
        options: group.options
          .filter((o) => !o.archived)
          .map((o) => ({
            id: o.id,
            nameTh: o.nameTh,
            nameEn: o.nameEn,
            priceDeltaSatang: o.priceDeltaSatang,
            available: availableOptions({ options: [o] }).length === 1,
          })),
      });
    }
    const list = itemsByCategory.get(item.categoryId) ?? [];
    list.push({
      id: item.id,
      categoryId: item.categoryId,
      nameTh: item.nameTh,
      nameEn: item.nameEn,
      priceSatang: item.channelPrices[menuChannel] ?? item.priceSatang,
      imageUrl: item.imageUrl,
      orderable,
      soldOut: !orderable,
      groups: views,
    });
    itemsByCategory.set(item.categoryId, list);
  }

  return categories.map((c) => ({
    id: c.id,
    nameTh: c.nameTh,
    nameEn: c.nameEn,
    items: itemsByCategory.get(c.id) ?? [],
  }));
}

export function findItem(
  menu: readonly MenuCategoryView[],
  itemId: string,
): MenuItemView | undefined {
  for (const category of menu) {
    const found = category.items.find((i) => i.id === itemId);
    if (found) return found;
  }
  return undefined;
}

/** The text of a dish name search: either language, case-insensitive. */
export function matchesSearch(
  item: Pick<MenuItemView, 'nameTh' | 'nameEn'>,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return (
    item.nameTh.toLocaleLowerCase().includes(needle) ||
    (item.nameEn?.toLocaleLowerCase().includes(needle) ?? false)
  );
}
