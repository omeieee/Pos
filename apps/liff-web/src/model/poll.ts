import type { MyOrder } from '@sds/shared';

/**
 * How long to wait before asking the server about an order again (the staff WebSocket is not for
 * customers, so the page polls). Quick while something is moving, slower in the background, and
 * never once the order is closed. Null means stop.
 */
export function nextPollDelayMs(
  order: MyOrder | null,
  hidden: boolean,
  failures: number,
): number | null {
  if (order && (order.status === 'completed' || order.status === 'cancelled')) {
    // A paid, finished order has nothing left to learn; an unpaid one may still be settled.
    if (order.paymentStatus === 'paid' || order.status === 'cancelled') return null;
  }
  const base = hidden ? 30_000 : 4_000;
  // Back off after failures (a flaky mobile connection), up to a minute.
  return Math.min(60_000, base * 2 ** Math.min(failures, 4));
}
