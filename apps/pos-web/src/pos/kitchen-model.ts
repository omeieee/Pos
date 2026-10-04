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

/**
 * Minutes after which a ticket's timer turns red with the word "overdue" (the design's 8 minutes),
 * and after which it is "very late" (the ticket also gets a ring, so it is not colour alone).
 */
export const WAIT_WARN_MINUTES = 8;
export const WAIT_LATE_MINUTES = 12;

export function waitLevel(minutes: number): WaitLevel {
  if (minutes >= WAIT_LATE_MINUTES) return 'late';
  if (minutes >= WAIT_WARN_MINUTES) return 'warn';
  return 'ok';
}

/** Whole seconds an order has waited (same start as `waitMinutes`), never negative. */
export function waitSeconds(
  order: Pick<OrderDto, 'status' | 'placedAt' | 'readyAt'>,
  nowMs: number,
) {
  const since = order.status === 'ready' ? readySince(order) : order.placedAt;
  return Math.max(0, Math.floor((nowMs - Date.parse(since)) / 1000));
}

/** "05:10" for a timer badge; "1:05:10" from an hour on. */
export function timerText(seconds: number): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}

/** How far a ticket in the pan is towards "very late", 0 to 1, for the thin progress line. */
export function waitProgress(seconds: number): number {
  return Math.min(1, seconds / (WAIT_LATE_MINUTES * 60));
}

/** A new ticket glows for its first minute, so a fresh order cannot be missed on the wall. */
export const NEW_GLOW_SECONDS = 60;
export const isFresh = (order: Pick<OrderDto, 'status' | 'placedAt'>, nowMs: number) =>
  order.status === 'new' && waitSeconds({ ...order, readyAt: null }, nowMs) < NEW_GLOW_SECONDS;

/** Orders handed over today and the average minutes from placed to handed over (null when none). */
export function handedOverToday(
  orders: Iterable<OrderDto>,
  day: string,
): { count: number; averageMinutes: number | null } {
  let count = 0;
  let timed = 0;
  let total = 0;
  for (const order of orders) {
    if (order.status !== 'completed' || order.businessDate !== day) continue;
    count += 1;
    if (order.completedAt) {
      timed += 1;
      total += Math.max(0, Date.parse(order.completedAt) - Date.parse(order.placedAt));
    }
  }
  return { count, averageMinutes: timed === 0 ? null : Math.round(total / timed / 60_000) };
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
