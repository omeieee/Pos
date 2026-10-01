/**
 * Whether a menu item can be ordered right now: the rule the server applies in `priceOrder` and in
 * the public menu (`publicMenu`), written once for clients that hold the staff menu rows (which
 * keep sold-out items, unlike the public menu). Pure: no I/O.
 *
 * - the item's category is active, the item is not archived and not sold out;
 * - the item is sold on the channel (a phone order uses the storefront menu);
 * - every attached group that is not archived offers at least `minSelect` options that are not
 *   archived and not sold out. Without that the item would answer GROUP_TOO_FEW to every order.
 *
 * Archived groups are skipped (they cannot be chosen, so they cannot be required). A group the
 * caller does not have yet cannot be checked, so the item is NOT orderable until it arrives: the
 * safe side, because the server would refuse the order anyway.
 */
import type { MenuChannel, OrderChannel } from './enums.ts';
import { menuChannelFor } from './pricing.ts';

export interface OrderableOption {
  isAvailable: boolean;
  archived: boolean;
}

export interface OrderableGroup {
  archived: boolean;
  minSelect: number;
  options: readonly OrderableOption[];
}

export interface OrderableItem {
  isAvailable: boolean;
  archived: boolean;
  channels: readonly MenuChannel[];
  modifierGroupIds: readonly string[];
}

/** The options a customer can pick now: not archived, not sold out. */
export function availableOptions<O extends OrderableOption>(group: { options: readonly O[] }): O[] {
  return group.options.filter((option) => option.isAvailable && !option.archived);
}

/**
 * `groups` holds the modifier groups by id, each with its options (the caller joins options to
 * groups by `groupId`; a group's own embedded copy of its options may be stale).
 */
export function isOrderable(
  item: OrderableItem,
  category: { active: boolean },
  groups: ReadonlyMap<string, OrderableGroup>,
  channel: OrderChannel = 'storefront',
): boolean {
  if (!category.active || item.archived || !item.isAvailable) return false;
  if (!item.channels.includes(menuChannelFor(channel))) return false;
  for (const groupId of item.modifierGroupIds) {
    const group = groups.get(groupId);
    if (!group) return false;
    if (group.archived) continue;
    if (availableOptions(group).length < group.minSelect) return false;
  }
  return true;
}
