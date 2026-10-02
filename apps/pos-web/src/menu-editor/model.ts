/**
 * The menu editor's rules, outside React: what a form's text means (baht to integer satang, exactly),
 * which fields a save sends, and how a row moves in its list. No component does arithmetic on money.
 *
 * What a save sends:
 * - a create sends everything the form has, with empty optional text as null;
 * - a patch sends only what the person changed, with the version they saw (`expectedVersion`);
 * - `channelPrices` is replaced as a whole by the server, so a patch that touches any override sends
 *   the full map built from every price field, and one that touches none omits it;
 * - costs (`estCostSatang`, `costDeltaSatang`) are sent only by roles that can see them
 *   (`withCost`), and on a patch only when the person edited them. A role without `report.view`
 *   never has a cost field, so it can neither read nor overwrite one.
 */
import {
  bahtToSatang,
  type CategoryDto,
  type GroupDto,
  type ItemDto,
  MENU_CHANNELS,
  type MenuChannel,
  type OptionDto,
  satang,
} from '@sds/shared';
import type {
  NewCategoryInput,
  NewGroupInput,
  NewItemInput,
  NewOptionInput,
} from '../api/client.ts';

// ---------- Money text ----------

export type ParsedBaht = { ok: true; satang: number } | { ok: false };

/**
 * Baht as typed ("50", "49.5", "1,250.75") to integer satang, exactly: the digits are read as
 * text, never as a float. `signed` also allows a leading minus or plus (an option can be cheaper).
 */
export function parseBahtText(text: string, options: { signed?: boolean } = {}): ParsedBaht {
  let body = text.trim();
  let sign = 1;
  if (options.signed && (body.startsWith('-') || body.startsWith('+'))) {
    sign = body.startsWith('-') ? -1 : 1;
    body = body.slice(1);
  }
  try {
    const value = bahtToSatang(body);
    return { ok: true, satang: value === 0 ? 0 : sign * value };
  } catch {
    return { ok: false };
  }
}

/** Integer satang as text for an input box: "50", "49.50", "-0.50". */
export function satangToText(value: number): string {
  const abs = Math.abs(value);
  const fraction = abs % 100;
  const whole = (abs - fraction) / 100;
  const body = fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
  return value < 0 ? `-${body}` : body;
}

/** An optional text field: trimmed, empty means "none" (null). */
const nullable = (text: string): string | null => (text.trim() === '' ? null : text.trim());

// ---------- Items ----------

export interface ItemFormValues {
  categoryId: string;
  nameTh: string;
  nameEn: string;
  descriptionTh: string;
  descriptionEn: string;
  price: string;
  /** The estimated cost: only shown to, and sent by, roles that can see costs. */
  cost: string;
  channels: MenuChannel[];
  channelPrices: Record<MenuChannel, string>;
  modifierGroupIds: string[];
}

const NEW_ITEM_CHANNELS: MenuChannel[] = ['storefront', 'line'];

const emptyChannelPrices = (): Record<MenuChannel, string> => ({
  storefront: '',
  line: '',
  grab: '',
  lineman: '',
});

/** The form for a new item (no `item`) or for editing one; `cost` is its cost when the role can see it. */
export function itemFormFrom(
  item: ItemDto | undefined,
  categoryId: string,
  cost: number | null = null,
): ItemFormValues {
  if (!item) {
    return {
      categoryId,
      nameTh: '',
      nameEn: '',
      descriptionTh: '',
      descriptionEn: '',
      price: '',
      cost: '',
      channels: [...NEW_ITEM_CHANNELS],
      channelPrices: emptyChannelPrices(),
      modifierGroupIds: [],
    };
  }
  const prices = emptyChannelPrices();
  for (const channel of MENU_CHANNELS) {
    const own = item.channelPrices[channel];
    if (own !== undefined) prices[channel] = satangToText(own);
  }
  return {
    categoryId: item.categoryId,
    nameTh: item.nameTh,
    nameEn: item.nameEn ?? '',
    descriptionTh: item.descriptionTh ?? '',
    descriptionEn: item.descriptionEn ?? '',
    price: satangToText(item.priceSatang),
    cost: cost === null ? '' : satangToText(cost),
    channels: MENU_CHANNELS.filter((c) => item.channels.includes(c)),
    channelPrices: prices,
    modifierGroupIds: [...item.modifierGroupIds],
  };
}

export type ItemField =
  | 'nameTh'
  | 'price'
  | 'cost'
  | 'channels'
  | 'categoryId'
  | `channelPrice.${MenuChannel}`;

/** The fields that are not acceptable, in screen order; empty means the form can be saved. */
export function validateItemForm(
  form: ItemFormValues,
  options: { withCost: boolean },
): ItemField[] {
  const errors: ItemField[] = [];
  if (form.nameTh.trim() === '' || form.nameTh.trim().length > 80) errors.push('nameTh');
  if (form.categoryId === '') errors.push('categoryId');
  if (!parseBahtText(form.price).ok) errors.push('price');
  if (options.withCost && form.cost.trim() !== '' && !parseBahtText(form.cost).ok) {
    errors.push('cost');
  }
  if (form.channels.length === 0) errors.push('channels');
  for (const channel of MENU_CHANNELS) {
    const text = form.channelPrices[channel];
    if (text.trim() !== '' && !parseBahtText(text).ok) errors.push(`channelPrice.${channel}`);
  }
  return errors;
}

const satangOf = (text: string): number => {
  const parsed = parseBahtText(text);
  if (!parsed.ok) throw new RangeError('the form was not validated');
  return parsed.satang;
};

/** The full override map of a form: every price field that has a value (a switched-off channel keeps its price). */
function priceMap(form: ItemFormValues): Partial<Record<MenuChannel, number>> {
  const map: Partial<Record<MenuChannel, number>> = {};
  for (const channel of MENU_CHANNELS) {
    const text = form.channelPrices[channel];
    if (text.trim() !== '') map[channel] = satangOf(text);
  }
  return map;
}

const inChannelOrder = (channels: readonly MenuChannel[]) =>
  MENU_CHANNELS.filter((c) => channels.includes(c));

/** The create body for a validated form. `sort` puts the new item at the end of its category. */
export function buildItemCreate(
  form: ItemFormValues,
  options: { withCost: boolean; sort: number },
): NewItemInput {
  const prices = priceMap(form);
  return {
    categoryId: form.categoryId,
    nameTh: form.nameTh.trim(),
    nameEn: nullable(form.nameEn),
    descriptionTh: nullable(form.descriptionTh),
    descriptionEn: nullable(form.descriptionEn),
    priceSatang: satang(satangOf(form.price)),
    ...(options.withCost && form.cost.trim() !== ''
      ? { estCostSatang: satang(satangOf(form.cost)) }
      : {}),
    channels: inChannelOrder(form.channels),
    channelPrices: Object.fromEntries(
      Object.entries(prices).map(([channel, value]) => [channel, satang(value)]),
    ),
    modifierGroupIds: form.modifierGroupIds,
    sort: options.sort,
  };
}

export interface ItemPatch {
  expectedVersion: number;
  categoryId?: string;
  nameTh?: string;
  nameEn?: string | null;
  descriptionTh?: string | null;
  descriptionEn?: string | null;
  priceSatang?: ReturnType<typeof satang>;
  estCostSatang?: ReturnType<typeof satang>;
  channels?: MenuChannel[];
  channelPrices?: Partial<Record<MenuChannel, ReturnType<typeof satang>>>;
  modifierGroupIds?: string[];
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The patch for a validated form against the item as it was loaded; null when nothing changed. */
export function buildItemPatch(
  item: ItemDto,
  originalCost: number | null,
  form: ItemFormValues,
  options: { withCost: boolean },
): ItemPatch | null {
  const patch: ItemPatch = { expectedVersion: item.version };
  let changed = false;
  const set = <K extends keyof ItemPatch>(key: K, value: ItemPatch[K]) => {
    patch[key] = value;
    changed = true;
  };

  if (form.categoryId !== item.categoryId) set('categoryId', form.categoryId);
  if (form.nameTh.trim() !== item.nameTh) set('nameTh', form.nameTh.trim());
  if (nullable(form.nameEn) !== item.nameEn) set('nameEn', nullable(form.nameEn));
  if (nullable(form.descriptionTh) !== item.descriptionTh) {
    set('descriptionTh', nullable(form.descriptionTh));
  }
  if (nullable(form.descriptionEn) !== item.descriptionEn) {
    set('descriptionEn', nullable(form.descriptionEn));
  }
  const price = satangOf(form.price);
  if (price !== item.priceSatang) set('priceSatang', satang(price));

  if (options.withCost) {
    // A blank box clears a cost that was known (0); with no known cost it is "not touched".
    const cost = form.cost.trim() !== '' ? satangOf(form.cost) : originalCost === null ? null : 0;
    if (cost !== null && cost !== originalCost) set('estCostSatang', satang(cost));
  }

  const channels = inChannelOrder(form.channels);
  if (!sameList(channels, inChannelOrder(item.channels))) set('channels', channels);

  const wanted = priceMap(form);
  const had = item.channelPrices;
  const samePrices = MENU_CHANNELS.every((channel) => wanted[channel] === had[channel]);
  if (!samePrices) {
    set(
      'channelPrices',
      Object.fromEntries(Object.entries(wanted).map(([channel, v]) => [channel, satang(v)])),
    );
  }

  if (!sameList(form.modifierGroupIds, item.modifierGroupIds)) {
    set('modifierGroupIds', form.modifierGroupIds);
  }
  return changed ? patch : null;
}

// ---------- Categories ----------

export interface CategoryFormValues {
  nameTh: string;
  nameEn: string;
}

export const categoryFormFrom = (
  category?: Pick<CategoryDto, 'nameTh' | 'nameEn'>,
): CategoryFormValues => ({ nameTh: category?.nameTh ?? '', nameEn: category?.nameEn ?? '' });

export function validateCategoryForm(form: CategoryFormValues): 'nameTh'[] {
  return form.nameTh.trim() === '' || form.nameTh.trim().length > 80 ? ['nameTh'] : [];
}

export const buildCategoryCreate = (form: CategoryFormValues, sort: number): NewCategoryInput => ({
  nameTh: form.nameTh.trim(),
  nameEn: nullable(form.nameEn),
  sort,
});

export function buildCategoryPatch(
  category: Pick<CategoryDto, 'nameTh' | 'nameEn' | 'version'>,
  form: CategoryFormValues,
): { expectedVersion: number; nameTh?: string; nameEn?: string | null } | null {
  const patch: { expectedVersion: number; nameTh?: string; nameEn?: string | null } = {
    expectedVersion: category.version,
  };
  if (form.nameTh.trim() !== category.nameTh) patch.nameTh = form.nameTh.trim();
  if (nullable(form.nameEn) !== category.nameEn) patch.nameEn = nullable(form.nameEn);
  return Object.keys(patch).length > 1 ? patch : null;
}

// ---------- Modifier groups ----------

export interface GroupFormValues {
  nameTh: string;
  nameEn: string;
  minSelect: string;
  maxSelect: string;
}

export const groupFormFrom = (
  group?: Pick<GroupDto, 'nameTh' | 'nameEn' | 'minSelect' | 'maxSelect'>,
): GroupFormValues => ({
  nameTh: group?.nameTh ?? '',
  nameEn: group?.nameEn ?? '',
  minSelect: group ? String(group.minSelect) : '0',
  maxSelect: group ? String(group.maxSelect) : '1',
});

export type GroupField = 'nameTh' | 'minSelect' | 'maxSelect';

const wholeNumber = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
};

/** The numbers of a group form, or the fields that are wrong (min up to max, max 1 to 20). */
function groupNumbers(
  form: GroupFormValues,
): { ok: true; min: number; max: number } | { ok: false; errors: GroupField[] } {
  const errors: GroupField[] = [];
  if (form.nameTh.trim() === '' || form.nameTh.trim().length > 80) errors.push('nameTh');
  const min = wholeNumber(form.minSelect, 0, 20);
  const max = wholeNumber(form.maxSelect, 1, 20);
  if (min === null) errors.push('minSelect');
  if (max === null) errors.push('maxSelect');
  if (min !== null && max !== null && min > max) errors.push('minSelect');
  return errors.length > 0 || min === null || max === null
    ? { ok: false, errors }
    : { ok: true, min, max };
}

export function buildGroupCreate(
  form: GroupFormValues,
  sort: number,
): { ok: true; input: NewGroupInput } | { ok: false; errors: GroupField[] } {
  const numbers = groupNumbers(form);
  if (!numbers.ok) return numbers;
  return {
    ok: true,
    input: {
      nameTh: form.nameTh.trim(),
      nameEn: nullable(form.nameEn),
      minSelect: numbers.min,
      maxSelect: numbers.max,
      sort,
    },
  };
}

export interface GroupPatch {
  expectedVersion: number;
  nameTh?: string;
  nameEn?: string | null;
  minSelect?: number;
  maxSelect?: number;
}

export function buildGroupPatch(
  group: Pick<GroupDto, 'nameTh' | 'nameEn' | 'minSelect' | 'maxSelect' | 'version'>,
  form: GroupFormValues,
): { ok: true; input: GroupPatch | null } | { ok: false; errors: GroupField[] } {
  const numbers = groupNumbers(form);
  if (!numbers.ok) return numbers;
  const patch: GroupPatch = { expectedVersion: group.version };
  if (form.nameTh.trim() !== group.nameTh) patch.nameTh = form.nameTh.trim();
  if (nullable(form.nameEn) !== group.nameEn) patch.nameEn = nullable(form.nameEn);
  if (numbers.min !== group.minSelect) patch.minSelect = numbers.min;
  if (numbers.max !== group.maxSelect) patch.maxSelect = numbers.max;
  return { ok: true, input: Object.keys(patch).length > 1 ? patch : null };
}

// ---------- Options ----------

export interface OptionFormValues {
  nameTh: string;
  nameEn: string;
  /** The change to the dish's price, signed baht ("10", "-5"). */
  priceDelta: string;
  /** The change to the estimated cost: only shown to, and sent by, roles that can see costs. */
  costDelta: string;
}

export const optionFormFrom = (
  option?: Pick<OptionDto, 'nameTh' | 'nameEn' | 'priceDeltaSatang'>,
  cost: number | null = null,
): OptionFormValues => ({
  nameTh: option?.nameTh ?? '',
  nameEn: option?.nameEn ?? '',
  priceDelta: option ? satangToText(option.priceDeltaSatang) : '0',
  costDelta: cost === null ? '' : satangToText(cost),
});

export type OptionField = 'nameTh' | 'priceDelta' | 'costDelta';

function optionErrors(form: OptionFormValues, withCost: boolean): OptionField[] {
  const errors: OptionField[] = [];
  if (form.nameTh.trim() === '' || form.nameTh.trim().length > 80) errors.push('nameTh');
  if (!parseBahtText(form.priceDelta, { signed: true }).ok) errors.push('priceDelta');
  if (
    withCost &&
    form.costDelta.trim() !== '' &&
    !parseBahtText(form.costDelta, { signed: true }).ok
  ) {
    errors.push('costDelta');
  }
  return errors;
}

const signedSatang = (text: string): number => {
  const parsed = parseBahtText(text, { signed: true });
  if (!parsed.ok) throw new RangeError('the form was not validated');
  return parsed.satang;
};

export function buildOptionCreate(
  form: OptionFormValues,
  options: { withCost: boolean; sort: number },
): { ok: true; input: NewOptionInput } | { ok: false; errors: OptionField[] } {
  const errors = optionErrors(form, options.withCost);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      nameTh: form.nameTh.trim(),
      nameEn: nullable(form.nameEn),
      priceDeltaSatang: satang(signedSatang(form.priceDelta)),
      ...(options.withCost && form.costDelta.trim() !== ''
        ? { costDeltaSatang: satang(signedSatang(form.costDelta)) }
        : {}),
      sort: options.sort,
    },
  };
}

export interface OptionPatch {
  expectedVersion: number;
  nameTh?: string;
  nameEn?: string | null;
  priceDeltaSatang?: ReturnType<typeof satang>;
  costDeltaSatang?: ReturnType<typeof satang>;
}

export function buildOptionPatch(
  option: Pick<OptionDto, 'nameTh' | 'nameEn' | 'priceDeltaSatang' | 'version'>,
  originalCost: number | null,
  form: OptionFormValues,
  options: { withCost: boolean },
): { ok: true; input: OptionPatch | null } | { ok: false; errors: OptionField[] } {
  const errors = optionErrors(form, options.withCost);
  if (errors.length > 0) return { ok: false, errors };
  const patch: OptionPatch = { expectedVersion: option.version };
  if (form.nameTh.trim() !== option.nameTh) patch.nameTh = form.nameTh.trim();
  if (nullable(form.nameEn) !== option.nameEn) patch.nameEn = nullable(form.nameEn);
  const price = signedSatang(form.priceDelta);
  if (price !== option.priceDeltaSatang) patch.priceDeltaSatang = satang(price);
  if (options.withCost) {
    // A blank box clears a cost change that was known (0); with no known one it is "not touched".
    const cost =
      form.costDelta.trim() !== ''
        ? signedSatang(form.costDelta)
        : originalCost === null
          ? null
          : 0;
    if (cost !== null && cost !== originalCost) patch.costDeltaSatang = satang(cost);
  }
  return { ok: true, input: Object.keys(patch).length > 1 ? patch : null };
}

// ---------- Order of a list ----------

/** The list after moving `id` one step; null when it is already at that end (or not in the list). */
export function moveWithin(
  ids: readonly string[],
  id: string,
  direction: 'up' | 'down',
): string[] | null {
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const moved = next[from];
  const other = next[to];
  if (moved === undefined || other === undefined) return null;
  next[from] = other;
  next[to] = moved;
  return next;
}
