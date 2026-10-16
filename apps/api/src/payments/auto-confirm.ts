/**
 * Payments: the automatic confirmation after a valid bank check (D-27).
 */
import { customersRepo, type Db, insertAudit, type ordersRepo, paymentsRepo } from '@sds/db';
import { paymentMachine } from '@sds/shared';
import { securityAlert } from '../auth/service.ts';
import { versionConflict } from '../errors.ts';
import { orderSlipBlocked } from '../slips/guard.ts';
import type { CoreContext, Emit } from '../tx.ts';
import { emitPayment, settleOrder } from './internal.ts';

// ---------- Automatic confirmation after a valid bank check (D-27) ----------

/** What the slip checker hands over for an automatic confirmation. */
export interface AutoConfirmInput {
  /** The order, locked by the caller (order lock first, then the payment). */
  order: ordersRepo.OrderRow;
  /** The payment, locked by the caller, as it is in the database right now. */
  payment: paymentsRepo.PaymentRow;
  /** What the checker writes to the payment anyway (the verdict and the duplicate keys). */
  patch: paymentsRepo.PaymentPatch;
  /** Slip2Go's `referenceId` and result code, for the audit row. */
  referenceId: string | null;
  code: string;
  /** SLIP_AUTOCONFIRM_MAX_SATANG. */
  maxSatang: number;
  /** Told which condition said no (a fixed word, never data), for the log. */
  refused?: (reason: string) => void;
}

/**
 * CLAUDE.md rule 2 as amended by D-27: the server itself moves a `claimed` PromptPay payment to
 * `confirmed`, and only when the caller has already established that Slip2Go answered 200200 to a
 * call that carried the receiver, this payment's amount and the date, and that the amount it
 * reports equals the payment's. This function adds the rest and re-checks under the locks:
 * the payment is still `claimed`, it is PromptPay, it is within the ceiling, no other payment has
 * used this slip (image, reference or QR key), and the payment machine allows the `system` actor.
 *
 * Same path as a staff confirm: one transaction (the caller's), the sync trigger bumps version and
 * rev, the order's payment status is settled, and the events go out after the commit. The audit
 * row holds only the reference, the code and the amount in satang. Returns the updated payment, or
 * null when any condition fails; then nothing was written and the caller saves its plain patch.
 */
export async function autoConfirmClaimedPayment(
  ctx: Pick<CoreContext, 'now'>,
  tx: Db,
  emit: Emit,
  input: AutoConfirmInput,
): Promise<paymentsRepo.PaymentRow | null> {
  const { order, payment, patch } = input;
  const no = (reason: string): null => {
    input.refused?.(reason);
    return null;
  };
  if (payment.status !== 'claimed' || payment.method !== 'promptpay')
    return no('not_claimed_promptpay');
  if (payment.amountSatang > input.maxSatang) return no('over_ceiling');
  // Never for a slip-blocked order or a slip-flagged customer: staff confirm those by hand.
  if (orderSlipBlocked(await paymentsRepo.listPaymentsForOrder(tx, order.id)))
    return no('order_blocked');
  if (order.customerId && (await customersRepo.getSlipFlag(tx, order.customerId)))
    return no('customer_flagged');
  if (!paymentMachine.transition('claimed', 'confirmed', { actor: { kind: 'system' } }).ok) {
    return no('machine');
  }
  // A machine confirmation needs the transfer's own key (D-27): without it two photos of one
  // transfer could not be told apart.
  if ((patch.slipQrHash !== undefined ? patch.slipQrHash : payment.slipQrHash) == null)
    return no('no_transfer_key');
  // Any other payment that used this slip counts, in any status and earlier or later (D-27): two
  // photos of one transfer must not both confirm, whichever is checked first, and a cancelled or
  // voided one may have been a reused slip.
  const earlier = await paymentsRepo.findOtherSlipUse(tx, {
    id: payment.id,
    slipImageHash: payment.slipImageHash,
    slipRefHash: patch.slipRefHash !== undefined ? patch.slipRefHash : payment.slipRefHash,
    slipQrHash: patch.slipQrHash !== undefined ? patch.slipQrHash : payment.slipQrHash,
  });
  if (earlier) return no('slip_used_elsewhere');
  const updated = await paymentsRepo.updatePaymentIfVersion(tx, payment.id, payment.version, {
    ...patch,
    status: 'confirmed',
    confirmedAt: ctx.now(),
    autoConfirmed: true,
  });
  if (!updated) throw versionConflict(payment.version); // cannot happen under the row lock
  await insertAudit(tx, {
    actorType: 'system',
    action: 'payment.auto_confirm',
    entity: 'payments',
    entityId: payment.id,
    after: {
      referenceId: input.referenceId,
      code: input.code,
      amountSatang: payment.amountSatang,
    },
  });
  emitPayment(emit, updated);
  await settleOrder(tx, order, emit);
  emit(
    securityAlert(ctx, 'payment.auto_confirmed', 'info', {
      subject: { paymentId: payment.id, orderId: order.id },
    }),
  );
  return updated;
}
