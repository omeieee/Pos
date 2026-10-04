import { describe, expect, test } from 'vitest';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  handedOverToday,
  isFresh,
  kitchenMoves,
  kitchenQueue,
  timerText,
  WAIT_LATE_MINUTES,
  WAIT_WARN_MINUTES,
  type WaitLevel,
  waitLevel,
  waitMinutes,
  waitProgress,
  waitSeconds,
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
  test('the design says the timer changes after 8 minutes; very late is 12', () => {
    expect(WAIT_WARN_MINUTES).toBe(8);
    expect(WAIT_LATE_MINUTES).toBe(12);
  });

  test('ok under 8 minutes, warn from 8, late from 12', () => {
    const levels: [number, WaitLevel][] = [
      [0, 'ok'],
      [7, 'ok'],
      [8, 'warn'],
      [11, 'warn'],
      [12, 'late'],
      [95, 'late'],
    ];
    for (const [minutes, level] of levels) expect(waitLevel(minutes), String(minutes)).toBe(level);
  });
});

describe('seconds, the timer text and the progress line', () => {
  test('seconds waiting follow the same start as minutes, never negative', () => {
    expect(waitSeconds(at(1, { status: 'new', placedAt: minutesAgo(2) }), NOW)).toBe(120);
    expect(
      waitSeconds(
        at(1, { status: 'ready', placedAt: minutesAgo(30), readyAt: minutesAgo(1) }),
        NOW,
      ),
    ).toBe(60);
    expect(waitSeconds(at(1, { placedAt: new Date(NOW + 5_000).toISOString() }), NOW)).toBe(0);
  });

  test('the timer reads mm:ss, and h:mm:ss from an hour on', () => {
    expect(timerText(0)).toBe('00:00');
    expect(timerText(22)).toBe('00:22');
    expect(timerText(8 * 60 + 35)).toBe('08:35');
    expect(timerText(3600 + 5 * 60 + 9)).toBe('1:05:09');
  });

  test('the progress line fills towards "very late" and stops at full', () => {
    expect(waitProgress(0)).toBe(0);
    expect(waitProgress(WAIT_LATE_MINUTES * 30)).toBeCloseTo(0.5);
    expect(waitProgress(WAIT_LATE_MINUTES * 60 * 3)).toBe(1);
  });

  test('a new ticket glows for its first minute only', () => {
    const placedAt = minutesAgo(0);
    expect(isFresh({ status: 'new', placedAt }, NOW)).toBe(true);
    expect(isFresh({ status: 'new', placedAt: new Date(NOW - 59_000).toISOString() }, NOW)).toBe(
      true,
    );
    expect(isFresh({ status: 'new', placedAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(
      false,
    );
    expect(isFresh({ status: 'preparing', placedAt }, NOW)).toBe(false);
  });
});

describe('handed over today', () => {
  test('counts the completed orders of the day and averages placed to handed over', () => {
    const day = '2030-01-01';
    const done = (n: number, took: number, over: Parameters<typeof orderDto>[2] = {}) =>
      at(n, {
        status: 'completed',
        businessDate: day,
        placedAt: minutesAgo(60),
        completedAt: minutesAgo(60 - took),
        ...over,
      });
    const result = handedOverToday(
      [
        done(1, 6),
        done(2, 8),
        done(3, 10, { businessDate: '2029-12-31' }),
        at(4, { status: 'ready', businessDate: day }),
      ],
      day,
    );
    expect(result).toEqual({ count: 2, averageMinutes: 7 });
  });

  test('says no average when none is timed', () => {
    expect(handedOverToday([], '2030-01-01')).toEqual({ count: 0, averageMinutes: null });
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
