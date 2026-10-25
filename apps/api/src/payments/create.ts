/**
 * Payments: start a payment (idempotent by client request id).
 */
import { type Db, getSettingRow, ordersRepo, paymentsRepo } from '@sds/db';
import { promptpayPayload } from '@sds/promptpay';
import {
  CashPaymentError,
  type ChangePaymentMethodInput,
  type CreatePaymentInput,
  calculateCashChange,
  estimateGovCopaySplit,
  type Fulfillment,
  maskPromptpayId,
  netPaid,
  type OrderDto,
  type PaymentMethod,
  type PaymentResult,
  paymentMachine,
  paymentsSettingsSchema,
  satang,
} from '@sds/shared';
import {
  assertOriginalStaffExists,
  assertReplayOriginalStaff,
  requireOwnerForOriginalStaff,
} from '../admin/original-staff.ts';
import type { RequestMeta } from '../auth/service.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { currentPromptpayId } from '../settings/service.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { toPaymentDto } from './dto.ts';
import {
  actorOf,
  assertOwns,
  auditPayment,
  CUSTOMER_METHODS,
  DuplicateRequest,
  emitPayment,
  isCustomer,
  moneyOf,
  offeredCopay,
  openPaymentRace,
  orderDto,
  type PaymentActor,
  promptpayNotConfigured,
  settleOrder,
  snapshot,
  staffOf,
  transitionFailure,
  unprocessable,
} from './internal.ts';
import { paymentRequestHash } from './request-hash.ts';

// ---------- Create ----------

/**
 * A request id that was seen before. The same content gets the original payment back (with the
 * order as it is now); a different order or different content is refused, so a client bug or a
 * clash can never look like a success.
 */
export async function replayOf(
  db: Db,
  existing: paymentsRepo.PaymentRow,
  orderId: string,
  requestHash: string,
  originalStaffId: string | undefined,
): Promise<{ payment: paymentsRepo.PaymentRow; order: OrderDto }> {
  if (
    existing.orderId !== orderId ||
    (existing.requestHash !== null && existing.requestHash !== requestHash)
  ) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different payment. Make a new request id for a new payment',
    );
  }
  assertReplayOriginalStaff(
    { originalStaffId: existing.originalStaffId, creatorStaffId: existing.confirmedByStaffId },
    originalStaffId,
  );
  const order = await ordersRepo.findOrderById(db, existing.orderId);
  if (!order) throw notFound('Order');
  return { payment: existing, order: await orderDto(db, order) };
}

/**
 * Checks everything that decides whether this order may take a payment of this method and builds
 * the row. Runs under the order lock; `existing` is read after the lock, so it is current.
 */
export async function insertPaymentFor(
  tx: Db,
  ctx: CoreContext,
  actor: PaymentActor,
  meta: RequestMeta,
  order: ordersRepo.OrderRow,
  input: CreatePaymentInput | ChangePaymentMethodInput,
  requestHash: string,
  originalStaffId?: string,
): Promise<paymentsRepo.PaymentRow> {
  assertOwns(actor, order);
  if (isCustomer(actor) && !CUSTOMER_METHODS.includes(input.method)) throw forbidden();
  if (order.status === 'cancelled') {
    throw conflict('ORDER_CLOSED', 'A cancelled order cannot be paid', { status: order.status });
  }
  const total = satang(order.totalSatang);
  if (total <= 0) {
    throw unprocessable('NOTHING_TO_PAY', 'This order has nothing to pay');
  }

  if (input.method !== 'gov_copay') {
    const methods = paymentsSettingsSchema.parse(
      (await getSettingRow(tx, 'payment_methods'))?.value ?? {},
    );
    if (!methods[input.method]) {
      throw unprocessable('METHOD_DISABLED', 'The shop does not take this payment method');
    }
  }

  // One open payment per order: the order lock above makes this check and the insert one step.
  const { rows: existing, amounts } = await moneyOf(tx, order.id);
  // A payment charges what is still due: the whole total, or after an owner's adjustment (D-25)
  // the difference between the new total and the money already confirmed and not returned.
  const due = satang(Math.max(0, total - netPaid(amounts)));
  if (due <= 0) {
    throw conflict('ORDER_ALREADY_PAID', 'This order is already paid');
  }
  const open = existing.find((p) => p.status === 'pending' || p.status === 'claimed');
  if (open) {
    throw conflict('PAYMENT_ALREADY_OPEN', 'This order already has a payment in progress', {
      paymentId: open.id,
      status: open.status,
    });
  }

  const base = {
    orderId: order.id,
    method: input.method as PaymentMethod,
    amountSatang: due,
    referenceNote: input.referenceNote ?? null,
    clientRequestId: input.clientRequestId,
    requestHash,
  };
  const now = ctx.now();
  let row: paymentsRepo.PaymentRow | undefined;

  switch (input.method) {
    case 'cash': {
      // Recorded as already confirmed (02 §4.2): the machine decides whether this role may confirm.
      const cashier = staffOf(actor);
      const move = paymentMachine.transition('pending', 'confirmed', { actor: actorOf(cashier) });
      if (!move.ok) throw transitionFailure(move.error, 'pending', 'confirmed');
      let cash: ReturnType<typeof calculateCashChange>;
      try {
        cash = calculateCashChange(due, satang(input.tendered));
      } catch (error) {
        if (!(error instanceof CashPaymentError)) throw error;
        if (error.code === 'tendered_below_total') {
          throw unprocessable(
            'TENDERED_BELOW_TOTAL',
            'The cash handed over is less than the total',
          );
        }
        throw unprocessable('AMOUNT_TOO_LARGE', 'This amount is too large for a cash payment');
      }
      if (originalStaffId !== undefined) await assertOriginalStaffExists(tx, originalStaffId);
      row = await paymentsRepo.insertPayment(tx, {
        ...base,
        status: 'confirmed',
        tenderedSatang: cash.tendered,
        changeSatang: cash.change,
        confirmedByStaffId: cashier.staffId,
        confirmedAt: now,
        originalStaffId: originalStaffId ?? null,
      });
      if (row) {
        await auditPayment(tx, actor, meta, 'payment.confirm', row.id, null, {
          ...snapshot(row),
          created: true,
          ...(originalStaffId !== undefined ? { originalStaffId } : {}),
        });
      }
      break;
    }
    case 'promptpay': {
      const target = await currentPromptpayId(tx);
      if (!target) throw promptpayNotConfigured();
      try {
        promptpayPayload(target, due); // fails now, not when the QR is shown, on a bad ID or amount
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw unprocessable(
          'PROMPTPAY_PAYLOAD_INVALID',
          'A PromptPay QR cannot be made for this order',
        );
      }
      row = await paymentsRepo.insertPayment(tx, {
        ...base,
        status: 'pending',
        promptpayTargetMasked: maskPromptpayId(target.idValue),
      });
      break;
    }
    case 'gov_copay': {
      const offered = await offeredCopay(tx, order.channel, order.fulfillment as Fulfillment, now);
      if (
        !offered &&
        isCustomer(actor) &&
        order.channel === 'line' &&
        order.fulfillment === 'entrance_delivery'
      ) {
        // A LINE customer's choice is a request for staff to see: no scheme figures are saved,
        // and staff can only take the payment as ไทยช่วยไทย while the scheme really runs.
        row = await paymentsRepo.insertPayment(tx, { ...base, status: 'pending' });
        break;
      }
      if (!offered) {
        throw unprocessable(
          'GOV_COPAY_UNAVAILABLE',
          'The government co-pay scheme is not available for this order right now',
        );
      }
      const { row: schemeRow, scheme } = offered;
      let split: ReturnType<typeof estimateGovCopaySplit>;
      try {
        split = estimateGovCopaySplit(due, scheme);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw unprocessable('AMOUNT_TOO_LARGE', 'This amount is too large for the co-pay scheme');
      }
      row = await paymentsRepo.insertPayment(tx, {
        ...base,
        status: 'pending',
        schemeId: schemeRow.id,
        estGovShareSatang: split.govShare,
        estCustomerShareSatang: split.customerShare,
      });
      break;
    }
    case 'platform':
    case 'other':
      row = await paymentsRepo.insertPayment(tx, { ...base, status: 'pending' });
      break;
  }
  if (!row) throw new DuplicateRequest();
  // Cash already wrote its payment.confirm row above; every other method is audited at creation.
  if (input.method !== 'cash') {
    await auditPayment(tx, actor, meta, 'payment.create', row.id, null, {
      ...snapshot(row),
      created: true,
    });
  }
  return row;
}

/**
 * `replay` is true when the request id was seen before: the original payment comes back and
 * nothing is written, so a retry (or an offline outbox replay) never takes the money twice.
 */
export async function createPayment(
  ctx: CoreContext,
  actor: PaymentActor,
  orderId: string,
  input: CreatePaymentInput,
  meta: RequestMeta,
): Promise<{ result: PaymentResult; replay: boolean }> {
  const originalStaffId = input.method === 'cash' ? input.originalStaffId : undefined;
  if (!isCustomer(actor)) requireOwnerForOriginalStaff(actor, originalStaffId, ctx.now());
  const requestHash = paymentRequestHash(orderId, input);
  const replayResult = async (db: Db, existing: paymentsRepo.PaymentRow) => {
    const { payment, order } = await replayOf(db, existing, orderId, requestHash, originalStaffId);
    return { result: { payment: toPaymentDto(payment), order }, replay: true };
  };

  const early = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
  if (early) return replayResult(ctx.db, early);

  try {
    return await withTransaction(ctx, async (tx, emit) => {
      const order = await ordersRepo.lockOrderById(tx, orderId);
      if (!order) throw notFound('Order');
      assertOwns(actor, order);
      // A request that waited for the lock may find its twin committed meanwhile.
      const twin = await paymentsRepo.findPaymentByClientRequestId(tx, input.clientRequestId);
      if (twin) return replayResult(tx, twin);

      const row = await insertPaymentFor(
        tx,
        ctx,
        actor,
        meta,
        order,
        input,
        requestHash,
        originalStaffId,
      );
      const payment = emitPayment(emit, row);
      return {
        result: { payment, order: await settleOrder(tx, order, emit, ctx.now()) },
        replay: false,
      };
    });
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) {
      throw (await openPaymentRace(ctx.db, orderId, error)) ?? error;
    }
    // The transaction was rolled back; the request that won is committed.
    const winner = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
    if (!winner) throw error;
    return replayResult(ctx.db, winner);
  }
}
