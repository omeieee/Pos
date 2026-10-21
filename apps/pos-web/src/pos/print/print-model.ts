import type { OrderStatus } from '@sds/shared';

/** A cancelled order has nothing left to cook, so it gets no "Reprint order" button (owner, 2026-10-22). */
export function canReprint(status: OrderStatus): boolean {
  return status !== 'cancelled';
}
