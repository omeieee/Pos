import { insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import type { MyOrder } from '@sds/shared';
import type { Principal, RequestMeta } from '../auth/service.ts';
import { claimPayment } from '../customer-app/service.ts';
import { ApiError, notFound } from '../errors.ts';
import type { CoreContext } from '../tx.ts';
import { activeSlipChecker } from './checker.ts';
import { MAX_SLIP_BYTES, type SlipMime, sniffSlip } from './image.ts';
import { newSlipKey, type SlipStore } from './store.ts';

/**
 * A transfer slip (D-24). It is a customer's "โอนแล้ว" with a picture: it makes the payment
 * `claimed` and nothing more. Staff look at the picture and still confirm by hand (rule 2).
 *
 * The file is stored first under a random key, then the claim and the key are written in ONE
 * transaction (`claimPayment`, the same function as the plain "โอนแล้ว"). If that fails the new
 * file is deleted; if it replaced an earlier slip, the old file is deleted after the commit.
 *
 * When the automatic reading is on (D-26) the payment is marked `pending` in that same transaction
 * and the reading is queued after the commit. It runs in the background: it can neither delay the
 * answer nor make the upload fail.
 */
export async function attachSlip(
  ctx: CoreContext,
  slips: SlipStore,
  customerId: string,
  orderId: string,
  bytes: Buffer,
  meta: RequestMeta,
): Promise<MyOrder> {
  checkSlipBytes(bytes);
  // Somebody else's order is a plain 404, and nothing is written for it.
  if (!(await ordersRepo.findOrderForCustomer(ctx.db, customerId, orderId))) {
    throw notFound('Order');
  }
  const key = newSlipKey();
  await slips.put(key, bytes);
  const replaced = new Set<string>();
  const checker = activeSlipChecker();
  let order: MyOrder;
  try {
    order = await claimPayment(ctx, customerId, orderId, meta, {
      key,
      onReplaced: (oldKey) => replaced.add(oldKey),
      read: checker !== null,
    });
  } catch (error) {
    await slips.delete(key).catch(() => undefined);
    throw error;
  }
  for (const oldKey of replaced) await removeFile(slips, oldKey);
  if (checker && order.payment) checker.enqueue(order.payment.id);
  return order;
}

/** Size and magic bytes, whatever the client called the file. */
export function checkSlipBytes(bytes: Buffer): SlipMime {
  if (bytes.length > MAX_SLIP_BYTES) {
    throw new ApiError(413, 'SLIP_TOO_LARGE', 'The picture is larger than 5 MB');
  }
  const mime = sniffSlip(bytes);
  if (!mime) {
    throw new ApiError(415, 'SLIP_TYPE_UNSUPPORTED', 'Send a JPEG, PNG or WebP picture');
  }
  return mime;
}

/** A file that will not go is tried once more; the key is already off the payment, so it is the last chance. */
async function removeFile(slips: SlipStore, key: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await slips.delete(key);
      return;
    } catch {
      // try again, then give up: the customer's answer must not fail for a leftover file
    }
  }
}

/**
 * The slip of a payment, for staff (`payment.record`). Every look writes an audit row (who, which
 * payment; never the key or the picture), because a slip shows a customer's bank details.
 */
export async function readSlip(
  ctx: CoreContext,
  slips: SlipStore,
  actor: Principal,
  paymentId: string,
  meta: RequestMeta,
): Promise<{ bytes: Buffer; contentType: SlipMime }> {
  const payment = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!payment?.slipImageKey) throw slipNotFound();
  const bytes = await slips.get(payment.slipImageKey);
  const contentType = bytes ? sniffSlip(bytes) : null;
  if (!bytes || !contentType) throw slipNotFound();
  await insertAudit(ctx.db, {
    actorType: 'staff',
    actorId: actor.staffId,
    deviceId: actor.deviceId,
    action: 'payment.slip.view',
    entity: 'payments',
    entityId: payment.id,
    ip: meta.ip,
  });
  return { bytes, contentType };
}

/**
 * The customer's own slip for an order: the picture they sent for the payment that is waiting (or,
 * failing that, the latest that has one). Somebody else's order is the same 404 as no slip. It is
 * theirs to look at again, so there is no audit row (staff views are audited: they see others'
 * slips). The automatic reading is not part of this answer, in any form.
 */
export async function readOwnSlip(
  ctx: CoreContext,
  slips: SlipStore,
  customerId: string,
  orderId: string,
): Promise<{ bytes: Buffer; contentType: SlipMime }> {
  if (!(await ordersRepo.findOrderForCustomer(ctx.db, customerId, orderId))) {
    throw notFound('Order');
  }
  const payments = await paymentsRepo.listPaymentsForOrder(ctx.db, orderId);
  const held =
    payments.find((p) => p.slipImageKey && (p.status === 'pending' || p.status === 'claimed')) ??
    [...payments].reverse().find((p) => p.slipImageKey);
  if (!held?.slipImageKey) throw slipNotFound();
  const bytes = await slips.get(held.slipImageKey);
  const contentType = bytes ? sniffSlip(bytes) : null;
  if (!bytes || !contentType) throw slipNotFound();
  return { bytes, contentType };
}

const slipNotFound = () => new ApiError(404, 'SLIP_NOT_FOUND', 'There is no slip for this payment');
