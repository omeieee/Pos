/**
 * Payments: the status moves (claim, confirm, cancel-claimed, void, refund).
 */
import { ordersRepo, paymentsRepo } from '@sds/db';
import {
  estimateGovCopaySplit,
  type Fulfillment,
  type PaymentResult,
  type PaymentStatus,
  paymentMachine,
  satang,
} from '@sds/shared';
import { hasFreshStepUp, type RequestMeta, securityAlert } from '../auth/service.ts';
import { forbidden, notFound, stepUpRequired, versionConflict } from '../errors.ts';
import { slipUploadRefusal } from '../slips/guard.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { toPaymentDto } from './dto.ts';
import {
  actorOf,
  assertOwns,
  auditPayment,
  claimWithoutSlipOf,
  emitPayment,
  isCustomer,
  offeredCopay,
  orderDto,
  type PaymentActor,
  settleOrder,
  snapshot,
  staffOf,
  transitionFailure,
  unprocessable,
} from './internal.ts';
import { slipPatch } from './slip-patch.ts';

// ---------- Moves: claim, confirm, cancel-claimed, void, refund ----------

export type PaymentMove = 'claim' | 'confirm' | 'cancel-claimed' | 'void' | 'refund';

const MOVES: Record<PaymentMove, { to: PaymentStatus; from?: PaymentStatus; audit?: string }> = {
  claim: { to: 'claimed' },
  confirm: { to: 'confirmed', audit: 'payment.confirm' },
  // pending -> cancelled exists in the machine for method changes; this route is for claimed ones.
  'cancel-claimed': { to: 'cancelled', from: 'claimed', audit: 'payment.cancel_claimed' },
  void: { to: 'voided', audit: 'payment.void' },
  refund: { to: 'refunded', audit: 'payment.refund' },
};

export interface MoveInput {
  expectedVersion?: number | undefined;
  reason?: string | undefined;
  referenceNote?: string | undefined;
  /** Confirm only: staff ticked "I checked the bank app" (D-26). Audited, never a gate. */
  attestedBankCheck?: true | undefined;
  /**
   * Claim only: the customer's slip image, already stored under `key`. It is written in the same
   * transaction as the claim (or, on a payment that is already claimed, replaces the old slip).
   * `onReplaced` is called inside the transaction with the key of the slip it replaced, so the
   * caller can delete that file once the transaction has committed. `ocr` and `verify` mark the
   * slip to be read automatically: the amount (D-26) and the bank check (D-27). A new slip always
   * clears the hints of the old one, except that the very same picture sent again keeps its bank
   * verdict (no second call to the service).
   */
  slip?:
    | {
        key: string;
        hash: string;
        onReplaced?: (oldKey: string) => void;
        ocr?: boolean;
        verify?: boolean;
      }
    | undefined;
}

/**
 * Claim never confirms (rule 2): it only records "โอนแล้ว". Void and refund need the manager
 * permission, a fresh step-up, a reason, an audit row and an owner alert (rule 9). A payment that
 * is already in the target status answers 200 and changes nothing, so a lost response can be
 * retried.
 */
export async function movePayment(
  ctx: CoreContext,
  actor: PaymentActor,
  paymentId: string,
  moveName: PaymentMove,
  input: MoveInput,
  meta: RequestMeta,
): Promise<PaymentResult> {
  const spec = MOVES[moveName];
  return withTransaction(ctx, async (tx, emit) => {
    const probe = await paymentsRepo.findPaymentById(tx, paymentId);
    if (!probe) throw notFound('Payment');
    const order = await ordersRepo.lockOrderById(tx, probe.orderId);
    if (!order) throw notFound('Order');
    assertOwns(actor, order);
    if (isCustomer(actor) && moveName !== 'claim') throw forbidden();
    const row = await paymentsRepo.lockPaymentById(tx, paymentId);
    if (!row) throw notFound('Payment');
    // A customer's slip is refused while the order is slip-blocked or the payment is cooling down
    // (neutral words, nothing written). A claim with no slip is never refused here.
    if (isCustomer(actor) && moveName === 'claim' && input.slip) {
      const refusal = slipUploadRefusal(
        await paymentsRepo.listPaymentsForOrder(tx, order.id),
        ctx.now(),
      );
      if (refusal) throw refusal;
    }

    if (row.status === spec.to) {
      // A second slip on a claim that is already made replaces the first; nothing else changes.
      if (input.slip && moveName === 'claim') {
        const swapped = await paymentsRepo.updatePaymentIfVersion(tx, row.id, row.version, {
          ...slipPatch(input.slip, row, ctx.now()),
        });
        if (!swapped) throw versionConflict(row.version); // cannot happen under the row lock
        if (row.slipImageKey) input.slip.onReplaced?.(row.slipImageKey);
        const payment = emitPayment(emit, swapped);
        // The first picture on a claim that had none clears the board flag: the order moves too.
        const flag = claimWithoutSlipOf(await paymentsRepo.listPaymentsForOrder(tx, order.id));
        return {
          payment,
          order:
            flag === order.claimWithoutSlip
              ? await orderDto(tx, order)
              : await settleOrder(tx, order, emit),
        };
      }
      return { payment: toPaymentDto(row), order: await orderDto(tx, order) };
    }
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw versionConflict(row.version);
    }
    if (spec.from && row.status !== spec.from) {
      throw transitionFailure('invalid_transition', row.status, spec.to);
    }

    const reason = input.reason?.trim() || undefined;
    const result = paymentMachine.transition(row.status as PaymentStatus, spec.to, {
      actor: actorOf(actor),
      reason,
    });
    if (!result.ok) throw transitionFailure(result.error, row.status, spec.to);
    if (result.stepUp && !hasFreshStepUp(staffOf(actor), ctx.now())) throw stepUpRequired();

    const now = ctx.now();
    // Rule 4: ไทยช่วยไทย is taken only while the scheme runs. A request a customer made earlier
    // (no scheme figures yet) gets them now, from the scheme in force at confirmation.
    let copaySnapshot: paymentsRepo.PaymentPatch = {};
    if (spec.to === 'confirmed' && row.method === 'gov_copay') {
      const offered = await offeredCopay(tx, order.channel, order.fulfillment as Fulfillment, now);
      if (!offered) {
        throw unprocessable(
          'GOV_COPAY_UNAVAILABLE',
          'The government co-pay scheme is not available for this order right now. Change the payment method',
        );
      }
      if (row.schemeId === null) {
        let split: ReturnType<typeof estimateGovCopaySplit>;
        try {
          split = estimateGovCopaySplit(satang(row.amountSatang), offered.scheme);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw unprocessable('AMOUNT_TOO_LARGE', 'This amount is too large for the co-pay scheme');
        }
        copaySnapshot = {
          schemeId: offered.row.id,
          estGovShareSatang: split.govShare,
          estCustomerShareSatang: split.customerShare,
        };
      }
    }
    const patch: paymentsRepo.PaymentPatch =
      spec.to === 'claimed'
        ? {
            status: 'claimed',
            claimedAt: now,
            ...(input.slip && moveName === 'claim' ? slipPatch(input.slip, row, now) : {}),
          }
        : spec.to === 'confirmed'
          ? {
              status: 'confirmed',
              confirmedByStaffId: staffOf(actor).staffId,
              confirmedAt: now,
              ...copaySnapshot,
              ...(input.referenceNote ? { referenceNote: input.referenceNote } : {}),
            }
          : { status: spec.to, voidReason: reason ?? '' };
    const updated = await paymentsRepo.updatePaymentIfVersion(tx, row.id, row.version, patch);
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock

    if (spec.audit) {
      await auditPayment(
        tx,
        actor,
        meta,
        spec.audit,
        row.id,
        snapshot(row),
        reason
          ? { status: spec.to, reason }
          : {
              status: spec.to,
              ...(input.referenceNote ? { referenceNote: input.referenceNote } : {}),
              ...(spec.to === 'confirmed' && input.attestedBankCheck
                ? { attestedBankCheck: true }
                : {}),
            },
      );
    }
    if (spec.to === 'voided' || spec.to === 'refunded') {
      emit(
        securityAlert(ctx, `payment.${spec.to}`, 'critical', {
          staffId: staffOf(actor).staffId,
          deviceId: staffOf(actor).deviceId,
          subject: { paymentId: row.id, orderId: order.id },
        }),
      );
    }
    const payment = emitPayment(emit, updated);
    return { payment, order: await settleOrder(tx, order, emit) };
  });
}
