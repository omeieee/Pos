import { createHash } from 'node:crypto';
import { findAuditByRequestId, insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import type {
  MyOrder,
  OrderPaymentsResponse,
  SlipBlockClearInput,
  SlipRecheckInput,
  SlipVerifyVerdict,
} from '@sds/shared';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { claimPayment } from '../customer-app/service.ts';
import { ApiError, conflict, notFound, versionConflict } from '../errors.ts';
import type { AppEvent } from '../events.ts';
import { emitSlipReview, slipNeedsReview } from '../payments/alerts.ts';
import { toPaymentDto } from '../payments/dto.ts';
import { listOrderPayments } from '../payments/service.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { activeSlipChecker, type VerdictSnapshot } from './checker.ts';
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
 * When an automatic reading is on (the amount, D-26; the bank check, D-27) the payment is marked
 * `pending` for each in that same transaction and the reading is queued after the commit. It runs in the background: it can neither delay the
 * answer nor make the upload fail.
 */
export async function attachSlip(
  ctx: CoreContext,
  slips: SlipStore,
  customerId: string,
  orderId: string,
  bytes: Buffer,
  meta: RequestMeta,
  options: { autoConfirmBlocked?: boolean } = {},
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
      hash: createHash('sha256').update(bytes).digest('hex'),
      onReplaced: (oldKey) => replaced.add(oldKey),
      ocr: checker?.wants.ocr ?? false,
      verify: checker?.wants.verify ?? false,
      // D-40: the server never confirms this claim by itself; the checker still runs as a hint.
      ...(options.autoConfirmBlocked ? { autoConfirmBlocked: true } : {}),
    });
  } catch (error) {
    await slips.delete(key).catch(() => undefined);
    throw error;
  }
  for (const oldKey of replaced) await removeFile(slips, oldKey);
  if (checker && order.payment) checker.enqueue(order.payment.id);
  // No reading is running on this picture (no checker, or its checks are used up): it is staff's
  // to review right now. A running reading announces it when it ends (`slips/checker.ts`).
  if (order.payment) {
    const paid = await paymentsRepo.findPaymentById(ctx.db, order.payment.id);
    if (paid && slipNeedsReview(paid)) {
      const emit = (event: AppEvent) => ctx.events.publish(event);
      emitSlipReview(emit, { id: order.id, orderNo: order.orderNo }, paid);
    }
  }
  return order;
}

/**
 * Staff press "check again" on a claimed payment's slip (`POST /v1/payments/:id/slip-recheck`,
 * `payment.confirm`). It marks the bank check `pending` again (one transaction with the audit row
 * `payment.slip_recheck`, and `payment.upserted` after the commit), then runs the same checker:
 * the D-27 auto-confirm conditions are unchanged and still gated by SLIP_AUTOCONFIRM. Attempts
 * count against the picture's cap (3 automatic + 3 staff) and the day's Slip2Go cap.
 *
 * Idempotent by `clientRequestId`, found in the audit row under the locks (order, then payment):
 * a repeat answers the current view and calls nothing. Every refusal happens before any write, so
 * the verdict already on the payment is never lost to a check that could not be made.
 * Answers the order's payments view, the only answer that carries the verdict for staff.
 */
export async function recheckSlip(
  ctx: AuthContext,
  actor: Principal,
  paymentId: string,
  input: SlipRecheckInput,
  meta: RequestMeta,
): Promise<OrderPaymentsResponse> {
  const checker = activeSlipChecker();
  if (!checker?.wants.verify) {
    throw conflict('SLIP_VERIFIER_OFF', 'The bank check of slips is not switched on');
  }
  const probe = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!probe) throw notFound('Payment');
  /** What the payment had before it was cleared for the check; set when this request started one. */
  let previous: VerdictSnapshot | null = null;
  const started = await withTransaction(ctx, async (tx, emit) => {
    const order = await ordersRepo.lockOrderById(tx, probe.orderId);
    if (!order) throw notFound('Order');
    const row = await paymentsRepo.lockPaymentById(tx, paymentId);
    if (!row) throw notFound('Payment');
    if (await findAuditByRequestId(tx, 'payments', row.id, input.clientRequestId)) return false;
    if (row.status !== 'claimed') {
      throw conflict('PAYMENT_NOT_CLAIMED', 'Only a claimed payment has a slip to check', {
        status: row.status,
      });
    }
    if (!row.slipImageKey || !row.slipImageHash) {
      throw conflict('NO_SLIP', 'This payment has no slip picture to check');
    }
    if (row.slipVerify === 'pending') {
      throw conflict('SLIP_CHECK_RUNNING', 'The bank check of this slip is still running');
    }
    // The owner reviewed this very picture by hand and lifted the block: asking the bank again
    // would only raise the block and the flag the owner just cleared. A new picture can be checked.
    if (row.slipReviewedAt !== null) {
      throw conflict('SLIP_REVIEWED', 'The owner already reviewed this slip by hand');
    }
    // A slip the bank already confirmed has nothing to check again.
    if (row.slipVerify === 'valid') {
      throw conflict('SLIP_ALREADY_VALID', 'The bank check of this slip already passed');
    }
    const blocked = await checker.recheckBlocker(row, tx);
    if (blocked === 'attempts') {
      throw new ApiError(
        429,
        'SLIP_RECHECK_LIMIT',
        'This slip has been checked as often as allowed',
      );
    }
    if (blocked === 'cap') {
      throw new ApiError(429, 'SLIP2GO_DAILY_CAP', "Today's bank checks are used up. Try tomorrow");
    }
    const updated = await paymentsRepo.updatePaymentIfVersion(tx, row.id, row.version, {
      slipVerify: 'pending',
      slipVerifyCode: null,
      slipVerifyRef: null,
      slipVerifiedAt: null,
    });
    if (!updated) throw versionConflict(row.version);
    previous = {
      verdict: row.slipVerify as SlipVerifyVerdict | null,
      code: row.slipVerifyCode,
      ref: row.slipVerifyRef,
      at: row.slipVerifiedAt,
    };
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'payment.slip_recheck',
      entity: 'payments',
      entityId: row.id,
      before: { slipVerify: row.slipVerify, attempts: row.slipVerifyAttempts },
      after: { clientRequestId: input.clientRequestId, slipVerify: 'pending' },
      ip: meta.ip,
    });
    emit({
      type: 'payment.upserted',
      id: updated.id,
      rev: updated.rev,
      data: toPaymentDto(updated),
    });
    return true;
  });
  if (started && previous) await checker.recheck(paymentId, previous);
  return listOrderPayments(ctx, probe.orderId);
}

/**
 * The owner lifts the slip block of an order (`POST /v1/payments/:id/slip-block/clear`,
 * `payment.slip_block_clear`: owner only, step-up). Every payment of the order that carries the
 * block is released, a payment whose verdict is `fraud` is put back to `unchecked` (the earlier
 * verdict stays in the audit row) and marked reviewed, so staff confirm it by hand as usual. The
 * customer's slip flag is NOT touched: that is its own owner action. One transaction with the audit
 * row (the typed reason, which is only ever in the audit log) and the owner alert; `payment.upserted`
 * goes out after the commit. Idempotent by `clientRequestId`, found in the audit row under the locks.
 * Answers the order's payments view.
 */
export async function clearSlipBlock(
  ctx: AuthContext,
  actor: Principal,
  paymentId: string,
  input: SlipBlockClearInput,
  meta: RequestMeta,
): Promise<OrderPaymentsResponse> {
  const probe = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!probe) throw notFound('Payment');
  await withTransaction(ctx, async (tx, emit) => {
    const order = await ordersRepo.lockOrderById(tx, probe.orderId);
    if (!order) throw notFound('Order');
    const row = await paymentsRepo.lockPaymentById(tx, paymentId);
    if (!row) throw notFound('Payment');
    if (await findAuditByRequestId(tx, 'payments', row.id, input.clientRequestId)) return;
    const blocked = (await paymentsRepo.listPaymentsForOrder(tx, order.id)).filter(
      (p) => p.slipBlockedAt !== null,
    );
    if (blocked.length === 0) {
      throw conflict('SLIP_NOT_BLOCKED', 'No slip block is set on this order');
    }
    const now = ctx.now();
    for (const payment of blocked) {
      const fraud = payment.slipVerify === 'fraud';
      const updated = await paymentsRepo.updatePaymentIfVersion(tx, payment.id, payment.version, {
        slipBlockedAt: null,
        slipBlockReason: null,
        slipReviewedAt: now,
        ...(fraud ? { slipVerify: 'unchecked', slipVerifyCode: null } : {}),
      });
      if (!updated) throw versionConflict(payment.version);
      emit({
        type: 'payment.upserted',
        id: updated.id,
        rev: updated.rev,
        data: toPaymentDto(updated),
      });
    }
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'payment.slip_block_clear',
      entity: 'payments',
      entityId: row.id,
      before: { verdict: row.slipVerify, blockedPayments: blocked.length },
      after: { clientRequestId: input.clientRequestId, reason: input.reason },
      ip: meta.ip,
    });
    emit(
      securityAlert(ctx, 'payment.slip_block_cleared', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
        subject: { paymentId: row.id, orderId: order.id },
      }),
    );
  });
  return listOrderPayments(ctx, probe.orderId);
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
