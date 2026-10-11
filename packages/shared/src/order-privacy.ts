/**
 * What a role may read on an order. Pure: no I/O.
 *
 * The kitchen reads every order (it works from the queue) but has no reason to phone a customer,
 * so the member phone number never leaves the server for a role that cannot take orders
 * (`order.create`). The same rule runs on every path that sends an order to a device: the list, one
 * order, a move, the live frames and the catch-up.
 */

import type { StaffRole } from './enums.ts';
import type { OrderDto } from './orders.ts';
import { hasPermission } from './permissions.ts';

export function redactOrderForRole(role: StaffRole, order: OrderDto): OrderDto {
  if (!order.member?.phone || hasPermission(role, 'order.create')) return order;
  return { ...order, member: { ...order.member, phone: null } };
}
