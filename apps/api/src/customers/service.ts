/**
 * Customers (PDPA). One action so far: erase a customer's personal data (`anonymizeCustomer`).
 * Owner only with step-up (the route guard checks); audited and alerted. The audit row and the
 * alert carry ids, a count and a fixed reason word, never a name, a phone or a note.
 *
 * This is the owner's request path. The nightly retention jobs (`jobs/retention.ts`) erase
 * remembered recipients 30 days after their last order on their own.
 */
import { customersRepo, insertAudit, ordersRepo } from '@sds/db';
import type { AnonymizeCustomerInput, AnonymizeCustomerResponse } from '@sds/shared';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { notFound } from '../errors.ts';
import { toOrderDto } from '../orders/dto.ts';
import { withTransaction } from '../tx.ts';

/**
 * Erases the customer and the person on their orders, in one transaction. Asking again for a
 * customer that is already erased changes nothing: no audit row, no alert, no event.
 */
export async function anonymizeCustomer(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: AnonymizeCustomerInput,
  meta: RequestMeta,
): Promise<AnonymizeCustomerResponse> {
  return withTransaction(ctx, async (tx, emit) => {
    const result = await customersRepo.anonymizeCustomer(tx, id, ctx.now());
    if (!result.found) throw notFound('Customer');
    const response = {
      id,
      anonymizedAt: result.anonymizedAt.toISOString(),
      version: result.version,
    };
    if (!result.changed) return response;

    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      ip: meta.ip,
      action: 'customer.anonymize',
      entity: 'customers',
      entityId: id,
      after: { orders: result.orderIds.length, ...(input.reason ? { reason: input.reason } : {}) },
    });
    emit(
      securityAlert(ctx, 'customer.anonymized', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
      }),
    );
    // Screens that hold these orders must not keep showing the name until their next catch-up.
    for (const orderId of result.orderIds) {
      const order = await ordersRepo.findOrderById(tx, orderId);
      if (!order) continue;
      const items = await ordersRepo.loadOrderItems(tx, [orderId]);
      emit({
        type: 'order.upserted',
        id: order.id,
        rev: order.rev,
        data: toOrderDto(order, items.get(orderId) ?? []),
      });
    }
    return response;
  });
}
