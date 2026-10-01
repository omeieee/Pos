/**
 * Prices an order from the menu (CLAUDE.md rule 1): the server loads the menu rows and calls
 * this; a client never sends a price. Pure: no I/O. All amounts are integer satang.
 *
 * Checks that the item and every option can be sold on the channel, that each modifier group's
 * min/max is respected, and returns the lines in the shape saved on the order, with the names,
 * prices and costs copied (03 §1 "Snapshots").
 */
import type { MenuChannel, OrderChannel } from './enums.ts';
import {
  lineTotal,
  type OrderTotals,
  orderTotals,
  type Satang,
  satang,
  sumSatang,
} from './money.ts';

export interface CatalogOption {
  id: string;
  nameTh: string;
  nameEn: string | null;
  priceDeltaSatang: Satang;
  costDeltaSatang: Satang;
  isAvailable: boolean;
  archived: boolean;
}

export interface CatalogGroup {
  id: string;
  nameTh: string;
  nameEn: string | null;
  minSelect: number;
  maxSelect: number;
  archived: boolean;
  options: readonly CatalogOption[];
}

export interface CatalogItem {
  id: string;
  nameTh: string;
  nameEn: string | null;
  priceSatang: Satang;
  estCostSatang: Satang;
  isAvailable: boolean;
  archived: boolean;
  /** False when the item's category is deactivated: the item leaves the menu with it. */
  categoryActive: boolean;
  channels: readonly MenuChannel[];
  /** Price overrides per channel (Grab / LINE MAN). */
  channelPrices: Partial<Record<MenuChannel, Satang>>;
  /** The modifier groups attached to this item. */
  groups: readonly CatalogGroup[];
}

export interface OrderLineInput {
  menuItemId: string;
  qty: number;
  modifierOptionIds: readonly string[];
  note?: string | undefined;
}

export interface PricedModifier {
  groupId: string;
  optionId: string;
  nameTh: string;
  nameEn: string | null;
  priceDeltaSatang: Satang;
  costDeltaSatang: Satang;
}

export interface PricedOrderLine {
  menuItemId: string;
  nameTh: string;
  nameEn: string | null;
  /** Base price on this channel, before modifiers. */
  unitPriceSatang: Satang;
  /** Estimated cost per unit including modifier costs. */
  unitCostSatang: Satang;
  qty: number;
  modifiers: PricedModifier[];
  note: string | null;
  lineTotalSatang: Satang;
}

export type PricingErrorCode =
  | 'UNKNOWN_ITEM'
  | 'ITEM_UNAVAILABLE'
  | 'ITEM_NOT_ON_CHANNEL'
  | 'UNKNOWN_OPTION'
  | 'OPTION_UNAVAILABLE'
  | 'DUPLICATE_OPTION'
  | 'GROUP_TOO_FEW'
  | 'GROUP_TOO_MANY'
  | 'INVALID_PRICE';

export interface PricingError {
  code: PricingErrorCode;
  /** Index of the line in the request. */
  lineIndex: number;
  menuItemId: string;
  groupId?: string;
  optionId?: string;
}

export type PriceResult =
  | { ok: true; lines: PricedOrderLine[]; totals: OrderTotals }
  | { ok: false; errors: PricingError[] };

/** The menu has no "phone" channel: a phone order is rung up with storefront prices and rules. */
export function menuChannelFor(channel: OrderChannel): MenuChannel {
  return channel === 'phone' ? 'storefront' : channel;
}

export function priceOrder(
  channel: OrderChannel,
  lines: readonly OrderLineInput[],
  catalog: ReadonlyMap<string, CatalogItem>,
): PriceResult {
  const menuChannel = menuChannelFor(channel);
  const errors: PricingError[] = [];
  const priced: PricedOrderLine[] = [];
  const unitInputs: { unitPrice: Satang; qty: number; modifierDeltas: Satang[] }[] = [];

  for (const [lineIndex, input] of lines.entries()) {
    const fail = (code: PricingErrorCode, extra: { groupId?: string; optionId?: string } = {}) => {
      errors.push({ code, lineIndex, menuItemId: input.menuItemId, ...extra });
    };

    const item = catalog.get(input.menuItemId);
    if (!item) {
      fail('UNKNOWN_ITEM');
      continue;
    }
    if (item.archived || !item.isAvailable || !item.categoryActive) {
      fail('ITEM_UNAVAILABLE');
      continue;
    }
    if (!item.channels.includes(menuChannel)) {
      fail('ITEM_NOT_ON_CHANNEL');
      continue;
    }

    const options = new Map<string, { group: CatalogGroup; option: CatalogOption }>();
    for (const group of item.groups) {
      for (const option of group.options) options.set(option.id, { group, option });
    }

    const seen = new Set<string>();
    const chosenPerGroup = new Map<string, number>();
    const modifiers: PricedModifier[] = [];
    const errorsBefore = errors.length;
    for (const optionId of input.modifierOptionIds) {
      if (seen.has(optionId)) {
        fail('DUPLICATE_OPTION', { optionId });
        continue;
      }
      seen.add(optionId);
      const found = options.get(optionId);
      if (!found) {
        fail('UNKNOWN_OPTION', { optionId });
        continue;
      }
      const { group, option } = found;
      if (group.archived || option.archived || !option.isAvailable) {
        fail('OPTION_UNAVAILABLE', { groupId: group.id, optionId });
        continue;
      }
      chosenPerGroup.set(group.id, (chosenPerGroup.get(group.id) ?? 0) + 1);
      modifiers.push({
        groupId: group.id,
        optionId: option.id,
        nameTh: option.nameTh,
        nameEn: option.nameEn,
        priceDeltaSatang: option.priceDeltaSatang,
        costDeltaSatang: option.costDeltaSatang,
      });
    }
    for (const group of item.groups) {
      if (group.archived) continue; // cannot be chosen, so it cannot be required
      const count = chosenPerGroup.get(group.id) ?? 0;
      if (count < group.minSelect) fail('GROUP_TOO_FEW', { groupId: group.id });
      if (count > group.maxSelect) fail('GROUP_TOO_MANY', { groupId: group.id });
    }
    if (errors.length > errorsBefore) continue;

    const unitPrice = item.channelPrices[menuChannel] ?? item.priceSatang;
    const modifierDeltas = modifiers.map((m) => m.priceDeltaSatang);
    let total: Satang;
    try {
      total = lineTotal({ unitPrice, qty: input.qty, modifierDeltas });
    } catch (error) {
      if (error instanceof RangeError) {
        fail('INVALID_PRICE');
        continue;
      }
      throw error;
    }
    unitInputs.push({ unitPrice, qty: input.qty, modifierDeltas });
    priced.push({
      menuItemId: item.id,
      nameTh: item.nameTh,
      nameEn: item.nameEn,
      unitPriceSatang: unitPrice,
      unitCostSatang: satang(
        item.estCostSatang + sumSatang(modifiers.map((m) => m.costDeltaSatang)),
      ),
      qty: input.qty,
      modifiers,
      note: input.note ?? null,
      lineTotalSatang: total,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lines: priced, totals: orderTotals(unitInputs) };
}
