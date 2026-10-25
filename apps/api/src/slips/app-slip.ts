import { createHash } from 'node:crypto';
import { ordersRepo } from '@sds/db';
import { allocateSlip, type MyOrder, ORDER_REASONS, type SlipNeedsCombine } from '@sds/shared';
import type { RequestMeta } from '../auth/service.ts';
import { derivedRequestId, viewOrder } from '../customer-app/service.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { mergeOrders } from '../orders/customer-edit.ts';
import type { CoreContext } from '../tx.ts';
import { openPromptpayCandidates, slipFree, toSlipCandidate } from './allocate.ts';
import { activeSlipChecker } from './checker.ts';
import { keepLateSlip, LATE_SLIP_WINDOW_MS } from './late.ts';
import { attachSlip, checkSlipBytes } from './service.ts';
import type { SlipStore } from './store.ts';

/** `?combine=1` merges the customer's other open orders into this one; `?review=1` sends it to staff. */
export interface AppSlipMode {
  combine: boolean;
  review: boolean;
}

/**
 * The customer app's slip upload (D-40). Normally the picture is attached to the order in the URL.
 * When the customer has other open PromptPay orders and the amount read locally is not this order's
 * due but equals this order plus all the others that can merge with it, NOTHING is stored and the
 * answer is 409 `NEEDS_COMBINE` (`details` match `slipNeedsCombineSchema`). The app then asks:
 * `combine` merges those orders into THIS one (it stays the target) and attaches the picture;
 * `review` attaches it with auto-confirm blocked (staff confirm by hand). The local amount only
 * chooses; auto-confirm stays the D-27 bank check on the final payment's own amount. Without a
 * local reader the amount is unknown and the picture is attached as before.
 */
export async function attachAppSlip(
  ctx: CoreContext,
  slips: SlipStore,
  customerId: string,
  orderId: string,
  bytes: Buffer,
  meta: RequestMeta,
  mode: AppSlipMode,
): Promise<MyOrder> {
  checkSlipBytes(bytes);
  const order = await ordersRepo.findOrderForCustomer(ctx.db, customerId, orderId);
  if (!order) throw notFound('Order');
  // D-41: an order the unpaid timeout cancelled in the last day keeps a late slip for staff.
  if (
    order.status === 'cancelled' &&
    order.cancelReason === ORDER_REASONS.unpaid_timeout &&
    order.cancelledAt !== null &&
    ctx.now().getTime() - order.cancelledAt.getTime() <= LATE_SLIP_WINDOW_MS
  ) {
    if (await keepLateSlip(ctx, slips, customerId, orderId, bytes, meta)) {
      const fresh = await ordersRepo.findOrderForCustomer(ctx.db, customerId, orderId);
      return viewOrder(ctx, fresh ?? order);
    }
  }
  if (mode.review) {
    return attachSlip(ctx, slips, customerId, orderId, bytes, meta, { autoConfirmBlocked: true });
  }

  const candidates = await openPromptpayCandidates(ctx.db, customerId);
  const mine = candidates.find((c) => c.order.id === orderId);
  const others = slipFree(candidates).filter((c) => c.order.id !== orderId);
  if (!mine || mine.payment.slipImageKey !== null || others.length === 0) {
    if (mode.combine) {
      throw conflict(
        'COMBINE_NOT_APPLICABLE',
        'There are no other orders to combine with this one',
      );
    }
    return attachSlip(ctx, slips, customerId, orderId, bytes, meta);
  }

  const amount = (await activeSlipChecker()?.readLocalAmount(bytes)) ?? null;
  const plan = allocateSlip(amount, [toSlipCandidate(mine), ...others.map(toSlipCandidate)]);
  if (plan.kind !== 'merge' || amount === null) {
    if (mode.combine) {
      throw conflict('COMBINE_NOT_APPLICABLE', 'This slip does not match these orders together');
    }
    return attachSlip(ctx, slips, customerId, orderId, bytes, meta);
  }
  if (!mode.combine) {
    const ordered = [mine, ...others.filter((c) => plan.sourceIds.includes(c.order.id))];
    const details: SlipNeedsCombine = {
      orderNos: ordered.map((c) => c.order.orderNo),
      orderIds: ordered.map((c) => c.order.id),
      totalSatang: amount,
    };
    throw new ApiError(
      409,
      'NEEDS_COMBINE',
      'This transfer pays several orders. Combine them?',
      details,
    );
  }
  const seed = `${orderId}:${createHash('sha256').update(bytes).digest('hex')}`;
  await mergeOrders(
    ctx,
    { kind: 'customer', customerId },
    orderId,
    plan.sourceIds,
    undefined,
    {
      idempotencyKey: derivedRequestId(`app-slip-combine:${seed}`),
      paymentRequestId: derivedRequestId(`app-slip-combine-payment:${seed}`),
    },
    meta,
  );
  return attachSlip(ctx, slips, customerId, orderId, bytes, meta);
}
