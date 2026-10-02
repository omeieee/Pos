import { describe, expect, test } from 'vitest';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  kitchenMoves,
  kitchenQueue,
  type WaitLevel,
  waitLevel,
  waitMinutes,
} from './kitchen-model.ts';

const NOW = Date.parse('2030-01-01T05:30:00.000Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const at = (n: number, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(uuid(n), n, { orderNo: `S-${String(n).padStart(3, '0')}`, ...over });

describe('the kitchen queue', () => {
  test('has the orders to make (new and preparing, oldest first) and, apart, the ones ready for hand-over', () => {
    const orders = [
      at(1, { status: 'preparing', placedAt: minutesAgo(5) }),
      at(2, { status: 'new', placedAt: minutesAgo(12) }),
      at(3, { status: 'ready', placedAt: minutesAgo(20), readyAt: minutesAgo(2) }),
      at(4, { status: 'completed', placedAt: minutesAgo(30) }),
      at(5, { status: 'cancelled', placedAt: minutesAgo(30) }),
      at(6, { status: 'new', placedAt: minutesAgo(1) }),
      at(7, { status: 'ready', placedAt: minutesAgo(15), readyAt: minutesAgo(9) }),
    ];
    const queue = kitchenQueue(orders);
    expect(queue.toMake.map((o) => o.orderNo)).toEqual(['S-002', 'S-001', 'S-006']);
    // Ready ones: the one that has waited longest for hand-over first.
    expect(queue.ready.map((o) => o.orderNo)).toEqual(['S-007', 'S-003']);
  });

  test('the order number breaks a tie so cards never jump', () => {
    const same = minutesAgo(3);
    const queue = kitchenQueue([
      at(9, { status: 'new', placedAt: same }),
      at(8, { status: 'new', placedAt: same }),
    ]);
    expect(queue.toMake.map((o) => o.orderNo)).toEqual(['S-008', 'S-009']);
  });

  test('is empty when nothing is open', () => {
    expect(kitchenQueue([])).toEqual({ toMake: [], ready: [] });
  });

  test('does not change the list it was given', () => {
    const orders = [
      at(1, { status: 'new', placedAt: minutesAgo(1) }),
      at(2, { status: 'new', placedAt: minutesAgo(9) }),
    ];
    kitchenQueue(orders);
    expect(orders.map((o) => o.orderNo)).toEqual(['S-001', 'S-002']);
  });
});

describe('minutes waiting', () => {
  test('an order to make waits since it was placed, a ready one since it became ready', () => {
    expect(waitMinutes(at(1, { status: 'new', placedAt: minutesAgo(7) }), NOW)).toBe(7);
    expect(waitMinutes(at(1, { status: 'preparing', placedAt: minutesAgo(7) }), NOW)).toBe(7);
    expect(
      waitMinutes(
        at(1, { status: 'ready', placedAt: minutesAgo(30), readyAt: minutesAgo(4) }),
        NOW,
      ),
    ).toBe(4);
  });

  test('a ready order with no ready time falls back to the placed time', () => {
    expect(waitMinutes(at(1, { status: 'ready', placedAt: minutesAgo(8) }), NOW)).toBe(8);
  });

  test('whole minutes, never negative (a skewed clock shows 0)', () => {
    expect(waitMinutes(at(1, { placedAt: new Date(NOW - 119_000).toISOString() }), NOW)).toBe(1);
    expect(waitMinutes(at(1, { placedAt: new Date(NOW + 60_000).toISOString() }), NOW)).toBe(0);
  });
});

describe('the colour steps of a ticket', () => {
  test('ok under 10 minutes, warn from 10, late from 20', () => {
    const levels: [number, WaitLevel][] = [
      [0, 'ok'],
      [9, 'ok'],
      [10, 'warn'],
      [19, 'warn'],
      [20, 'late'],
      [95, 'late'],
    ];
    for (const [minutes, level] of levels) expect(waitLevel(minutes), String(minutes)).toBe(level);
  });
});

describe('the moves the kitchen may make', () => {
  test('a kitchen role starts a new order and marks a preparing one ready; nothing else', () => {
    expect(kitchenMoves('new', 'kitchen').map((m) => m.to)).toEqual(['preparing']);
    expect(kitchenMoves('preparing', 'kitchen').map((m) => m.to)).toEqual(['ready']);
  });

  test('never a cancel and never the hand-over (those belong to the order page)', () => {
    for (const status of ['new', 'preparing', 'ready'] as const) {
      for (const role of ['kitchen', 'cashier', 'manager', 'owner'] as const) {
        const targets = kitchenMoves(status, role).map((m) => m.to);
        expect(targets).not.toContain('cancelled');
        expect(targets).not.toContain('completed');
      }
    }
    expect(kitchenMoves('ready', 'kitchen')).toEqual([]);
  });

  test('a finished or cancelled order has no moves', () => {
    expect(kitchenMoves('completed', 'owner')).toEqual([]);
    expect(kitchenMoves('cancelled', 'owner')).toEqual([]);
  });
});
