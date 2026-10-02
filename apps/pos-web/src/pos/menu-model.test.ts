import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { itemFrame, optionFrame, uuid } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import { buildMenu, findItem, matchesSearch } from './menu-model.ts';

function menu() {
  const store = createEntityStore();
  seedMenu(store);
  return { store, categories: buildMenu(store.getState()) };
}

describe('buildMenu (the POS menu from the entity store)', () => {
  test('lists active categories in display order, and hides a deactivated one with its items', () => {
    const { categories } = menu();
    expect(categories.map((c) => c.id)).toEqual([MENU.catNoodle, MENU.catDrink]);
    const ids = categories.flatMap((c) => c.items.map((i) => i.id));
    expect(ids).not.toContain(MENU.secret);
  });

  test('keeps sold-out dishes in place, marked not orderable, so the grid does not shift', () => {
    const { categories } = menu();
    const noodles = categories[0]?.items ?? [];
    expect(noodles.map((i) => i.id)).toEqual([MENU.tomYum, MENU.seafood, MENU.boat]);
    expect(noodles.find((i) => i.id === MENU.seafood)).toMatchObject({
      orderable: false,
      soldOut: true,
    });
    expect(noodles.find((i) => i.id === MENU.tomYum)).toMatchObject({
      orderable: true,
      soldOut: false,
    });
  });

  test('a dish whose required group has no option left shows as sold out too', () => {
    const { categories } = menu();
    expect(categories[0]?.items.find((i) => i.id === MENU.boat)).toMatchObject({
      orderable: false,
      soldOut: true,
    });
  });

  test('only dishes sold on the channel appear', () => {
    const { categories } = menu();
    const drinks = categories[1]?.items.map((i) => i.id);
    expect(drinks).toEqual([MENU.tea, MENU.water]);
  });

  test('the price is the channel price when there is an override', () => {
    const { store } = menu();
    const storefront = buildMenu(store.getState(), 'storefront');
    const line = buildMenu(store.getState(), 'line');
    expect(findItem(storefront, MENU.water)?.priceSatang).toBe(2000);
    expect(findItem(line, MENU.water)?.priceSatang).toBe(2500);
  });

  test('groups come with their options in order, flagged by availability, archived ones left out', () => {
    const { store } = menu();
    store.apply(optionFrame(MENU.egg, MENU.gExtra, 900, { isAvailable: false }));
    store.apply(optionFrame(uuid(499), MENU.gExtra, 901, { archived: true }));
    const item = findItem(buildMenu(store.getState()), MENU.tomYum);
    expect(item?.groups.map((g) => g.id)).toEqual([MENU.gNoodle, MENU.gSpice, MENU.gExtra]);
    const extras = item?.groups[2];
    expect(extras?.options.map((o) => [o.id, o.available])).toEqual([
      [MENU.egg, false],
      [MENU.meatball, true],
      [MENU.special, true],
    ]);
    expect(extras).toMatchObject({ required: false, minSelect: 0, maxSelect: 2 });
    expect(item?.groups[0]).toMatchObject({ required: true, minSelect: 1, maxSelect: 1 });
  });

  test('a sold-out toggle on one option reaches the menu without a new group frame', () => {
    const { store } = menu();
    store.apply(optionFrame(MENU.thin, MENU.gNoodle, 950, { isAvailable: false }));
    store.apply(optionFrame(MENU.wide, MENU.gNoodle, 951, { isAvailable: false }));
    expect(findItem(buildMenu(store.getState()), MENU.tomYum)?.orderable).toBe(false);
  });

  test('a new dish in the feed appears', () => {
    const { store } = menu();
    store.apply(
      itemFrame(uuid(777), 990, { categoryId: MENU.catDrink, nameTh: 'โอเลี้ยง', sort: 9 }),
    );
    expect(findItem(buildMenu(store.getState()), uuid(777))?.nameTh).toBe('โอเลี้ยง');
  });

  test('an empty store gives an empty menu', () => {
    expect(buildMenu(createEntityStore().getState())).toEqual([]);
  });
});

describe('matchesSearch', () => {
  const { categories } = menu();
  const tomYum = findItem(categories, MENU.tomYum);

  test('matches the Thai or the English name, ignoring case and spaces at the ends', () => {
    expect(tomYum && matchesSearch(tomYum, 'ต้มยำ')).toBe(true);
    expect(tomYum && matchesSearch(tomYum, ' TOM yum ')).toBe(true);
    expect(tomYum && matchesSearch(tomYum, 'ชาเย็น')).toBe(false);
  });

  test('an empty search matches everything', () => {
    expect(tomYum && matchesSearch(tomYum, '   ')).toBe(true);
  });
});
