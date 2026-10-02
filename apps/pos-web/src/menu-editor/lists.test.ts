import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { itemFrame, uuid } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import { categoryRows, groupRows, itemRowsOf, nextSort, optionRowsOf } from './lists.ts';

function seeded() {
  const store = createEntityStore();
  seedMenu(store);
  return store.getState();
}

describe('editor lists', () => {
  test('categories are all there (a switched-off one too), in order', () => {
    expect(categoryRows(seeded()).map((c) => c.id)).toEqual([
      MENU.catNoodle,
      MENU.catDrink,
      MENU.catHidden,
    ]);
  });

  test('items of a category are in sort order, archived ones set apart', () => {
    const store = createEntityStore();
    seedMenu(store);
    store.apply(itemFrame(uuid(950), 5000, { categoryId: MENU.catDrink, sort: 0, archived: true }));
    const { live, archived } = itemRowsOf(store.getState(), MENU.catDrink);
    expect(live.map((i) => i.id)).toEqual([MENU.tea, MENU.water, MENU.lineOnly]);
    expect(archived.map((i) => i.id)).toEqual([uuid(950)]);
  });

  test('groups carry their options, split the same way', () => {
    const { live } = groupRows(seeded());
    expect(live.map((g) => g.id)).toContain(MENU.gExtra);
    const extras = live.find((g) => g.id === MENU.gExtra);
    expect(extras && optionRowsOf(extras).live.map((o) => o.id)).toEqual([
      MENU.egg,
      MENU.meatball,
      MENU.special,
    ]);
  });

  test('a new row goes after the last live one', () => {
    expect(nextSort([])).toBe(0);
    expect(nextSort([{ sort: 0 }, { sort: 4 }, { sort: 2 }])).toBe(5);
  });
});
