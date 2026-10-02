/**
 * The orders list and board, as pure functions over the entity store's orders (no React, no I/O):
 * which business day is "today", which orders belong on the board, how the columns are sorted,
 * how long an order has waited, and which moves a role may make on an order.
 *
 * The moves are read from the shared order machine (the table the API enforces), so a role never
 * sees a button the server would refuse for its role. The server still checks every call.
 */
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

export interface OrderMove {
  to: OrderStatus;
  /** A cancel goes to `/cancel`, every other move to `/transition`. */
  kind: 'transition' | 'cancel';
  needsReason: boolean;
}

/** The moves this role may make on an order in this status, from the shared order machine. */
export function orderMoves(status: OrderStatus, role: StaffRole): OrderMove[] {
  const actor = { kind: 'staff', role } as const;
  return orderMachine.rules
    .filter((rule) => rule.from === status)
    .filter((rule) => {
      const verdict = orderMachine.transition(rule.from, rule.to, { actor, reason: 'x' });
      return verdict.ok;
    })
    .map((rule) => ({
      to: rule.to,
      kind: rule.to === 'cancelled' ? ('cancel' as const) : ('transition' as const),
      needsReason: rule.reasonRequired === true,
    }));
}
