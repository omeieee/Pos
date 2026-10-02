/**
 * Choosing options in the modifier sheet. These are the sheet's tap rules (a radio replaces, a
 * checkbox stops at the maximum). Whether a choice is ACCEPTABLE to order is decided by the shared
 * pricing rules through `checkSelection` (cart-pricing.ts) and finally by the server.
 */
import type { MessageKey, MessageParams } from '@sds/i18n';

export interface SelectableGroup {
  id: string;
  minSelect: number;
  maxSelect: number;
  options: readonly { id: string; available: boolean }[];
}

const chooseOne = (group: SelectableGroup) => group.maxSelect === 1;

/** The new selection of ONE group after a tap on `optionId`. */
export function toggleOption(
  group: SelectableGroup,
  selected: readonly string[],
  optionId: string,
): string[] {
  const option = group.options.find((o) => o.id === optionId);
  if (!option?.available) return [...selected];
  const chosen = selected.includes(optionId);
  if (chooseOne(group)) {
    if (!chosen) return [optionId];
    // A required choice is a radio: tapping it again keeps it.
    return group.minSelect === 0 ? [] : [optionId];
  }
  if (chosen) return selected.filter((id) => id !== optionId);
  if (selected.length >= group.maxSelect) return [...selected];
  return [...selected, optionId];
}

/** An option that cannot be tapped now: sold out, or the maximum is reached and it is not chosen. */
export function isOptionLocked(
  group: SelectableGroup,
  selected: readonly string[],
  optionId: string,
): boolean {
  const option = group.options.find((o) => o.id === optionId);
  if (!option?.available) return true;
  if (chooseOne(group) || selected.includes(optionId)) return false;
  return selected.length >= group.maxSelect;
}

/** Keeps the options of `selected` that the groups still offer, within each group's maximum. */
export function pruneSelection(
  groups: readonly SelectableGroup[],
  selected: readonly string[],
): string[] {
  const kept: string[] = [];
  for (const group of groups) {
    const own = selected.filter((id) => group.options.some((o) => o.id === id && o.available));
    kept.push(...own.slice(0, group.maxSelect));
  }
  return kept;
}

export interface GroupRule {
  key: MessageKey;
  params: MessageParams;
  required: boolean;
}

/** The label that says how many to choose. */
export function groupRule(group: SelectableGroup): GroupRule {
  const { minSelect: min, maxSelect: max } = group;
  if (min >= 1) {
    if (min === max) {
      return min === 1
        ? { key: 'pos.modifier.chooseOne', params: {}, required: true }
        : { key: 'pos.modifier.chooseCount', params: { count: min }, required: true };
    }
    return { key: 'pos.modifier.chooseRange', params: { min, max }, required: true };
  }
  if (max === 1) return { key: 'pos.modifier.optional', params: {}, required: false };
  if (max >= group.options.length) {
    return { key: 'pos.modifier.chooseAny', params: {}, required: false };
  }
  return { key: 'pos.modifier.chooseUpTo', params: { max }, required: false };
}
