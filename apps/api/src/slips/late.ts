import { createHash } from 'node:crypto';
import { insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import type { RequestMeta } from '../auth/service.ts';
import { notFound, versionConflict } from '../errors.ts';
import { emitPayment } from '../payments/internal.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { localSlipQrHash } from './checker.ts';
import { slipUploadRefusal } from './guard.ts';
import { checkSlipBytes } from './service.ts';
import { newSlipKey, type SlipStore } from './store.ts';

/** How long after the timeout a late slip is still kept for staff (D-41). */
export const LATE_SLIP_WINDOW_MS = 24 * 3_600_000;

/**
 * D-41: a slip that arrives for an order the unpaid timeout already cancelled is kept for staff,
 * not dropped. The order is never reopened and the payment is not claimed: a cancelled payment
 * cannot move (the payment machine), so the picture is written onto that cancelled PromptPay
 * payment as `unchecked` with auto-confirm blocked, and staff are told with `alert.payment
 * slip_review`. No bank check or amount reading runs (no Slip2Go call is spent), so nothing can
 * confirm it. Staff see the picture through the usual slip view and settle it by hand (a new
 * order or a refund). One transaction under the order lock; the same picture twice is a no-op
 * (chat events are retried). The file is deleted again if the write fails. The slip's own QR is
 * read locally and stored, and the row stays visible to duplicate detection (`slipAutoconfirmBlocked`
 * marks it, see `findEarlierSlipUse` and `findOtherSlipUse`): the same transfer sent again for another
 * order is never confirmed by the machine and shows "used on #…" to staff.
 * Returns the order's number, or null when there is no payment to keep it on.
 */
export async function keepLateSlip(
  ctx: CoreContext,
  slips: SlipStore,
  customerId: string,
  orderId: string,
  bytes: Buffer,
  meta: RequestMeta,
): Promise<{ orderNo: string } | null> {
  checkSlipBytes(bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  // The slip's own QR, read here for free (no bank call): with the picture hash it is what lets a
  // later claim of the same transfer on another order be seen as a duplicate (D-26, D-27).
  const qrHash = await localSlipQrHash(bytes);
  const key = newSlipKey();
  await slips.put(key, bytes);
  let replaced = null as string | null;
  let kept = false;
  try {
    const result = await withTransaction(ctx, async (tx, emit) => {
      const order = await ordersRepo.lockOrderById(tx, orderId);
      if (!order || order.customerId !== customerId) throw notFound('Order');
      if (order.status !== 'cancelled' || order.cancelReason !== 'unpaid_timeout') return null;
      const payments = await paymentsRepo.listPaymentsForOrder(tx, order.id);
      const target = [...payments]
        .reverse()
        .find((p) => p.method === 'promptpay' && p.status === 'cancelled');
      if (!target) return null;
      if (target.slipImageHash === hash) return { orderNo: order.orderNo, wrote: false };
      const refusal = slipUploadRefusal(payments, ctx.now());
      if (refusal) throw refusal;
      const locked = await paymentsRepo.lockPaymentById(tx, target.id);
      if (!locked) throw notFound('Payment');
      const updated = await paymentsRepo.updatePaymentIfVersion(tx, locked.id, locked.version, {
        slipImageKey: key,
        slipImageHash: hash,
        slipCheck: null,
        slipAmountSatang: null,
        slipRefHash: null,
        slipQrHash: qrHash,
        slipRecipientCheck: null,
        slipVerify: 'unchecked',
        slipVerifyCode: null,
        slipVerifyRef: null,
        slipVerifiedAt: null,
        slipUploadedAt: ctx.now(),
        slipAutoconfirmBlocked: true,
      });
      if (!updated) throw versionConflict(locked.version); // cannot happen under the locks
      replaced = locked.slipImageKey;
      await insertAudit(tx, {
        actorType: 'customer',
        actorId: customerId,
        ip: meta.ip,
        action: 'payment.late_slip',
        entity: 'payments',
        entityId: locked.id,
        after: { orderId: order.id },
      });
      emitPayment(emit, updated);
      emit({
        type: 'alert.payment',
        orderId: order.id,
        orderNo: order.orderNo,
        kind: 'slip_review',
      });
      return { orderNo: order.orderNo, wrote: true };
    });
    kept = result?.wrote === true;
    return result ? { orderNo: result.orderNo } : null;
  } finally {
    if (!kept) await slips.delete(key).catch(() => undefined);
    else if (replaced) await slips.delete(replaced).catch(() => undefined);
  }
}
