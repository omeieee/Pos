import { describe, expect, test } from 'vitest';
import {
  type CustomerFacts,
  favouriteItems,
  LAPSED_AFTER_DAYS,
  REGULAR_MIN_ORDERS,
  segmentOf,
  segmentSummary,
} from './customers.ts';

const NOW = new Date('2026-10-17T05:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const customer = (over: Partial<CustomerFacts> = {}): CustomerFacts => ({
  id: 'c1',
  firstSeenAt: daysAgo(100),
  lastOrderAt: daysAgo(3),
  orderCount: 1,
  ...over,
});

describe('segmentOf', () => {
  test('constants: lapsed after 30 days, regular from 2 orders', () => {
    expect(LAPSED_AFTER_DAYS).toBe(30);
    expect(REGULAR_MIN_ORDERS).toBe(2);
  });

  test('new: ordered at most once and not lapsed', () => {
    expect(segmentOf(customer({ orderCount: 1 }), NOW)).toBe('new');
    expect(
      segmentOf(customer({ orderCount: 0, lastOrderAt: null, firstSeenAt: daysAgo(2) }), NOW),
    ).toBe('new');
  });

  test('regular: two or more orders and not lapsed', () => {
    expect(segmentOf(customer({ orderCount: 2 }), NOW)).toBe('regular');
    expect(segmentOf(customer({ orderCount: 40, lastOrderAt: daysAgo(30) }), NOW)).toBe('regular');
  });

  test('lapsed: the last order is more than 30 days ago, however many orders', () => {
    expect(segmentOf(customer({ orderCount: 40, lastOrderAt: daysAgo(31) }), NOW)).toBe('lapsed');
    expect(segmentOf(customer({ orderCount: 1, lastOrderAt: daysAgo(45) }), NOW)).toBe('lapsed');
  });

  test('30 days exactly is still active, 30 days and a minute is lapsed', () => {
    const edge = new Date(NOW.getTime() - 30 * 86_400_000);
    expect(segmentOf(customer({ lastOrderAt: edge }), NOW)).toBe('new');
    expect(segmentOf(customer({ lastOrderAt: new Date(edge.getTime() - 60_000) }), NOW)).toBe(
      'lapsed',
    );
  });

  test('a customer who never ordered counts from the day first seen', () => {
    expect(
      segmentOf(customer({ orderCount: 0, lastOrderAt: null, firstSeenAt: daysAgo(10) }), NOW),
    ).toBe('new');
    expect(
      segmentOf(customer({ orderCount: 0, lastOrderAt: null, firstSeenAt: daysAgo(60) }), NOW),
    ).toBe('lapsed');
  });
});

describe('segmentSummary', () => {
  test('counts each segment, with zeros for the empty ones', () => {
    const list = [
      customer({ id: 'a', orderCount: 1 }),
      customer({ id: 'b', orderCount: 5 }),
      customer({ id: 'c', orderCount: 5 }),
      customer({ id: 'd', lastOrderAt: daysAgo(90) }),
    ];
    expect(segmentSummary(list, NOW)).toEqual({ new: 1, regular: 2, lapsed: 1 });
    expect(segmentSummary([], NOW)).toEqual({ new: 0, regular: 0, lapsed: 0 });
  });
});

describe('favouriteItems', () => {
  const row = (customerId: string, menuItemId: string, name: string, qty: number) => ({
    customerId,
    menuItemId,
    name,
    qty,
  });

  test('keeps the top items of each customer by units, then name, up to the limit', () => {
    const fav = favouriteItems(
      [
        row('c1', 'a', 'ต้มยำ', 5),
        row('c1', 'b', 'ชาเย็น', 9),
        row('c1', 'c', 'ไข่ดาว', 2),
        row('c1', 'd', 'น้ำเปล่า', 1),
        row('c2', 'a', 'ต้มยำ', 1),
      ],
      3,
    );
    expect(fav.get('c1')?.map((i) => i.menuItemId)).toEqual(['b', 'a', 'c']);
    expect(fav.get('c2')?.map((i) => i.menuItemId)).toEqual(['a']);
    expect(fav.get('nobody')).toBeUndefined();
  });

  test('adds the units of the same item given in several rows', () => {
    const fav = favouriteItems(
      [row('c1', 'a', 'A', 1), row('c1', 'a', 'A', 2), row('c1', 'b', 'B', 2)],
      2,
    );
    expect(fav.get('c1')).toEqual([
      { menuItemId: 'a', name: 'A', qty: 3 },
      { menuItemId: 'b', name: 'B', qty: 2 },
    ]);
  });

  test('ties on units are broken by name, then id, so the list is stable', () => {
    const fav = favouriteItems(
      [row('c1', 'z', 'B', 2), row('c1', 'y', 'A', 2), row('c1', 'x', 'A', 2)],
      3,
    );
    expect(fav.get('c1')?.map((i) => i.menuItemId)).toEqual(['x', 'y', 'z']);
  });

  test('refuses a fractional or non-positive quantity, and a limit below 1', () => {
    expect(() => favouriteItems([row('c1', 'a', 'A', 1.5)], 3)).toThrow(RangeError);
    expect(() => favouriteItems([row('c1', 'a', 'A', 0)], 3)).toThrow(RangeError);
    expect(() => favouriteItems([], 0)).toThrow(RangeError);
  });
});
