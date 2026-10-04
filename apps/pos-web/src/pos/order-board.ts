/**
 * The orders list and board, as pure functions over the entity store's orders (no React, no I/O):
 * which business day is "today", which orders belong on the board, how the columns are sorted,
 * how long an order has waited, and which moves a role may make on an order.
 *
 * The moves are read from the shared order machine (the table the API enforces), so a role never
 * sees a button the server would refuse for its role. The server still checks every call.
 */
import { DISPLAY_TIME_ZONE } from '@sds/i18n';
import {
  businessDate,
  DEFAULT_CUTOFF_MINUTES,
  type OrderDto,
  type OrderStatus,
  orderMachine,
  SHOP_TIME_ZONE,
  type StaffRole,
} from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';

/** The business date now: the shop's cutoff setting, or the default cutoff if it never arrived. */
export function currentBusinessDay(settings: EntityState['settings'], nowMs: number): string {
  const entry = settings.get('business_day');
  const rule =
    entry?.id === 'business_day'
      ? entry.data
      : { cutoffMinutes: DEFAULT_CUTOFF_MINUTES, timeZone: SHOP_TIME_ZONE };
  return businessDate(new Date(nowMs), rule.cutoffMinutes, rule.timeZone);
}

export const ordersForDay = (orders: Iterable<OrderDto>, day: string): OrderDto[] =>
  [...orders].filter((o) => o.businessDate === day);

export type BoardFilter = 'open' | 'all';

const WAITING: readonly OrderStatus[] = ['new', 'preparing', 'ready'];

export function filterOrders(orders: readonly OrderDto[], filter: BoardFilter): OrderDto[] {
  return filter === 'all' ? [...orders] : orders.filter((o) => WAITING.includes(o.status));
}

export interface BoardColumn {
  status: OrderStatus;
  orders: OrderDto[];
}

/** First in, first made: oldest first; the order number breaks a tie so cards never jump. */
const byAge = (a: OrderDto, b: OrderDto) =>
  a.placedAt.localeCompare(b.placedAt) || a.orderNo.localeCompare(b.orderNo);

/**
 * The columns of the board: new, preparing, ready, then (with "all") completed and, only if there
 * are any, cancelled. Waiting orders are oldest first; finished ones newest first.
 */
export function boardColumns(orders: readonly OrderDto[], filter: BoardFilter): BoardColumn[] {
  const statuses: OrderStatus[] =
    filter === 'open' ? [...WAITING] : [...WAITING, 'completed', 'cancelled'];
  return statuses
    .map((status) => {
      const own = orders.filter((o) => o.status === status);
      return {
        status,
        orders: WAITING.includes(status) ? own.sort(byAge) : own.sort(byAge).reverse(),
      };
    })
    .filter((column) => column.status !== 'cancelled' || column.orders.length > 0);
}

/** Whole minutes since the order was placed, never negative (a skewed clock shows 0). */
export function elapsedMinutes(placedAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(placedAt)) / 60_000));
}

export function elapsedParts(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** Every status an order can be moved to (nothing moves back to "new"). */
export type MoveTarget = Exclude<OrderStatus, 'new'>;

export interface OrderMove {
  to: MoveTarget;
  /** A cancel goes to `/cancel`, every other move to `/transition`. */
  kind: 'transition' | 'cancel';
  needsReason: boolean;
}

/** The moves this role may make on an order in this status, from the shared order machine. */
export function orderMoves(status: OrderStatus, role: StaffRole): OrderMove[] {
  const actor = { kind: 'staff', role } as const;
  const moves: OrderMove[] = [];
  for (const rule of orderMachine.rules) {
    if (rule.from !== status || rule.to === 'new') continue;
    if (!orderMachine.transition(rule.from, rule.to, { actor, reason: 'x' }).ok) continue;
    moves.push({
      to: rule.to,
      kind: rule.to === 'cancelled' ? 'cancel' : 'transition',
      needsReason: rule.reasonRequired === true,
    });
  }
  return moves;
}

// ---------- The orders table and the phone list (design "Orders") ----------

/** The laptop / iPad filter: payment groups. Cancelled orders owe nothing, so only "all" has them. */
export type PaymentFilter = 'all' | 'awaiting_confirmation' | 'unpaid' | 'paid';
/** The phone filter: still to pay, in the kitchen, done. */
export type PhoneFilter = 'all' | 'pay' | 'cooking' | 'done';

export const PAYMENT_FILTERS: readonly PaymentFilter[] = [
  'all',
  'awaiting_confirmation',
  'unpaid',
  'paid',
];
export const PHONE_FILTERS: readonly PhoneFilter[] = ['all', 'pay', 'cooking', 'done'];

export function matchesPaymentFilter(order: OrderDto, filter: PaymentFilter): boolean {
  if (filter === 'all') return true;
  if (order.status === 'cancelled') return false;
  if (filter === 'unpaid') {
    return order.paymentStatus === 'unpaid' || order.paymentStatus === 'partially_paid';
  }
  return order.paymentStatus === filter;
}

export function matchesPhoneFilter(order: OrderDto, filter: PhoneFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pay':
      return (
        order.status !== 'cancelled' &&
        (order.paymentStatus === 'unpaid' ||
          order.paymentStatus === 'partially_paid' ||
          order.paymentStatus === 'awaiting_confirmation')
      );
    case 'cooking':
      return order.status === 'new' || order.status === 'preparing';
    case 'done':
      return order.status === 'ready' || order.status === 'completed';
  }
}

/** Newest first, the order number breaks a tie so rows never jump. */
export const byNewest = (a: OrderDto, b: OrderDto) =>
  b.placedAt.localeCompare(a.placedAt) || b.orderNo.localeCompare(a.orderNo);

/**
 * The search box: order number, recipient name, room or building, case-insensitive, any part of
 * them. Done on the orders already loaded; nothing is sent anywhere or kept.
 */
export function matchesQuery(order: OrderDto, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [order.orderNo, order.recipientName, order.roomNo, order.deliveryBuilding].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

/** What has been received today: paid orders that were not cancelled, and their sum. */
export function paidToday(orders: readonly OrderDto[]): { count: number; totalSatang: number } {
  let count = 0;
  let totalSatang = 0;
  for (const order of orders) {
    if (order.paymentStatus !== 'paid' || order.status === 'cancelled') continue;
    count += 1;
    totalSatang += order.totalSatang;
  }
  return { count, totalSatang };
}

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: DISPLAY_TIME_ZONE,
});

/**
 * The running total of paid orders hour by hour, from the first hour with a paid order to the last
 * (an hour with none repeats the total). Fewer than two hours is no line, so it returns [].
 */
export function paidByHour(orders: readonly OrderDto[]): number[] {
  const perHour = new Map<number, number>();
  for (const order of orders) {
    if (order.paymentStatus !== 'paid' || order.status === 'cancelled') continue;
    const hour = Number(hourFormat.format(new Date(order.placedAt)));
    perHour.set(hour, (perHour.get(hour) ?? 0) + order.totalSatang);
  }
  const hours = [...perHour.keys()];
  if (hours.length < 2) return [];
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  const series: number[] = [];
  let running = 0;
  for (let hour = first; hour <= last; hour += 1) {
    running += perHour.get(hour) ?? 0;
    series.push(running);
  }
  return series;
}
