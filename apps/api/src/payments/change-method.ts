/**
 * Payments: change the method of a pending payment, and let a customer withdraw a pending one.
 */
import { type Db, ordersRepo, paymentsRepo } from '@sds/db';
import {
  type ChangePaymentMethodInput,
  type ChangePaymentMethodResult,
  type OrderDto,
  paymentMachine,
} from '@sds/shared';
import type { RequestMeta } from '../auth/service.ts';
import { conflict, notFound, versionConflict } from '../errors.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { insertPaymentFor, replayOf } from './create.ts';
import { toPaymentDto } from './dto.ts';
import {
  actorOf,
  assertOwns,
  auditPayment,
  type CustomerActor,
  DuplicateRequest,
  emitPayment,
  openPaymentRace,
  orderDto,
  type PaymentActor,
  settleOrder,
  transitionFailure,
  unprocessable,
} from './internal.ts';
import { paymentRequestHash } from './request-hash.ts';

// ---------- Change the method (02 §4.4) ----------

/**
 * Cancels the pending payment and creates the new one in ONE transaction: if the new payment
 * cannot be made (co-pay closed, no PromptPay ID, a tender that is too low) the old one stays
 * pending. Only a pending payment can be replaced; a claimed one needs cancel-claimed first, and
 * a confirmed one a manager void.
 */
export async function changePaymentMethod(
  ctx: CoreContext,
  actor: PaymentActor,
  paymentId: string,
  input: ChangePaymentMethodInput,
  meta: RequestMeta,
): Promise<{ result: ChangePaymentMethodResult; replay: boolean }> {
  const replayResult = async (
    db: Db,
    twin: paymentsRepo.PaymentRow,
    source: paymentsRepo.PaymentRow,
  ) => {
    const { payment, order } = await replayOf(
      db,
      twin,
      source.orderId,
      paymentRequestHash(source.orderId, input, source.id),
      undefined,
    );
    return {
      result: {
        payment: toPaymentDto(payment),
        cancelledPayment: toPaymentDto(source),
        order,
      },
      replay: true,
    };
  };

  try {
    return await withTransaction(ctx, async (tx, emit) => {
      // Lock order: the order first, then the payment (see the header).
      const probe = await paymentsRepo.findPaymentById(tx, paymentId);
      if (!probe) throw notFound('Payment');
      const order = await ordersRepo.lockOrderById(tx, probe.orderId);
      if (!order) throw notFound('Order');
      assertOwns(actor, order);
      const source = await paymentsRepo.lockPaymentById(tx, paymentId);
      if (!source) throw notFound('Payment');
      const requestHash = paymentRequestHash(order.id, input, source.id);

      const twin = await paymentsRepo.findPaymentByClientRequestId(tx, input.clientRequestId);
      if (twin) return replayResult(tx, twin, source);

      if (input.expectedVersion !== undefined && source.version !== input.expectedVersion) {
        throw versionConflict(source.version);
      }
      if (source.status !== 'pending') {
        throw conflict(
          'PAYMENT_NOT_PENDING',
          'Only a payment that is still pending can change method',
          { status: source.status },
        );
      }
      if (source.method === input.method) {
        throw unprocessable('METHOD_UNCHANGED', 'The payment already uses this method');
      }
      const move = paymentMachine.transition('pending', 'cancelled', { actor: actorOf(actor) });
      if (!move.ok) throw transitionFailure(move.error, 'pending', 'cancelled');

      const cancelled = await paymentsRepo.updatePaymentIfVersion(tx, source.id, source.version, {
        status: 'cancelled',
      });
      if (!cancelled) throw versionConflict(source.version); // cannot happen under the row lock
      const cancelledDto = emitPayment(emit, cancelled);

      const row = await insertPaymentFor(tx, ctx, actor, meta, order, input, requestHash);
      const payment = emitPayment(emit, row);
      await auditPayment(
        tx,
        actor,
        meta,
        'payment.change_method',
        source.id,
        { method: source.method, status: 'pending' },
        { method: row.method, paymentId: row.id },
      );
      const updated = await settleOrder(tx, order, emit);
      return {
        result: { payment, cancelledPayment: cancelledDto, order: updated },
        replay: false,
      };
    });
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) {
      // Only the index race needs the extra read; any other error is thrown as it is.
      if (!paymentsRepo.isOpenPaymentConflict(error)) throw error;
      const probe = await paymentsRepo.findPaymentById(ctx.db, paymentId);
      throw (await openPaymentRace(ctx.db, probe?.orderId, error)) ?? error;
    }
    const source = await paymentsRepo.findPaymentById(ctx.db, paymentId);
    const winner = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
    if (!winner || !source) throw error;
    return replayResult(ctx.db, winner, source);
  }
}

// ---------- A customer withdraws a waiting payment ----------

/**
 * A customer who picks cash (nothing is recorded for cash: staff take it at the hand-over) drops
 * the PromptPay or co-pay payment that was waiting. Only a payment that is still `pending` goes
 * (the machine lets a customer make that one move); a `claimed` one was already reported to staff
 * and only staff can cancel it. Nothing waiting: nothing changes, so a retry is harmless.
 */
export async function withdrawPendingPayment(
  ctx: CoreContext,
  actor: CustomerActor,
  orderId: string,
  meta: RequestMeta,
): Promise<OrderDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const order = await ordersRepo.lockOrderById(tx, orderId);
    if (!order) throw notFound('Order');
    assertOwns(actor, order);
    if (order.status === 'cancelled' || order.status === 'completed') {
      throw conflict('ORDER_CLOSED', 'This order is closed', { status: order.status });
    }
    const all = await paymentsRepo.listPaymentsForOrder(tx, order.id);
    if (all.some((p) => p.status === 'claimed' || p.status === 'confirmed')) {
      throw conflict(
        'PAYMENT_NOT_PENDING',
        'Only a payment that is still pending can change method',
      );
    }
    const pending = all.find((p) => p.status === 'pending');
    if (!pending) return orderDto(tx, order);
    const move = paymentMachine.transition('pending', 'cancelled', { actor: actorOf(actor) });
    if (!move.ok) throw transitionFailure(move.error, 'pending', 'cancelled');
    const cancelled = await paymentsRepo.updatePaymentIfVersion(tx, pending.id, pending.version, {
      status: 'cancelled',
    });
    if (!cancelled) throw versionConflict(pending.version); // cannot happen under the order lock
    emitPayment(emit, cancelled);
    await auditPayment(
      tx,
      actor,
      meta,
      'payment.withdraw',
      pending.id,
      { method: pending.method, status: 'pending' },
      { status: 'cancelled' },
    );
    return settleOrder(tx, order, emit);
  });
}
