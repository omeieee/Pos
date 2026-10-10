import type { OrderChannel, OrderStatus } from './enums.ts';
import { makeMachine } from './state-machine.ts';

/** Order fulfilment status (03 §4). Every order status change goes through this machine. */
export const orderMachine = makeMachine<OrderStatus>([
  { from: 'new', to: 'preparing', staff: 'order.accept' },
  {
    from: 'new',
    to: 'cancelled',
    staff: 'order.cancel_new',
    customer: true,
    system: true,
    reasonRequired: true,
  },
  { from: 'preparing', to: 'ready', staff: 'order.advance' },
  { from: 'ready', to: 'completed', staff: 'order.advance' },
  {
    from: 'preparing',
    to: 'cancelled',
    staff: 'order.cancel_in_progress',
    reasonRequired: true,
  },
  { from: 'ready', to: 'cancelled', staff: 'order.cancel_in_progress', reasonRequired: true },
  // Owner only, with step-up: voiding an order that was already finished (decision 2026-10-11).
  { from: 'completed', to: 'cancelled', staff: 'order.edit_past', reasonRequired: true },
]);

/**
 * LINE and platform orders arrive as `new` and wait for staff to accept them.
 * Orders keyed in by staff (storefront, phone) go straight to `preparing`.
 */
export function initialOrderStatus(channel: OrderChannel): OrderStatus {
  return channel === 'storefront' || channel === 'phone' ? 'preparing' : 'new';
}
