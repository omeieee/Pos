import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  boardColumns,
  currentBusinessDay,
  elapsedMinutes,
  elapsedParts,
  filterOrders,
  orderMoves,
  ordersForDay,
} from './order-board.ts';

const placed = (n: number, at: string, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(uuid(n), n, { orderNo: `S-${String(n).padStart(3, '0')}`, placedAt: at, ...over });

describe('which day is today', () => {
  test('is the business date: before the 04:00 cutoff it is still yesterday', () => {
    const store = createEntityStore();
    // 02:00 in Bangkok on 16 Oct is 19:00 UTC on 15 Oct.
    expect(currentBusinessDay(store.getState().settings, Date.parse('2030-10-15T19:00:00Z'))).toBe(
      '2030-10-15',
    );
    expect(currentBusinessDay(store.getState().settings, Date.parse('2030-10-15T22:00:00Z'))).toBe(
      '2030-10-16',
    );
  });

  test('follows the cutoff the shop has set', () => {
    const store = createEntityStore();
    store.apply({
      type: 'settings.updated',
      id: 'business_day',
      rev: 3,
      version: 1,
      data: { cutoffMinutes: 0, timeZone: 'Asia/Bangkok' },
    });
    expect(currentBusinessDay(store.getState().settings, Date.parse('2030-10-15T19:00:00Z'))).toBe(
      '2030-10-16',
    );
  });
});

describe('the orders of a day', () => {
  test('only that business date, from the store', () => {
    const orders = [
      placed(1, '2030-10-15T05:00:00Z', { businessDate: '2030-10-15' }),
      placed(2, '2030-10-14T05:00:00Z', { businessDate: '2030-10-14' }),
    ];
    expect(ordersForDay(orders, '2030-10-15').map((o) => o.id)).toEqual([uuid(1)]);
  });

  test('"open" leaves out finished and cancelled orders, "all" keeps everything', () => {
    const orders = [
      placed(1, '2030-10-15T05:00:00Z', { status: 'new' }),
      placed(2, '2030-10-15T05:01:00Z', { status: 'preparing' }),
      placed(3, '2030-10-15T05:02:00Z', { status: 'ready' }),
      placed(4, '2030-10-15T05:03:00Z', { status: 'completed' }),
      placed(5, '2030-10-15T05:04:00Z', { status: 'cancelled' }),
    ];
    expect(filterOrders(orders, 'open').map((o) => o.status)).toEqual([
      'new',
      'preparing',
      'ready',
    ]);
    expect(filterOrders(orders, 'all')).toHaveLength(5);
  });
});

describe('the board columns', () => {
  const orders = [
    placed(1, '2030-10-15T05:10:00Z', { status: 'preparing' }),
    placed(2, '2030-10-15T05:00:00Z', { status: 'preparing' }),
    placed(3, '2030-10-15T05:05:00Z', { status: 'new' }),
    placed(4, '2030-10-15T05:20:00Z', { status: 'completed' }),
    placed(5, '2030-10-15T05:30:00Z', { status: 'completed' }),
    placed(6, '2030-10-15T05:40:00Z', { status: 'cancelled' }),
  ];

  test('are new, preparing, ready, completed, in that order', () => {
    expect(boardColumns(orders, 'all').map((c) => c.status)).toEqual([
      'new',
      'preparing',
      'ready',
      'completed',
      'cancelled',
    ]);
  });

  test('the open filter has no completed or cancelled column to show', () => {
    expect(
      boardColumns(
        orders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled'),
        'open',
      ).map((c) => c.status),
    ).toEqual(['new', 'preparing', 'ready']);
  });

  test('waiting orders are oldest first (first in, first made)', () => {
    const preparing = boardColumns(orders, 'all').find((c) => c.status === 'preparing');
    expect(preparing?.orders.map((o) => o.id)).toEqual([uuid(2), uuid(1)]);
  });

  test('finished orders are newest first', () => {
    const done = boardColumns(orders, 'all').find((c) => c.status === 'completed');
    expect(done?.orders.map((o) => o.id)).toEqual([uuid(5), uuid(4)]);
  });

  test('a tie is broken by the order number, so the order of the cards never jumps', () => {
    const tie = [
      placed(8, '2030-10-15T05:00:00Z', { status: 'new', orderNo: 'S-008' }),
      placed(7, '2030-10-15T05:00:00Z', { status: 'new', orderNo: 'S-007' }),
    ];
    const column = boardColumns(tie, 'all').find((c) => c.status === 'new');
    expect(column?.orders.map((o) => o.orderNo)).toEqual(['S-007', 'S-008']);
  });
});

describe('elapsed time', () => {
  test('is whole minutes since the order was placed, never negative', () => {
    const at = '2030-10-15T05:00:00Z';
    expect(elapsedMinutes(at, Date.parse('2030-10-15T05:12:59Z'))).toBe(12);
    expect(elapsedMinutes(at, Date.parse('2030-10-15T04:59:00Z'))).toBe(0);
  });

  test('splits into hours and minutes', () => {
    expect(elapsedParts(0)).toEqual({ hours: 0, minutes: 0 });
    expect(elapsedParts(59)).toEqual({ hours: 0, minutes: 59 });
    expect(elapsedParts(125)).toEqual({ hours: 2, minutes: 5 });
  });
});

describe('the moves a role may make on an order', () => {
  test('a cashier can accept or reject a new order, but not cancel one in progress', () => {
    expect(orderMoves('new', 'cashier')).toEqual([
      { to: 'preparing', kind: 'transition', needsReason: false },
      { to: 'cancelled', kind: 'cancel', needsReason: true },
    ]);
    expect(orderMoves('preparing', 'cashier')).toEqual([
      { to: 'ready', kind: 'transition', needsReason: false },
    ]);
    expect(orderMoves('ready', 'cashier')).toEqual([
      { to: 'completed', kind: 'transition', needsReason: false },
    ]);
  });

  test('a manager can also cancel an order in progress, with a reason', () => {
    expect(orderMoves('preparing', 'manager')).toEqual([
      { to: 'ready', kind: 'transition', needsReason: false },
      { to: 'cancelled', kind: 'cancel', needsReason: true },
    ]);
    expect(orderMoves('ready', 'owner').map((m) => m.to)).toEqual(['completed', 'cancelled']);
  });

  test('the kitchen can accept and advance but never cancel', () => {
    expect(orderMoves('new', 'kitchen').map((m) => m.to)).toEqual(['preparing']);
    expect(orderMoves('preparing', 'kitchen').map((m) => m.to)).toEqual(['ready']);
  });

  test('a finished or cancelled order has no moves', () => {
    expect(orderMoves('completed', 'owner')).toEqual([]);
    expect(orderMoves('cancelled', 'owner')).toEqual([]);
  });
});
