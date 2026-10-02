import { describe, expect, test } from 'vitest';
import { groupRule, isOptionLocked, pruneSelection, toggleOption } from './selection.ts';

const opt = (id: string, available = true) => ({ id, available });
const group = (min: number, max: number, ids = ['a', 'b', 'c']) => ({
  id: 'g',
  minSelect: min,
  maxSelect: max,
  options: ids.map((id) => opt(id)),
});

describe('toggleOption in a choose-one group', () => {
  test('choosing another option replaces the choice', () => {
    expect(toggleOption(group(1, 1), ['a'], 'b')).toEqual(['b']);
  });

  test('tapping the chosen option again keeps a required choice (it is a radio)', () => {
    expect(toggleOption(group(1, 1), ['a'], 'a')).toEqual(['a']);
  });

  test('tapping the chosen option again clears an optional choice', () => {
    expect(toggleOption(group(0, 1), ['a'], 'a')).toEqual([]);
  });

  test('works from nothing chosen', () => {
    expect(toggleOption(group(1, 1), [], 'c')).toEqual(['c']);
  });
});

describe('toggleOption in a choose-several group', () => {
  test('adds and removes', () => {
    expect(toggleOption(group(0, 3), [], 'a')).toEqual(['a']);
    expect(toggleOption(group(0, 3), ['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleOption(group(0, 3), ['a', 'b'], 'a')).toEqual(['b']);
  });

  test('stops at the maximum', () => {
    expect(toggleOption(group(0, 2), ['a', 'b'], 'c')).toEqual(['a', 'b']);
  });

  test('can still remove at the maximum', () => {
    expect(toggleOption(group(0, 2), ['a', 'b'], 'b')).toEqual(['a']);
  });

  test('ignores an option that is not in the group or is sold out', () => {
    const g = { ...group(0, 3), options: [opt('a'), opt('b', false)] };
    expect(toggleOption(g, [], 'zzz')).toEqual([]);
    expect(toggleOption(g, [], 'b')).toEqual([]);
  });
});

describe('isOptionLocked', () => {
  test('a sold-out option is locked', () => {
    const g = { ...group(0, 3), options: [opt('a'), opt('b', false)] };
    expect(isOptionLocked(g, [], 'b')).toBe(true);
    expect(isOptionLocked(g, [], 'a')).toBe(false);
  });

  test('at the maximum the others lock but the chosen ones stay free to remove', () => {
    const g = group(0, 2);
    expect(isOptionLocked(g, ['a', 'b'], 'c')).toBe(true);
    expect(isOptionLocked(g, ['a', 'b'], 'a')).toBe(false);
  });

  test('a choose-one group never locks others: choosing one replaces', () => {
    expect(isOptionLocked(group(1, 1), ['a'], 'b')).toBe(false);
  });
});

describe('pruneSelection (prefill from the last choice)', () => {
  test('keeps what is still on offer and drops the rest, group by group', () => {
    const groups = [
      { ...group(1, 1), id: 'g1', options: [opt('a'), opt('b', false)] },
      { ...group(0, 2), id: 'g2', options: [opt('x'), opt('y'), opt('z')] },
    ];
    expect(pruneSelection(groups, ['b', 'x', 'q', 'y', 'z'])).toEqual(['x', 'y']);
  });

  test('a choose-one group keeps only one', () => {
    expect(pruneSelection([group(1, 1)], ['a', 'b'])).toEqual(['a']);
  });
});

describe('groupRule (how the group is described)', () => {
  test('required one', () => {
    expect(groupRule(group(1, 1))).toEqual({
      key: 'pos.modifier.chooseOne',
      params: {},
      required: true,
    });
  });
  test('required exact count and range', () => {
    expect(groupRule(group(2, 2))).toEqual({
      key: 'pos.modifier.chooseCount',
      params: { count: 2 },
      required: true,
    });
    expect(groupRule(group(1, 3))).toEqual({
      key: 'pos.modifier.chooseRange',
      params: { min: 1, max: 3 },
      required: true,
    });
  });
  test('optional', () => {
    expect(groupRule(group(0, 1))).toEqual({
      key: 'pos.modifier.optional',
      params: {},
      required: false,
    });
    expect(groupRule(group(0, 2))).toEqual({
      key: 'pos.modifier.chooseUpTo',
      params: { max: 2 },
      required: false,
    });
    expect(groupRule(group(0, 3))).toEqual({
      key: 'pos.modifier.chooseAny',
      params: {},
      required: false,
    });
  });
});
