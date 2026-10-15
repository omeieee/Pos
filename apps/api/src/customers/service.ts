/**
 * Customers (PDPA). One action so far: erase a customer's personal data (`anonymizeCustomer`).
 * Owner only with step-up (the route guard checks); audited and alerted. The audit row and the
 * alert carry ids, a count and a fixed reason word, never a name, a phone or a note.
 *
 * This is the owner's request path. The nightly retention jobs (`jobs/retention.ts`) erase
 * remembered recipients 30 days after their last order on their own.
 */
import { customersRepo, findAuditByRequestId, insertAudit, ordersRepo } from '@sds/db';
import type {
  AnonymizeCustomerInput,
  AnonymizeCustomerResponse,
  SlipFlagClearInput,
  SlipFlagResponse,
} from '@sds/shared';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { notFound } from '../errors.ts';
import { toOrderDto } from '../orders/dto.ts';
import type { SlipStore } from '../slips/store.ts';
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
  slips: SlipStore,
): Promise<AnonymizeCustomerResponse> {
  let slipKeys: string[] = [];
  const response = await withTransaction(ctx, async (tx, emit) => {
    const result = await customersRepo.anonymizeCustomer(tx, id, ctx.now());
    if (!result.found) throw notFound('Customer');
    const response = {
      id,
      anonymizedAt: result.anonymizedAt.toISOString(),
      version: result.version,
    };
    if (!result.changed) return response;
    const taken = await customersRepo.takeCustomerSlipKeys(tx, id);
    slipKeys = taken.keys;

    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      ip: meta.ip,
      action: 'customer.anonymize',
      entity: 'customers',
      entityId: id,
      after: {
        orders: result.orderIds.length,
        slips: slipKeys.length,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    emit(
      securityAlert(ctx, 'customer.anonymized', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
      }),
    );
    // Screens that hold these orders must not keep showing the name until their next catch-up.
    // ...and so must the ones whose "claimed, no slip" flag moved when their picture went.
    for (const orderId of new Set([...result.orderIds, ...taken.changedOrderIds])) {
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
  // The files go after the commit: a failed delete leaves a stray file, never a lost key.
  for (const key of slipKeys) await slips.delete(key).catch(() => undefined);
  return response;
}

// ---------- The slip flag (staff only) ----------

const flagResponse = (flag: customersRepo.SlipFlagRow | null): SlipFlagResponse => ({
  slipFlag: flag ? { at: flag.at.toISOString(), reason: 'fraud', count: flag.count } : null,
});

/** The customer's slip flag for staff (`customer.view`), or `{slipFlag: null}`. */
export async function getSlipFlag(ctx: AuthContext, id: string): Promise<SlipFlagResponse> {
  if (!(await customersRepo.customerExists(ctx.db, id))) throw notFound('Customer');
  return flagResponse(await customersRepo.getSlipFlag(ctx.db, id));
}

/**
 * The owner clears a customer's slip flag (`customer.slip_flag_clear`: owner only, step-up). The
 * typed reason goes to the audit row only (the history is kept there; the count stays on the
 * customer), the owner is alerted with ids only. Idempotent by `clientRequestId` (found in the
 * audit row); clearing a customer with no flag is a plain 200 that writes nothing.
 */
export async function clearSlipFlag(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: SlipFlagClearInput,
  meta: RequestMeta,
): Promise<SlipFlagResponse> {
  await withTransaction(ctx, async (tx, emit) => {
    if (!(await customersRepo.customerExists(tx, id))) throw notFound('Customer');
    if (await findAuditByRequestId(tx, 'customers', id, input.clientRequestId)) return;
    const before = await customersRepo.getSlipFlag(tx, id);
    if (!before) return;
    await customersRepo.clearSlipFlag(tx, id);
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      ip: meta.ip,
      action: 'customer.slip_flag_clear',
      entity: 'customers',
      entityId: id,
      before: { flaggedAt: before.at.toISOString(), count: before.count },
      after: { clientRequestId: input.clientRequestId, reason: input.reason },
    });
    emit(
      securityAlert(ctx, 'customer.slip_flag_cleared', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
      }),
    );
  });
  return flagResponse(await customersRepo.getSlipFlag(ctx.db, id));
}
