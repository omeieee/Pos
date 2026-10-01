import { describe, expect, test } from 'vitest';
import {
  availableOptions,
  isOrderable,
  type OrderableGroup,
  type OrderableItem,
} from './orderable.ts';

const item = (over: Partial<OrderableItem> = {}): OrderableItem => ({
  isAvailable: true,
  archived: false,
  channels: ['storefront', 'line'],
  modifierGroupIds: [],
  ...over,
});

const group = (over: Partial<OrderableGroup> = {}): OrderableGroup => ({
  archived: false,
  minSelect: 0,
  options: [
    { isAvailable: true, archived: false },
    { isAvailable: true, archived: false },
  ],
  ...over,
});

const active = { active: true };

describe('isOrderable', () => {
  test('a plain item on an active category is orderable on its channel', () => {
    expect(isOrderable(item(), active, new Map(), 'storefront')).toBe(true);
  });

  test('the channel defaults to the storefront', () => {
    expect(isOrderable(item(), active, new Map())).toBe(true);
    expect(isOrderable(item({ channels: ['line'] }), active, new Map())).toBe(false);
  });

  test('a deactivated category hides its items', () => {
    expect(isOrderable(item(), { active: false }, new Map())).toBe(false);
  });

  test('an archived or sold-out item is not orderable', () => {
    expect(isOrderable(item({ archived: true }), active, new Map())).toBe(false);
    expect(isOrderable(item({ isAvailable: false }), active, new Map())).toBe(false);
  });

  test('the item must be sold on the channel; a phone order uses the storefront menu', () => {
    const lineOnly = item({ channels: ['line'] });
    expect(isOrderable(lineOnly, active, new Map(), 'storefront')).toBe(false);
    expect(isOrderable(lineOnly, active, new Map(), 'line')).toBe(true);
    expect(isOrderable(item(), active, new Map(), 'phone')).toBe(true);
    expect(isOrderable(lineOnly, active, new Map(), 'phone')).toBe(false);
  });

  describe('required modifier groups', () => {
    const withGroups = item({ modifierGroupIds: ['noodle'] });

    test('a required group with enough available options keeps the item orderable', () => {
      const groups = new Map([['noodle', group({ minSelect: 2 })]]);
      expect(isOrderable(withGroups, active, groups)).toBe(true);
    });

    test('a required group with every option sold out makes the item impossible to order', () => {
      const groups = new Map([
        [
          'noodle',
          group({
            minSelect: 1,
            options: [{ isAvailable: false, archived: false }],
          }),
        ],
      ]);
      expect(isOrderable(withGroups, active, groups)).toBe(false);
    });

    test('archived options do not count towards the minimum', () => {
      const groups = new Map([
        [
          'noodle',
          group({
            minSelect: 2,
            options: [
              { isAvailable: true, archived: false },
              { isAvailable: true, archived: true },
            ],
          }),
        ],
      ]);
      expect(isOrderable(withGroups, active, groups)).toBe(false);
    });

    test('an optional group with no options left does not block the item', () => {
      const groups = new Map([['noodle', group({ minSelect: 0, options: [] })]]);
      expect(isOrderable(withGroups, active, groups)).toBe(true);
    });

    test('an archived group cannot be chosen, so it cannot be required', () => {
      const groups = new Map([['noodle', group({ archived: true, minSelect: 1, options: [] })]]);
      expect(isOrderable(withGroups, active, groups)).toBe(true);
    });

    test('a group the store has not received yet is not orderable (it cannot be checked)', () => {
      expect(isOrderable(withGroups, active, new Map())).toBe(false);
    });

    test('every attached group is checked', () => {
      const groups = new Map([
        ['noodle', group({ minSelect: 1 })],
        ['spice', group({ minSelect: 1, options: [] })],
      ]);
      expect(isOrderable(item({ modifierGroupIds: ['noodle', 'spice'] }), active, groups)).toBe(
        false,
      );
    });

    test('a group that is not attached to the item is ignored', () => {
      const groups = new Map([['other', group({ minSelect: 1, options: [] })]]);
      expect(isOrderable(withGroups, active, new Map([...groups, ['noodle', group()]]))).toBe(true);
    });
  });
});

describe('availableOptions', () => {
  test('keeps the options a customer can pick: not archived, not sold out', () => {
    const options = [
      { id: 'a', isAvailable: true, archived: false },
      { id: 'b', isAvailable: false, archived: false },
      { id: 'c', isAvailable: true, archived: true },
    ];
    expect(availableOptions({ options }).map((o) => o.id)).toEqual(['a']);
  });
});
