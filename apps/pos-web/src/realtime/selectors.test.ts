import { describe, expect, test } from 'vitest';
import { groupFrame, optionFrame, uuid } from '../test-support/frames.ts';
import { createEntityStore } from './entity-store.ts';
import { groupsWithOptions } from './selectors.ts';

describe('groupsWithOptions', () => {
  test('joins options to their group by groupId, in display order', () => {
    const store = createEntityStore();
    store.apply(groupFrame(uuid(1), 5));
    store.apply(optionFrame(uuid(12), uuid(1), 6, { sort: 2, nameTh: 'ข' }));
    store.apply(optionFrame(uuid(11), uuid(1), 7, { sort: 1, nameTh: 'ก' }));
    store.apply(optionFrame(uuid(13), uuid(2), 8));
    const groups = groupsWithOptions(store.getState());
    expect(groups.get(uuid(1))?.options.map((o) => o.id)).toEqual([uuid(11), uuid(12)]);
    expect(groups.get(uuid(2))).toBeUndefined();
  });

  test('uses the option rows, not the group frame copy (a sold-out toggle only touches the option)', () => {
    const store = createEntityStore();
    store.apply(groupFrame(uuid(1), 5, { options: [{ id: uuid(11), rev: 5, isAvailable: true }] }));
    store.apply(optionFrame(uuid(11), uuid(1), 9, { isAvailable: false }));
    expect(groupsWithOptions(store.getState()).get(uuid(1))?.options[0]?.isAvailable).toBe(false);
  });
});
