import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import {
  boardColumns,
  byNewest,
  currentBusinessDay,
  elapsedMinutes,
  elapsedParts,
  filterOrders,
  matchesPaymentFilter,
  matchesPhoneFilter,
  matchesQuery,
  orderMoves,
  ordersForDay,
  paidByHour,
  paidToday,
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

  test('a finished order can only be cancelled, by the owner; a cancelled one has no moves', () => {
    expect(orderMoves('completed', 'owner')).toEqual([
      { to: 'cancelled', kind: 'cancel', needsReason: true },
    ]);
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      expect(orderMoves('completed', role)).toEqual([]);
    }
    expect(orderMoves('cancelled', 'owner')).toEqual([]);
  });
});

describe('the payment filter of the orders table', () => {
  const o = (over: Parameters<typeof orderDto>[2]) => placed(1, '2030-10-15T05:00:00Z', over);

  test('all has everything; the groups are the payment states', () => {
    expect(matchesPaymentFilter(o({ status: 'cancelled' }), 'all')).toBe(true);
    expect(
      matchesPaymentFilter(o({ paymentStatus: 'awaiting_confirmation' }), 'awaiting_confirmation'),
    ).toBe(true);
    expect(matchesPaymentFilter(o({ paymentStatus: 'unpaid' }), 'awaiting_confirmation')).toBe(
      false,
    );
    expect(matchesPaymentFilter(o({ paymentStatus: 'unpaid' }), 'unpaid')).toBe(true);
    // Part paid still owes money.
    expect(matchesPaymentFilter(o({ paymentStatus: 'partially_paid' }), 'unpaid')).toBe(true);
    expect(matchesPaymentFilter(o({ paymentStatus: 'paid' }), 'paid')).toBe(true);
    expect(matchesPaymentFilter(o({ paymentStatus: 'refunded' }), 'paid')).toBe(false);
  });

  test('a cancelled order owes nothing, so it is in no payment group', () => {
    for (const filter of ['awaiting_confirmation', 'unpaid', 'paid'] as const) {
      expect(
        matchesPaymentFilter(
          o({
            status: 'cancelled',
            paymentStatus: filter === 'awaiting_confirmation' ? 'awaiting_confirmation' : filter,
          }),
          filter,
        ),
      ).toBe(false);
    }
  });
});

describe('the phone filter', () => {
  const o = (over: Parameters<typeof orderDto>[2]) => placed(1, '2030-10-15T05:00:00Z', over);

  test('to pay is unpaid, part paid and claimed; cooking is new and preparing; done is ready and completed', () => {
    expect(matchesPhoneFilter(o({ paymentStatus: 'unpaid' }), 'pay')).toBe(true);
    expect(matchesPhoneFilter(o({ paymentStatus: 'awaiting_confirmation' }), 'pay')).toBe(true);
    expect(matchesPhoneFilter(o({ paymentStatus: 'paid' }), 'pay')).toBe(false);
    expect(matchesPhoneFilter(o({ status: 'cancelled', paymentStatus: 'unpaid' }), 'pay')).toBe(
      false,
    );
    expect(matchesPhoneFilter(o({ status: 'new' }), 'cooking')).toBe(true);
    expect(matchesPhoneFilter(o({ status: 'preparing' }), 'cooking')).toBe(true);
    expect(matchesPhoneFilter(o({ status: 'ready' }), 'cooking')).toBe(false);
    expect(matchesPhoneFilter(o({ status: 'ready' }), 'done')).toBe(true);
    expect(matchesPhoneFilter(o({ status: 'completed' }), 'done')).toBe(true);
    expect(matchesPhoneFilter(o({ status: 'cancelled' }), 'done')).toBe(false);
    expect(matchesPhoneFilter(o({ status: 'cancelled' }), 'all')).toBe(true);
  });
});

describe('newest first and the search', () => {
  test('newest first; the number breaks a tie', () => {
    const list = [
      placed(1, '2030-10-15T05:00:00Z'),
      placed(3, '2030-10-15T05:10:00Z'),
      placed(2, '2030-10-15T05:10:00Z'),
    ];
    expect(list.sort(byNewest).map((x) => x.orderNo)).toEqual(['S-003', 'S-002', 'S-001']);
  });

  test('finds by any part of the number, name, room or building, in any case', () => {
    const order = placed(7, '2030-10-15T05:00:00Z', {
      deliveryBuilding: 'B1',
      recipientName: 'Fah Example',
      roomNo: '1204',
    });
    for (const query of ['s-007', '007', 'fah', 'EXAMPLE', '120', 'b1', '  fah  ', '']) {
      expect(matchesQuery(order, query), query).toBe(true);
    }
    for (const query of ['nok', 's-008', '9999']) {
      expect(matchesQuery(order, query), query).toBe(false);
    }
  });

  test('an order with no name or room is still found by its number', () => {
    const order = placed(1, '2030-10-15T05:00:00Z', {
      deliveryBuilding: null,
      recipientName: null,
      roomNo: null,
    });
    expect(matchesQuery(order, 's-001')).toBe(true);
    expect(matchesQuery(order, 'fah')).toBe(false);
  });
});

describe('what was received today', () => {
  test('adds up the paid orders that were not cancelled', () => {
    const orders = [
      placed(1, '2030-10-15T05:00:00Z', { paymentStatus: 'paid', totalSatang: 10000 as never }),
      placed(2, '2030-10-15T05:00:00Z', { paymentStatus: 'paid', totalSatang: 5050 as never }),
      placed(3, '2030-10-15T05:00:00Z', { paymentStatus: 'unpaid', totalSatang: 9900 as never }),
      placed(4, '2030-10-15T05:00:00Z', {
        paymentStatus: 'paid',
        status: 'cancelled',
        totalSatang: 700 as never,
      }),
    ];
    expect(paidToday(orders)).toEqual({ count: 2, totalSatang: 15050 });
    expect(paidToday([])).toEqual({ count: 0, totalSatang: 0 });
  });

  test('the hourly line is the running total, hour by hour, in Bangkok time', () => {
    const paid = (n: number, at: string, satang: number) =>
      placed(n, at, { paymentStatus: 'paid', totalSatang: satang as never });
    // 11:xx, 11:xx, 13:xx Bangkok time (UTC+7): nothing in the 12 o'clock hour.
    const series = paidByHour([
      paid(1, '2030-10-15T04:10:00Z', 100),
      paid(2, '2030-10-15T04:50:00Z', 50),
      paid(3, '2030-10-15T06:05:00Z', 200),
    ]);
    expect(series).toEqual([150, 150, 350]);
  });

  test('one hour or none is no line', () => {
    expect(paidByHour([])).toEqual([]);
    expect(paidByHour([placed(1, '2030-10-15T04:10:00Z', { paymentStatus: 'paid' })])).toEqual([]);
  });
});
