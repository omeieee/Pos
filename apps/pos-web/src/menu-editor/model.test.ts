import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { groupDto, itemDto, optionDto, uuid } from '../test-support/frames.ts';
import {
  buildCategoryCreate,
  buildCategoryPatch,
  buildGroupCreate,
  buildGroupPatch,
  buildItemCreate,
  buildItemPatch,
  buildOptionCreate,
  buildOptionPatch,
  categoryFormFrom,
  groupFormFrom,
  type ItemFormValues,
  itemFormFrom,
  moveWithin,
  optionFormFrom,
  parseBahtText,
  satangToText,
  validateItemForm,
} from './model.ts';

const CATEGORY = uuid(900);

function blankItem(over: Partial<ItemFormValues> = {}): ItemFormValues {
  return { ...itemFormFrom(undefined, CATEGORY), ...over };
}

describe('parseBahtText: baht typed by a person to integer satang', () => {
  test('whole baht, satang and thousands separators, exactly', () => {
    expect(parseBahtText('50')).toEqual({ ok: true, satang: 5000 });
    expect(parseBahtText('49.5')).toEqual({ ok: true, satang: 4950 });
    expect(parseBahtText('0.05')).toEqual({ ok: true, satang: 5 });
    expect(parseBahtText('1,250.75')).toEqual({ ok: true, satang: 125075 });
    expect(parseBahtText('  120 ')).toEqual({ ok: true, satang: 12000 });
  });

  test('no floating point drift on amounts that are not exact in binary', () => {
    expect(parseBahtText('0.29')).toEqual({ ok: true, satang: 29 });
    expect(parseBahtText('1.15')).toEqual({ ok: true, satang: 115 });
    expect(parseBahtText('4.35')).toEqual({ ok: true, satang: 435 });
  });

  test('refuses text that is not an amount', () => {
    for (const bad of ['', ' ', 'abc', '1.234', '1e3', '12,34', '.5', '5.', '--5', '฿50']) {
      expect(parseBahtText(bad).ok, bad).toBe(false);
    }
  });

  test('a negative amount only where the caller allows it (an option can be cheaper)', () => {
    expect(parseBahtText('-10').ok).toBe(false);
    expect(parseBahtText('-10', { signed: true })).toEqual({ ok: true, satang: -1000 });
    expect(parseBahtText('-0.5', { signed: true })).toEqual({ ok: true, satang: -50 });
    expect(parseBahtText('+5', { signed: true })).toEqual({ ok: true, satang: 500 });
    expect(parseBahtText('-0', { signed: true })).toEqual({ ok: true, satang: 0 });
  });
});

describe('satangToText: the other way, for the input box', () => {
  test('whole baht lose the decimals, satang keep two', () => {
    expect(satangToText(5000)).toBe('50');
    expect(satangToText(4950)).toBe('49.50');
    expect(satangToText(5)).toBe('0.05');
    expect(satangToText(0)).toBe('0');
    expect(satangToText(-1000)).toBe('-10');
    expect(satangToText(-50)).toBe('-0.50');
  });

  test('text -> satang -> text is stable', () => {
    for (const text of ['0', '12', '12.50', '0.05', '99999.99']) {
      const parsed = parseBahtText(text);
      expect(parsed.ok && satangToText(parsed.satang)).toBe(text);
    }
  });
});

describe('item form', () => {
  test('a new item starts in the chosen category, on the storefront and LINE', () => {
    const form = itemFormFrom(undefined, CATEGORY);
    expect(form.categoryId).toBe(CATEGORY);
    expect(form.channels).toEqual(['storefront', 'line']);
    expect(form.price).toBe('');
  });

  test('an item fills the form from its DTO and its cost', () => {
    const item = itemDto(uuid(1), 5, {
      priceSatang: satang(4950),
      channelPrices: { line: satang(5500) },
      channels: ['storefront', 'line', 'grab'],
      modifierGroupIds: [uuid(2)],
    });
    const form = itemFormFrom(item, CATEGORY, satang(1800));
    expect(form).toMatchObject({
      price: '49.50',
      cost: '18',
      channelPrices: { line: '55', grab: '', storefront: '', lineman: '' },
      modifierGroupIds: [uuid(2)],
    });
  });

  test('validation: a name, a price and at least one channel are needed', () => {
    const errors = validateItemForm(blankItem({ nameTh: ' ', price: '', channels: [] }), {
      withCost: false,
    });
    expect(errors).toEqual(expect.arrayContaining(['nameTh', 'price', 'channels']));
  });

  test('validation: a price or override that is not an amount is named', () => {
    const form = blankItem({
      nameTh: 'ต้มยำ',
      price: '50',
      channelPrices: { storefront: '', line: '5x', grab: '', lineman: '' },
    });
    expect(validateItemForm(form, { withCost: false })).toEqual(['channelPrice.line']);
  });

  test('validation: the cost is checked only when the role can see costs', () => {
    const form = blankItem({ nameTh: 'ต้มยำ', price: '50', cost: 'abc' });
    expect(validateItemForm(form, { withCost: false })).toEqual([]);
    expect(validateItemForm(form, { withCost: true })).toEqual(['cost']);
  });
});

describe('buildItemCreate', () => {
  const base = blankItem({
    nameTh: ' ต้มยำ ',
    nameEn: '',
    price: '50',
    cost: '18',
    channelPrices: { storefront: '', line: '55', grab: '60', lineman: '' },
    channels: ['storefront', 'line', 'grab'],
    modifierGroupIds: [uuid(2)],
  });

  test('prices go out as integer satang, empty text as null, and the sort puts it last', () => {
    const input = buildItemCreate(base, { withCost: true, sort: 7 });
    expect(input).toMatchObject({
      categoryId: CATEGORY,
      nameTh: 'ต้มยำ',
      nameEn: null,
      descriptionTh: null,
      descriptionEn: null,
      priceSatang: 5000,
      estCostSatang: 1800,
      channels: ['storefront', 'line', 'grab'],
      channelPrices: { line: 5500, grab: 6000 },
      modifierGroupIds: [uuid(2)],
      sort: 7,
    });
  });

  test('a role without report.view never sends a cost', () => {
    const input = buildItemCreate(base, { withCost: false, sort: 0 });
    expect(Object.hasOwn(input, 'estCostSatang')).toBe(false);
  });

  test('a price typed for a channel that is switched off is kept (it comes back when the channel does)', () => {
    const input = buildItemCreate(blankItem({ ...base, channels: ['storefront'] }), {
      withCost: false,
      sort: 0,
    });
    expect(input.channels).toEqual(['storefront']);
    expect(input.channelPrices).toEqual({ line: 5500, grab: 6000 });
  });

  test('channels are sent in the fixed order, whatever order they were ticked in', () => {
    const input = buildItemCreate(blankItem({ ...base, channels: ['grab', 'storefront'] }), {
      withCost: false,
      sort: 0,
    });
    expect(input.channels).toEqual(['storefront', 'grab']);
  });
});

describe('buildItemPatch: only what changed', () => {
  const item = itemDto(uuid(1), 5, {
    version: 4,
    priceSatang: satang(5000),
    channels: ['storefront', 'line'],
    channelPrices: { line: satang(5500), grab: satang(6000) },
    modifierGroupIds: [uuid(2), uuid(3)],
  });
  const cost = satang(1800);
  const opts = { withCost: true };
  const same = () => itemFormFrom(item, CATEGORY, cost);

  test('nothing edited: no patch at all', () => {
    expect(buildItemPatch(item, cost, same(), opts)).toBeNull();
  });

  test('a new price sends the price and the version, and nothing else', () => {
    const patch = buildItemPatch(item, cost, { ...same(), price: '55.50' }, opts);
    expect(patch).toEqual({ expectedVersion: 4, priceSatang: 5550 });
  });

  test('changing the LINE price keeps the grab price (the map is replaced as a whole)', () => {
    const form = same();
    form.channels = ['storefront', 'line', 'grab'];
    form.channelPrices = { ...form.channelPrices, line: '58' };
    const patch = buildItemPatch(item, cost, form, opts);
    expect(patch?.channelPrices).toEqual({ line: 5800, grab: 6000 });
  });

  test('clearing one price drops only that key', () => {
    const form = same();
    form.channels = ['storefront', 'line', 'grab'];
    form.channelPrices = { ...form.channelPrices, line: '' };
    expect(buildItemPatch(item, cost, form, opts)?.channelPrices).toEqual({ grab: 6000 });
  });

  test('the cost is sent only when it was edited, and never without report.view', () => {
    expect(buildItemPatch(item, cost, { ...same(), cost: '20' }, opts)).toEqual({
      expectedVersion: 4,
      estCostSatang: 2000,
    });
    // The same edit by a role that cannot see costs: there is no cost field, so nothing is sent.
    const blind = itemFormFrom(item, CATEGORY, null);
    expect(buildItemPatch(item, null, { ...blind, cost: '20' }, { withCost: false })).toBeNull();
  });

  test('group order matters; an unchanged list is not sent', () => {
    expect(
      buildItemPatch(item, cost, { ...same(), modifierGroupIds: [uuid(3), uuid(2)] }, opts),
    ).toEqual({ expectedVersion: 4, modifierGroupIds: [uuid(3), uuid(2)] });
  });

  test('clearing the English name sends null', () => {
    expect(buildItemPatch(item, cost, { ...same(), nameEn: '' }, opts)).toEqual({
      expectedVersion: 4,
      nameEn: null,
    });
  });

  test('moving to another category and turning channels off', () => {
    const patch = buildItemPatch(
      item,
      cost,
      { ...same(), categoryId: uuid(901), channels: ['storefront'] },
      opts,
    );
    // the prices of the channels that are now off stay as they were: not sent
    expect(patch).toEqual({
      expectedVersion: 4,
      categoryId: uuid(901),
      channels: ['storefront'],
    });
  });
});

describe('categories', () => {
  test('create and patch', () => {
    expect(buildCategoryCreate({ nameTh: ' ของหวาน ', nameEn: '' }, 3)).toEqual({
      nameTh: 'ของหวาน',
      nameEn: null,
      sort: 3,
    });
    const category = { id: uuid(5), nameTh: 'ก๋วยเตี๋ยว', nameEn: 'Noodles', version: 6 };
    expect(buildCategoryPatch(category, categoryFormFrom(category))).toBeNull();
    expect(buildCategoryPatch(category, { nameTh: 'เส้น', nameEn: 'Noodles' })).toEqual({
      expectedVersion: 6,
      nameTh: 'เส้น',
    });
  });
});

describe('modifier groups', () => {
  const group = groupDto(uuid(7), 3, { minSelect: 1, maxSelect: 2, version: 2 });

  test('create: numbers come from text, and min may not exceed max', () => {
    expect(
      buildGroupCreate({ nameTh: 'เส้น', nameEn: '', minSelect: '1', maxSelect: '2' }, 4),
    ).toEqual({
      ok: true,
      input: { nameTh: 'เส้น', nameEn: null, minSelect: 1, maxSelect: 2, sort: 4 },
    });
    expect(
      buildGroupCreate({ nameTh: 'เส้น', nameEn: '', minSelect: '3', maxSelect: '2' }, 4),
    ).toMatchObject({ ok: false, errors: ['minSelect'] });
    expect(
      buildGroupCreate({ nameTh: 'เส้น', nameEn: '', minSelect: '0', maxSelect: '0' }, 4),
    ).toMatchObject({ ok: false, errors: ['maxSelect'] });
    expect(
      buildGroupCreate({ nameTh: '', nameEn: '', minSelect: 'x', maxSelect: '1' }, 4),
    ).toMatchObject({ ok: false, errors: ['nameTh', 'minSelect'] });
  });

  test('patch sends only what changed with the version', () => {
    const form = groupFormFrom(group);
    expect(buildGroupPatch(group, form)).toEqual({ ok: true, input: null });
    expect(buildGroupPatch(group, { ...form, maxSelect: '3' })).toEqual({
      ok: true,
      input: { expectedVersion: 2, maxSelect: 3 },
    });
  });
});

describe('options: the price change is signed money', () => {
  const option = optionDto(uuid(8), uuid(7), 4, { priceDeltaSatang: satang(1000), version: 3 });

  test('create with a signed price and a cost only for roles that see costs', () => {
    const form = { nameTh: 'ไข่', nameEn: '', priceDelta: '-5', costDelta: '2' };
    expect(buildOptionCreate(form, { withCost: true, sort: 2 })).toEqual({
      ok: true,
      input: {
        nameTh: 'ไข่',
        nameEn: null,
        priceDeltaSatang: -500,
        costDeltaSatang: 200,
        sort: 2,
      },
    });
    const blind = buildOptionCreate(form, { withCost: false, sort: 2 });
    expect(blind.ok && Object.hasOwn(blind.input, 'costDeltaSatang')).toBe(false);
  });

  test('a price that is not an amount is named and nothing is built', () => {
    expect(
      buildOptionCreate(
        { nameTh: 'ไข่', nameEn: '', priceDelta: '1.234', costDelta: '' },
        { withCost: true, sort: 0 },
      ),
    ).toMatchObject({ ok: false, errors: ['priceDelta'] });
  });

  test('patch: unchanged is nothing, a new price is satang, a cost only when edited', () => {
    const form = optionFormFrom(option, satang(300));
    expect(buildOptionPatch(option, satang(300), form, { withCost: true })).toEqual({
      ok: true,
      input: null,
    });
    expect(
      buildOptionPatch(option, satang(300), { ...form, priceDelta: '15' }, { withCost: true }),
    ).toEqual({ ok: true, input: { expectedVersion: 3, priceDeltaSatang: 1500 } });
    expect(
      buildOptionPatch(option, satang(300), { ...form, costDelta: '4' }, { withCost: true }),
    ).toEqual({ ok: true, input: { expectedVersion: 3, costDeltaSatang: 400 } });
  });
});

describe('moveWithin', () => {
  test('swaps with the neighbour, and does nothing at the ends', () => {
    expect(moveWithin(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveWithin(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveWithin(['a', 'b', 'c'], 'a', 'up')).toBeNull();
    expect(moveWithin(['a', 'b', 'c'], 'c', 'down')).toBeNull();
    expect(moveWithin(['a', 'b', 'c'], 'z', 'up')).toBeNull();
  });
});
