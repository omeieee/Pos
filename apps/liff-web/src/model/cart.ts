/**
 * The cart (pure, no React). It holds what the customer picked and an ESTIMATE of the total from
 * the menu the server sent; the server prices the order again from its own menu when it is placed
 * and its answer is the only amount that counts. Money is integer satang.
 */
import type { AppOrderInput, PublicMenuResponse } from '@sds/shared';

type MenuItem = PublicMenuResponse['categories'][number]['items'][number];
type Group = MenuItem['modifierGroups'][number];

export interface CartLine {
  /** Same item, options and note merge into one line. */
  key: string;
  menuItemId: string;
  qty: number;
  optionIds: string[];
  note: string;
}

export type Cart = readonly CartLine[];

export const MAX_QTY = 99;

const keyOf = (menuItemId: string, optionIds: readonly string[], note: string) =>
  `${menuItemId}|${[...optionIds].sort().join(',')}|${note.trim()}`;

export function addLine(
  cart: Cart,
  line: { menuItemId: string; optionIds: readonly string[]; note?: string; qty: number },
): Cart {
  const note = (line.note ?? '').trim();
  const key = keyOf(line.menuItemId, line.optionIds, note);
  const existing = cart.find((l) => l.key === key);
  if (existing) {
    return cart.map((l) =>
      l.key === key ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l,
    );
  }
  return [
    ...cart,
    {
      key,
      menuItemId: line.menuItemId,
      qty: Math.min(MAX_QTY, line.qty),
      optionIds: [...line.optionIds].sort(),
      note,
    },
  ];
}

/** 0 or less removes the line. */
export function setQty(cart: Cart, key: string, qty: number): Cart {
  if (qty <= 0) return cart.filter((l) => l.key !== key);
  return cart.map((l) => (l.key === key ? { ...l, qty: Math.min(MAX_QTY, qty) } : l));
}

export function itemCount(cart: Cart): number {
  return cart.reduce((sum, l) => sum + l.qty, 0);
}

export function findItem(menu: PublicMenuResponse, id: string): MenuItem | undefined {
  for (const category of menu.categories) {
    const item = category.items.find((i) => i.id === id);
    if (item) return item;
  }
  return undefined;
}

/** One unit of the line at the menu's prices (the base price plus every chosen option). */
export function unitEstimate(item: MenuItem, optionIds: readonly string[]): number {
  const extra = item.modifierGroups
    .flatMap((g) => g.options)
    .filter((o) => optionIds.includes(o.id))
    .reduce((sum, o) => sum + o.priceDeltaSatang, 0);
  return item.priceSatang + extra;
}

/** The estimated total. A line whose item has left the menu counts nothing. */
export function estimateTotal(cart: Cart, menu: PublicMenuResponse): number {
  return cart.reduce((sum, line) => {
    const item = findItem(menu, line.menuItemId);
    return item ? sum + unitEstimate(item, line.optionIds) * line.qty : sum;
  }, 0);
}

/** Lines whose item is no longer on the menu (sold out or removed since they were added). */
export function missingLines(cart: Cart, menu: PublicMenuResponse): CartLine[] {
  return cart.filter((l) => !findItem(menu, l.menuItemId));
}

export type GroupProblem = 'too_few' | 'too_many';

/** Whether the picked options respect each group's minimum and maximum (the server checks again). */
export function groupProblem(group: Group, picked: readonly string[]): GroupProblem | null {
  const count = group.options.filter((o) => picked.includes(o.id)).length;
  if (count < group.minSelect) return 'too_few';
  if (group.maxSelect > 0 && count > group.maxSelect) return 'too_many';
  return null;
}

export const selectionIsValid = (item: MenuItem, picked: readonly string[]): boolean =>
  item.modifierGroups.every((g) => groupProblem(g, picked) === null);

/** The order lines the API takes: ids and quantities only, never a price. */
export function toOrderItems(cart: Cart): AppOrderInput['items'] {
  return cart.map((l) => ({
    menuItemId: l.menuItemId,
    qty: l.qty,
    modifierOptionIds: l.optionIds,
    ...(l.note ? { note: l.note } : {}),
  }));
}
