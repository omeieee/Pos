/**
 * Menu: reading categories, items, groups, the public menu and costs.
 */
import { menuRepo } from '@sds/db';
import {
  hasPermission,
  type ItemDto,
  type MENU_CHANNELS,
  type MenuCostsResponse,
  menuCostsResponseSchema,
  menuPhotoPath,
  type PublicMenuResponse,
  publicMenuResponseSchema,
  type StaffRole,
} from '@sds/shared';
import type { AuthContext, Principal } from '../auth/service.ts';
import { forbidden, notFound } from '../errors.ts';
import { itemDto, toCategory, toGroup, toItem } from './dto.ts';

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

/** An archived item is the same 404 as an unknown one unless the caller can edit the menu. */
export async function getItem(ctx: AuthContext, actor: Principal, id: string): Promise<ItemDto> {
  const row = await menuRepo.findItem(ctx.db, id);
  if (!row || (row.archivedAt !== null && !hasPermission(actor.role, 'menu.edit'))) {
    throw notFound('Menu item');
  }
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
              photoUrl:
                item.photoVersion === null ? null : menuPhotoPath(item.id, item.photoVersion),
              modifierGroups,
            },
          ];
        }),
    })),
  });
}

/** Costs for the editor (report.view, checked by the route). Not in any DTO. */
export async function listCosts(ctx: AuthContext): Promise<MenuCostsResponse> {
  return menuCostsResponseSchema.parse(await menuRepo.listCosts(ctx.db));
}
