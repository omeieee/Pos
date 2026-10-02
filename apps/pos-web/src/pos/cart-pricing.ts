/**
 * A running ESTIMATE of an order, worked out by the SAME pure pricing function the server uses
 * (`priceOrder` in `@sds/shared`) over the menu rows in the entity store. No price rule lives
 * here: this file only adapts store rows to that function. Costs are not in the staff DTOs, so
 * they are zero here and never leave this file.
 *
 * The estimate can differ from the real total (the menu may change between the tap and the POST),
 * so the screen labels it as an estimate, and after the POST shows the server's total.
 */
import {
  type CatalogGroup,
  type CatalogItem,
  type MenuChannel,
  menuChannelFor,
  type OrderChannel,
  type PricingError,
  priceOrder,
  satang,
  ZERO,
} from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';
import { groupsWithOptions } from '../realtime/selectors.ts';

export interface CartLine {
  /** Local id of the line, stable while the line is edited. */
  key: string;
  itemId: string;
  qty: number;
  /** Chosen modifier options, in any order. */
  optionIds: readonly string[];
  note: string;
}

export interface LineProblem {
  code: PricingError['code'];
  groupId?: string;
}

export interface PricedCartLine {
  key: string;
  ok: boolean;
  /** Base price per unit on the channel, before options. Only when `ok`. */
  unitPriceSatang?: number;
  lineTotalSatang?: number;
  errors: LineProblem[];
}

export interface CartPricing {
  lines: PricedCartLine[];
  /** True when every line can be ordered as it stands. */
  valid: boolean;
  /** Sum of the lines that can be priced. */
  totalSatang: number;
  itemCount: number;
}

function catalogFrom(state: EntityState, channel: MenuChannel): Map<string, CatalogItem> {
  const groups = groupsWithOptions(state);
  const catalog = new Map<string, CatalogItem>();
  for (const item of state.items.values()) {
    const attached: CatalogGroup[] = [];
    for (const id of item.modifierGroupIds) {
      const group = groups.get(id);
      if (!group) continue;
      attached.push({
        id: group.id,
        nameTh: group.nameTh,
        nameEn: group.nameEn,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        archived: group.archived,
        options: group.options.map((o) => ({
          id: o.id,
          nameTh: o.nameTh,
          nameEn: o.nameEn,
          priceDeltaSatang: o.priceDeltaSatang,
          costDeltaSatang: ZERO,
          isAvailable: o.isAvailable,
          archived: o.archived,
        })),
      });
    }
    const channelPrice = item.channelPrices[channel];
    catalog.set(item.id, {
      id: item.id,
      nameTh: item.nameTh,
      nameEn: item.nameEn,
      priceSatang: item.priceSatang,
      estCostSatang: ZERO,
      isAvailable: item.isAvailable,
      archived: item.archived,
      categoryActive: state.categories.get(item.categoryId)?.active ?? false,
      channels: item.channels,
      channelPrices: channelPrice === undefined ? {} : { [channel]: satang(channelPrice) },
      groups: attached,
    });
  }
  return catalog;
}

const problemOf = (error: PricingError): LineProblem =>
  error.groupId === undefined ? { code: error.code } : { code: error.code, groupId: error.groupId };

export function priceCart(
  state: EntityState,
  lines: readonly CartLine[],
  channel: OrderChannel = 'storefront',
): CartPricing {
  const catalog = catalogFrom(state, menuChannelFor(channel));
  const priced: PricedCartLine[] = [];
  let totalSatang = 0;
  let itemCount = 0;
  for (const cartLine of lines) {
    const result = priceOrder(
      channel,
      [{ menuItemId: cartLine.itemId, qty: cartLine.qty, modifierOptionIds: cartLine.optionIds }],
      catalog,
    );
    if (result.ok) {
      const [only] = result.lines;
      priced.push({
        key: cartLine.key,
        ok: true,
        unitPriceSatang: only?.unitPriceSatang ?? 0,
        lineTotalSatang: only?.lineTotalSatang ?? 0,
        errors: [],
      });
      totalSatang += only?.lineTotalSatang ?? 0;
      itemCount += cartLine.qty;
    } else {
      priced.push({ key: cartLine.key, ok: false, errors: result.errors.map(problemOf) });
    }
  }
  return {
    lines: priced,
    valid: priced.every((l) => l.ok),
    totalSatang,
    itemCount,
  };
}

export interface SelectionCheck {
  ok: boolean;
  /** Required groups that still need a choice (GROUP_TOO_FEW), in the order the dish lists them. */
  missingGroupIds: string[];
}

/** Can this dish be added with these choices? The modifier sheet's "add" button asks this. */
export function checkSelection(
  state: EntityState,
  itemId: string,
  optionIds: readonly string[],
  channel: OrderChannel = 'storefront',
): SelectionCheck {
  const [result] = priceCart(
    state,
    [{ key: 'check', itemId, qty: 1, optionIds, note: '' }],
    channel,
  ).lines;
  if (!result || result.ok) return { ok: true, missingGroupIds: [] };
  const missing = result.errors.flatMap((e) =>
    e.code === 'GROUP_TOO_FEW' && e.groupId !== undefined ? [e.groupId] : [],
  );
  const order = state.items.get(itemId)?.modifierGroupIds ?? [];
  missing.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ok: false, missingGroupIds: missing };
}
