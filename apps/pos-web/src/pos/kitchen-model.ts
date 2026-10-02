/**
 * What the kitchen view shows, as pure functions (no React, no I/O): which orders are on the
 * queue, in which order, how long each has waited and how urgent that is, and which moves a role
 * may make from here.
 *
 * Nothing here decides a business rule. The moves come from the shared order machine (through
 * `orderMoves`), so the view never offers a move the server would refuse for the role; the server
 * still checks every call. Money does not appear: the kitchen view never reads a price or a total.
 */
import type { OrderDto, OrderStatus, StaffRole } from '@sds/shared';
import { elapsedMinutes, type OrderMove, orderMoves } from './order-board.ts';

export interface KitchenQueue {
  /** New and preparing, oldest first: first in, first made. */
  toMake: OrderDto[];
  /** Ready, waiting for hand-over: the one that has waited longest first. */
  ready: OrderDto[];
}

const byPlaced = (a: OrderDto, b: OrderDto) =>
  a.placedAt.localeCompare(b.placedAt) || a.orderNo.localeCompare(b.orderNo);

const readySince = (o: Pick<OrderDto, 'placedAt' | 'readyAt'>) => o.readyAt ?? o.placedAt;
const byReady = (a: OrderDto, b: OrderDto) =>
  readySince(a).localeCompare(readySince(b)) || a.orderNo.localeCompare(b.orderNo);

/** The open orders of the store, split for the kitchen. The input is not changed. */
export function kitchenQueue(orders: Iterable<OrderDto>): KitchenQueue {
  const toMake: OrderDto[] = [];
  const ready: OrderDto[] = [];
  for (const order of orders) {
    if (order.status === 'new' || order.status === 'preparing') toMake.push(order);
    else if (order.status === 'ready') ready.push(order);
  }
  return { toMake: toMake.sort(byPlaced), ready: ready.sort(byReady) };
}

/** Whole minutes an order has waited: to be made since placed, ready since it became ready. */
export function waitMinutes(
  order: Pick<OrderDto, 'status' | 'placedAt' | 'readyAt'>,
  nowMs: number,
) {
  return elapsedMinutes(order.status === 'ready' ? readySince(order) : order.placedAt, nowMs);
}

export type WaitLevel = 'ok' | 'warn' | 'late';

/** Minutes after which a ticket turns amber and then red (words go with the colour on screen). */
export const WAIT_WARN_MINUTES = 10;
export const WAIT_LATE_MINUTES = 20;

export function waitLevel(minutes: number): WaitLevel {
  if (minutes >= WAIT_LATE_MINUTES) return 'late';
  if (minutes >= WAIT_WARN_MINUTES) return 'warn';
  return 'ok';
}

/**
 * The moves the kitchen view offers for an order in this status: start preparing, mark ready.
 * Cancelling needs a reason and the hand-over is the counter's job, so both stay on the order
 * page; the shared machine still decides which of the two this role may make.
 */
export function kitchenMoves(status: OrderStatus, role: StaffRole): OrderMove[] {
  return orderMoves(status, role).filter(
    (move) => move.kind === 'transition' && (move.to === 'preparing' || move.to === 'ready'),
  );
}
