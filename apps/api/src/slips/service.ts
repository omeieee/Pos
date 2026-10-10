import { insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import type { MyOrder } from '@sds/shared';
import type { Principal, RequestMeta } from '../auth/service.ts';
import { claimPayment } from '../customer-app/service.ts';
import { ApiError, notFound } from '../errors.ts';
import type { CoreContext } from '../tx.ts';
import { MAX_SLIP_BYTES, type SlipMime, sniffSlip } from './image.ts';
import { newSlipKey, type SlipStore } from './store.ts';

/**
 * A transfer slip (D-24). It is a customer's "โอนแล้ว" with a picture: it makes the payment
 * `claimed` and nothing more. Staff look at the picture and still confirm by hand (rule 2).
 *
 * The file is stored first under a random key, then the claim and the key are written in ONE
 * transaction (`claimPayment`, the same function as the plain "โอนแล้ว"). If that fails the new
 * file is deleted; if it replaced an earlier slip, the old file is deleted after the commit.
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
  let order: MyOrder;
  try {
    order = await claimPayment(ctx, customerId, orderId, meta, {
      key,
      onReplaced: (oldKey) => replaced.add(oldKey),
    });
  } catch (error) {
    await slips.delete(key).catch(() => undefined);
    throw error;
  }
  for (const oldKey of replaced) await removeFile(slips, oldKey);
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

const slipNotFound = () => new ApiError(404, 'SLIP_NOT_FOUND', 'There is no slip for this payment');
