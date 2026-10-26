/**
 * LINE-02 (pure, no React): what to show when a dish goes หมด while the customer is at checkout,
 * and the cart kept on the phone so closing and reopening the app does not lose it.
 *
 * The server names the failed lines of an ORDER_INVALID by their index in the request, which is
 * the cart's own order (`toOrderItems`). Names come from the menu the customer saw when they
 * pressed the button: a sold-out dish is gone from the refreshed public menu.
 */
import type { PublicMenuResponse } from '@sds/shared';
import { type Cart, type CartLine, findItem, MAX_QTY } from './cart.ts';
import { NOTE_MAX } from './checkout.ts';

/** One failed line as the API names it (`details.errors[]` of a 422 ORDER_INVALID). */
export interface LineProblem {
  code: string;
  lineIndex: number;
  menuItemId: string;
}

/** A cart line that cannot be ordered as it is. `name` is null when it is no longer known. */
export interface UnavailableLine {
  key: string;
  qty: number;
  name: { nameTh: string; nameEn: string | null } | null;
  code: string;
}

/**
 * The lines to show with a remove action: the ones the server refused (named from `menu`, the
 * menu at the time), then any line whose dish is not on `menu` at all, keeping a name already in
 * `known`. One entry per cart line; lines no longer in the cart are dropped.
 */
export function unavailableLines(
  cart: Cart,
  menu: PublicMenuResponse,
  problems: readonly LineProblem[],
  known: readonly UnavailableLine[] = [],
): UnavailableLine[] {
  const out = new Map<string, UnavailableLine>();
  const nameOf = (line: CartLine) => {
    const item = findItem(menu, line.menuItemId);
    if (item) return { nameTh: item.nameTh, nameEn: item.nameEn };
    return known.find((k) => k.key === line.key)?.name ?? null;
  };
  for (const problem of problems) {
    const line = cart[problem.lineIndex];
    if (!line || line.menuItemId !== problem.menuItemId || out.has(line.key)) continue;
    out.set(line.key, { key: line.key, qty: line.qty, name: nameOf(line), code: problem.code });
  }
  for (const k of known) {
    const line = cart.find((l) => l.key === k.key);
    if (line && !out.has(line.key)) out.set(line.key, { ...k, qty: line.qty });
  }
  for (const line of cart) {
    if (out.has(line.key) || findItem(menu, line.menuItemId)) continue;
    out.set(line.key, {
      key: line.key,
      qty: line.qty,
      name: nameOf(line),
      code: 'ITEM_UNAVAILABLE',
    });
  }
  // In the cart's own order.
  return cart.flatMap((l) => {
    const found = out.get(l.key);
    return found ? [found] : [];
  });
}

export function removeLines(cart: Cart, keys: readonly string[]): Cart {
  if (keys.length === 0) return cart;
  return cart.filter((l) => !keys.includes(l.key));
}

// ---------- The cart kept on the phone ----------

/** A cart older than this is not brought back (a dish picked yesterday is not today's order). */
export const CART_MAX_AGE_MS = 12 * 3_600_000;
export const CART_STORAGE_KEY = 'sds.cart';
const VERSION = 1;
const MAX_LINES = 50;

/** Only the cart's own fields: ids, quantities, options and the kitchen note. No price, no person. */
export function serializeCart(cart: Cart, now: Date): string {
  return JSON.stringify({
    v: VERSION,
    savedAt: now.getTime(),
    lines: cart.map((l) => ({
      key: l.key,
      menuItemId: l.menuItemId,
      qty: l.qty,
      optionIds: l.optionIds,
      note: l.note,
    })),
  });
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

function lineOf(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.key !== 'string' || l.key.length > 2_000 || !isId(l.menuItemId)) return null;
  if (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) {
    return null;
  }
  if (!Array.isArray(l.optionIds) || !l.optionIds.every(isId) || l.optionIds.length > 50) {
    return null;
  }
  if (typeof l.note !== 'string' || l.note.length > NOTE_MAX) return null;
  return {
    key: l.key,
    menuItemId: l.menuItemId,
    qty: l.qty,
    optionIds: [...(l.optionIds as string[])],
    note: l.note,
  };
}

/** The stored cart, or an empty one when it is missing, too old, or not exactly what we wrote. */
export function parseStoredCart(raw: string | null, now: Date): Cart {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; lines?: unknown };
    if (value.v !== VERSION || typeof value.savedAt !== 'number') return [];
    const age = now.getTime() - value.savedAt;
    if (age < 0 || age > CART_MAX_AGE_MS) return [];
    if (!Array.isArray(value.lines) || value.lines.length > MAX_LINES) return [];
    const lines = value.lines.map(lineOf);
    return lines.every((l): l is CartLine => l !== null) ? lines : [];
  } catch {
    return [];
  }
}

/** What the cart needs from `localStorage`; a test passes its own. */
export type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage` when this browser lets us use it, else undefined (never throws). */
export function browserStorage(): CartStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredCart(storage: CartStorage | undefined, now: Date): Cart {
  try {
    return parseStoredCart(storage?.getItem(CART_STORAGE_KEY) ?? null, now);
  } catch {
    return [];
  }
}

/** An empty cart removes the stored one. Blocked storage: the cart lasts until the app closes. */
export function storeCart(storage: CartStorage | undefined, cart: Cart, now: Date): void {
  try {
    if (cart.length === 0) storage?.removeItem(CART_STORAGE_KEY);
    else storage?.setItem(CART_STORAGE_KEY, serializeCart(cart, now));
  } catch {
    // Private mode, full or blocked storage: nothing to do.
  }
}
