/**
 * Payments: what an order cancel, an owner retire and an owner adjust do to the payments.
 */
import { type Db, type ordersRepo, paymentsRepo } from '@sds/db';
import {
  type AdjustRefundInput,
  derivePaymentStatus,
  type OrderPaymentStatus,
  type PastOrderPaymentAction,
  type PaymentStatus,
  paymentMachine,
  planAdjustment,
  satang,
} from '@sds/shared';
import {
  hasFreshStepUp,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { conflict, stepUpRequired, versionConflict } from '../errors.ts';
import type { CoreContext, Emit } from '../tx.ts';
import {
  amountsOf,
  auditPayment,
  claimWithoutSlipOf,
  emitPayment,
  moneyOf,
  refundedBy,
  snapshot,
  transitionFailure,
  unprocessable,
} from './internal.ts';

// ---------- Cancelling an order (called from orders/service.ts) ----------

/**
 * An order is being cancelled. Under the order lock the caller already holds: refuse if a payment
 * is claimed or confirmed (cancel-claimed or a manager void comes first), otherwise cancel the
 * pending ones through the machine's system transition. Returns the order's new payment status
 * for the caller to write in the same update.
 */
export async function settlePaymentsForOrderCancel(
  tx: Db,
  order: ordersRepo.OrderRow,
  emit: Emit,
): Promise<OrderPaymentStatus> {
  const all = await paymentsRepo.listPaymentsForOrder(tx, order.id);
  const blocking = all.find((p) => p.status === 'claimed' || p.status === 'confirmed');
  if (blocking) {
    throw conflict(
      'ORDER_HAS_PAYMENT',
      'This order has a payment that was claimed or confirmed. Cancel the claim or void the payment first',
      { paymentId: blocking.id, status: blocking.status },
    );
  }
  const after: paymentsRepo.PaymentRow[] = [];
  for (const payment of all) {
    if (payment.status !== 'pending') {
      after.push(payment);
      continue;
    }
    const move = paymentMachine.transition('pending', 'cancelled', { actor: { kind: 'system' } });
    if (!move.ok) throw transitionFailure(move.error, 'pending', 'cancelled');
    const cancelled = await paymentsRepo.updatePaymentIfVersion(tx, payment.id, payment.version, {
      status: 'cancelled',
    });
    if (!cancelled) throw versionConflict(payment.version); // cannot happen under the order lock
    emitPayment(emit, cancelled);
    after.push(cancelled);
  }
  return derivePaymentStatus(satang(order.totalSatang), amountsOf(after));
}

/**
 * An owner's correction or void of a past order (decision 2026-10-11) puts every payment of the
 * order out of play, in the caller's transaction and through the same state machine and audit as a
 * manual move: pending and claimed payments are cancelled, a confirmed one is voided or refunded
 * (`action`, the owner's explicit choice: a refund says the money went back). Voids and refunds
 * need a fresh step-up, write an audit row and alert the owner, exactly as `movePayment` does.
 * Returns the order's payment status afterwards. Nothing is created: staff collect any new total
 * through the normal payment flow.
 */
export async function retirePaymentsForOwnerChange(
  tx: Db,
  ctx: Pick<CoreContext, 'now'>,
  actor: Principal,
  order: ordersRepo.OrderRow,
  reason: string,
  action: PastOrderPaymentAction | undefined,
  emit: Emit,
  meta: RequestMeta,
): Promise<{
  paymentStatus: OrderPaymentStatus;
  claimWithoutSlip: boolean;
  refundedSatang: number;
}> {
  const { rows: all, refunds } = await moneyOf(tx, order.id);
  const returnedEarlier = refundedBy(refunds);
  let refundedSatang = 0;
  if (all.some((p) => p.status === 'confirmed') && action === undefined) {
    throw conflict(
      'PAYMENT_ACTION_REQUIRED',
      'A payment was confirmed. Say whether to void or refund it',
    );
  }
  const after: paymentsRepo.PaymentRow[] = [];
  for (const payment of all) {
    const to: PaymentStatus | null =
      payment.status === 'pending' || payment.status === 'claimed'
        ? 'cancelled'
        : payment.status === 'confirmed'
          ? action === 'refund'
            ? 'refunded'
            : 'voided'
          : null;
    if (to === null) {
      after.push(payment);
      continue;
    }
    const result = paymentMachine.transition(payment.status as PaymentStatus, to, {
      actor: { kind: 'staff', role: actor.role },
      reason,
    });
    if (!result.ok) throw transitionFailure(result.error, payment.status, to);
    if (result.stepUp && !hasFreshStepUp(actor, ctx.now())) throw stepUpRequired();
    const updated = await paymentsRepo.updatePaymentIfVersion(tx, payment.id, payment.version, {
      status: to,
      voidReason: reason,
    });
    if (!updated) throw versionConflict(payment.version); // cannot happen under the order lock
    const audit =
      to === 'voided' ? 'payment.void' : to === 'refunded' ? 'payment.refund' : 'payment.cancel';
    // A refund after partial refunds returns only what is left on the payment (D-25).
    const earlier = returnedEarlier.get(payment.id) ?? 0;
    if (to === 'refunded') refundedSatang += payment.amountSatang - earlier;
    await auditPayment(tx, actor, meta, audit, payment.id, snapshot(payment), {
      status: to,
      reason,
      ...(to === 'refunded'
        ? { returnedSatang: payment.amountSatang - earlier, refundedEarlierSatang: earlier }
        : {}),
    });
    if (to === 'voided' || to === 'refunded') {
      emit(
        securityAlert(ctx, `payment.${to}`, 'critical', {
          staffId: actor.staffId,
          deviceId: actor.deviceId,
          subject: { paymentId: payment.id, orderId: order.id },
        }),
      );
    }
    emitPayment(emit, updated);
    after.push(updated);
  }
  return {
    paymentStatus: derivePaymentStatus(satang(order.totalSatang), amountsOf(after)),
    claimWithoutSlip: claimWithoutSlipOf(after),
    refundedSatang,
  };
}

/** What an owner's `adjust` did to the money, for the customer's notice and the caller's audit. */
export interface AdjustOutcome {
  paymentStatus: OrderPaymentStatus;
  /** Returned to the customer now (a lower total). */
  refundedSatang: number;
  /** Still to collect through the normal payment flow (a higher total). */
  dueSatang: number;
}

const ADJUST_BLOCKS = {
  claim_open: [
    'ADJUST_CLAIM_OPEN',
    'A payment is claimed. Confirm it or cancel the claim first, then adjust',
  ],
  total_zero: ['ADJUST_TOTAL_ZERO', 'The new total is zero. Void or refund the order instead'],
  method_not_adjustable: [
    'ADJUST_METHOD_NOT_ADJUSTABLE',
    'The money to return was paid by a method that cannot be partly refunded. Refund it whole instead',
  ],
} as const;

/**
 * Partial adjustment of a paid order (D-25), in the caller's transaction, for the order's NEW total:
 * pending payments are cancelled (their amount is stale); confirmed money stays where it is.
 * A lower total records a partial refund of the exact difference (`refund` says how it went back);
 * a higher total creates nothing: staff take the difference with the normal payment flow, which
 * charges `total - netPaid`. The payment stays `confirmed`, so the state machine is not involved in
 * the money itself; who may do it is the machine's own `confirmed -> refunded` rule (manager/owner,
 * reason, step-up), asked as a probe so the permission cannot drift from a whole refund.
 */
export async function adjustPaymentsForOwnerChange(
  tx: Db,
  ctx: Pick<CoreContext, 'now'>,
  actor: Principal,
  order: ordersRepo.OrderRow,
  newTotal: number,
  reason: string,
  refund: AdjustRefundInput | undefined,
  emit: Emit,
  meta: RequestMeta,
): Promise<AdjustOutcome> {
  const { rows: all, refunds, amounts } = await moneyOf(tx, order.id);
  const plan = planAdjustment(satang(newTotal), amounts);
  if (plan.kind === 'blocked') {
    const [code, message] = ADJUST_BLOCKS[plan.reason];
    throw conflict(code, message);
  }
  if (plan.kind !== 'refund' && refund !== undefined) {
    throw unprocessable('REFUND_NOT_NEEDED', 'The new total does not need a refund');
  }
  if (plan.kind === 'refund') {
    if (refund === undefined) {
      throw unprocessable(
        'REFUND_DETAILS_REQUIRED',
        'The total goes down: say how the difference is returned (cash or PromptPay)',
        { refundSatang: plan.amountSatang },
      );
    }
    const probe = paymentMachine.transition('confirmed', 'refunded', {
      actor: { kind: 'staff', role: actor.role },
      reason,
    });
    if (!probe.ok) throw transitionFailure(probe.error, 'confirmed', 'refunded');
    if (probe.stepUp && !hasFreshStepUp(actor, ctx.now())) throw stepUpRequired();
  }

  const after = [...all];
  for (const [i, payment] of all.entries()) {
    if (payment.status !== 'pending') continue;
    const move = paymentMachine.transition('pending', 'cancelled', {
      actor: { kind: 'staff', role: actor.role },
      reason,
    });
    if (!move.ok) throw transitionFailure(move.error, 'pending', 'cancelled');
    const cancelled = await paymentsRepo.updatePaymentIfVersion(tx, payment.id, payment.version, {
      status: 'cancelled',
      voidReason: reason,
    });
    if (!cancelled) throw versionConflict(payment.version); // cannot happen under the order lock
    await auditPayment(tx, actor, meta, 'payment.cancel', payment.id, snapshot(payment), {
      status: 'cancelled',
      reason,
    });
    emitPayment(emit, cancelled);
    after[i] = cancelled;
  }

  const added: paymentsRepo.RefundRow[] = [];
  if (plan.kind === 'refund' && refund !== undefined) {
    for (const part of plan.allocations) {
      const row = await paymentsRepo.insertRefund(tx, {
        orderId: order.id,
        paymentId: part.paymentId,
        amountSatang: part.amountSatang,
        method: refund.method,
        referenceNote: refund.referenceNote ?? null,
        reason,
        refundedByStaffId: actor.staffId,
      });
      added.push(row);
      await auditPayment(
        tx,
        actor,
        meta,
        'payment.partial_refund',
        part.paymentId,
        { orderTotalSatang: order.totalSatang },
        {
          refundId: row.id,
          amountSatang: part.amountSatang,
          method: refund.method,
          reason,
          newOrderTotalSatang: newTotal,
        },
      );
      emit(
        securityAlert(ctx, 'payment.partial_refund', 'critical', {
          staffId: actor.staffId,
          deviceId: actor.deviceId,
          subject: { paymentId: part.paymentId, orderId: order.id },
        }),
      );
    }
  }

  const paymentStatus = derivePaymentStatus(
    satang(newTotal),
    amountsOf(after, [...refunds, ...added]),
  );
  return {
    paymentStatus,
    refundedSatang: plan.kind === 'refund' ? plan.amountSatang : 0,
    dueSatang: plan.kind === 'topup' ? plan.amountSatang : 0,
  };
}
