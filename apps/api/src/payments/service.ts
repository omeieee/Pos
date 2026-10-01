/**
 * Payments (02 §4.2–4.4, 03 §4; CLAUDE.md rules 1–4, 6, 9). Every write is one transaction that
 * takes the ORDER row lock first (so two requests for one order queue up and cannot both see "no
 * open payment"), changes the payment through the state machine in `@sds/shared`, recomputes the
 * order's `payment_status` and bumps the order, and publishes `payment.upserted` and
 * `order.upserted` only after the commit.
 *
 * - The amount is always the order total; a client sends none (cash sends what was handed over).
 * - Staff confirm every payment. Cash is recorded as confirmed in the same step by the signed-in
 *   staff member (the machine checks `payment.confirm`); everything else waits for a confirm.
 * - Nothing here stores or returns a QR payload or the PromptPay ID: the picture is rebuilt from
 *   the current setting each time it is served.
 *
 * Retries: creating a payment (and changing the method) is idempotent by `clientRequestId` with a
 * request fingerprint. The other moves are naturally idempotent: a payment already in the target
 * status answers 200 with nothing written (no event, audit row or alert), and `expectedVersion`
 * is optional, as on `/v1/orders/:id/transition`.
 *
 * PGlite (the test database) runs one query at a time, so the order lock is NOT proven by the
 * tests here; the lock order (order, then payment) is what keeps real Postgres free of deadlocks.
 */
import {
  type Db,
  getGovCopayRow,
  getSettingRow,
  insertAudit,
  ordersRepo,
  paymentsRepo,
} from '@sds/db';
import { promptpayPayload } from '@sds/promptpay';
import {
  CashPaymentError,
  type ChangePaymentMethodInput,
  type ChangePaymentMethodResult,
  type CreatePaymentInput,
  calculateCashChange,
  derivePaymentStatus,
  estimateGovCopaySplit,
  type Fulfillment,
  govCopaySchemeSchema,
  isCopayAvailable,
  maskPromptpayId,
  type OrderDto,
  type OrderPaymentStatus,
  type OrderPaymentsResponse,
  type PaymentMethod,
  type PaymentQrUrlResponse,
  type PaymentResult,
  type PaymentStatus,
  paymentMachine,
  paymentsSettingsSchema,
  satang,
  type TransitionError,
} from '@sds/shared';
import {
  type AuthContext,
  hasFreshStepUp,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  stepUpRequired,
  versionConflict,
} from '../errors.ts';
import { toOrderDto } from '../orders/dto.ts';
import { currentPromptpayId } from '../settings/service.ts';
import { type Emit, withTransaction } from '../tx.ts';
import { toPaymentDto } from './dto.ts';
import { QR_URL_TTL_SECONDS, qrPng, signQrLink } from './qr.ts';
import { paymentRequestHash } from './request-hash.ts';

/** Another request with the same client request id committed first. Thrown to undo our work. */
class DuplicateRequest extends Error {}

const actorOf = (principal: Principal) => ({ kind: 'staff' as const, role: principal.role });
const unprocessable = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new ApiError(422, code, message, details);

function transitionFailure(error: TransitionError, from: string, to: string): ApiError {
  switch (error) {
    case 'invalid_transition':
      return conflict('INVALID_TRANSITION', `A payment cannot go from ${from} to ${to}`, {
        from,
        to,
      });
    case 'forbidden':
      return forbidden();
    case 'reason_required':
      return new ApiError(400, 'REASON_REQUIRED', 'A reason is required for this change');
  }
}

const promptpayNotConfigured = () =>
  conflict('PROMPTPAY_NOT_CONFIGURED', 'No PromptPay ID is set. The owner sets it in settings');

// ---------- Shared pieces ----------

async function orderDto(db: Db, order: ordersRepo.OrderRow): Promise<OrderDto> {
  const items = await ordersRepo.loadOrderItems(db, [order.id]);
  return toOrderDto(order, items.get(order.id) ?? []);
}

function emitPayment(emit: Emit, row: paymentsRepo.PaymentRow) {
  const dto = toPaymentDto(row);
  emit({ type: 'payment.upserted', id: row.id, rev: row.rev, data: dto });
  return dto;
}

const amountsOf = (rows: readonly paymentsRepo.PaymentRow[]) =>
  rows.map((p) => ({ status: p.status as PaymentStatus, amount: satang(p.amountSatang) }));

/**
 * Recomputes the order's payment status from ALL its payments, writes it in this transaction
 * (the sync trigger bumps the order's version and rev, whether or not the value changed) and
 * emits `order.upserted`. The caller holds the order lock.
 */
async function settleOrder(tx: Db, order: ordersRepo.OrderRow, emit: Emit): Promise<OrderDto> {
  const all = await paymentsRepo.listPaymentsForOrder(tx, order.id);
  const status = derivePaymentStatus(satang(order.totalSatang), amountsOf(all));
  const updated = await ordersRepo.updateOrderIfVersion(tx, order.id, order.version, {
    paymentStatus: status,
  });
  if (!updated) throw versionConflict(order.version); // cannot happen under the row lock
  const dto = await orderDto(tx, updated);
  emit({ type: 'order.upserted', id: updated.id, rev: updated.rev, data: dto });
  return dto;
}

async function auditPayment(
  tx: Db,
  actor: Principal,
  meta: RequestMeta,
  action: string,
  paymentId: string,
  before: unknown,
  after: unknown,
) {
  await insertAudit(tx, {
    actorType: 'staff',
    actorId: actor.staffId,
    deviceId: actor.deviceId,
    action,
    entity: 'payments',
    entityId: paymentId,
    before,
    after,
    ip: meta.ip,
  });
}

const snapshot = (row: paymentsRepo.PaymentRow) => ({
  status: row.status,
  method: row.method,
  amountSatang: row.amountSatang,
});

// ---------- Create ----------

/**
 * A request id that was seen before. The same content gets the original payment back (with the
 * order as it is now); a different order or different content is refused, so a client bug or a
 * clash can never look like a success.
 */
async function replayOf(
  db: Db,
  existing: paymentsRepo.PaymentRow,
  orderId: string,
  requestHash: string,
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
  const order = await ordersRepo.findOrderById(db, existing.orderId);
  if (!order) throw notFound('Order');
  return { payment: existing, order: await orderDto(db, order) };
}

/**
 * Checks everything that decides whether this order may take a payment of this method and builds
 * the row. Runs under the order lock; `existing` is read after the lock, so it is current.
 */
async function insertPaymentFor(
  tx: Db,
  ctx: AuthContext,
  actor: Principal,
  meta: RequestMeta,
  order: ordersRepo.OrderRow,
  input: CreatePaymentInput | ChangePaymentMethodInput,
  requestHash: string,
): Promise<paymentsRepo.PaymentRow> {
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
  const existing = await paymentsRepo.listPaymentsForOrder(tx, order.id);
  const confirmedTotal = existing
    .filter((p) => p.status === 'confirmed')
    .reduce((sum, p) => sum + p.amountSatang, 0);
  if (confirmedTotal >= total) {
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
    amountSatang: total,
    referenceNote: input.referenceNote ?? null,
    clientRequestId: input.clientRequestId,
    requestHash,
  };
  const now = ctx.now();
  let row: paymentsRepo.PaymentRow | undefined;

  switch (input.method) {
    case 'cash': {
      // Recorded as already confirmed (02 §4.2): the machine decides whether this role may confirm.
      const move = paymentMachine.transition('pending', 'confirmed', { actor: actorOf(actor) });
      if (!move.ok) throw transitionFailure(move.error, 'pending', 'confirmed');
      let cash: ReturnType<typeof calculateCashChange>;
      try {
        cash = calculateCashChange(total, satang(input.tendered));
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
      row = await paymentsRepo.insertPayment(tx, {
        ...base,
        status: 'confirmed',
        tenderedSatang: cash.tendered,
        changeSatang: cash.change,
        confirmedByStaffId: actor.staffId,
        confirmedAt: now,
      });
      if (row) {
        await auditPayment(tx, actor, meta, 'payment.confirm', row.id, null, {
          ...snapshot(row),
          created: true,
        });
      }
      break;
    }
    case 'promptpay': {
      const target = await currentPromptpayId(tx);
      if (!target) throw promptpayNotConfigured();
      try {
        promptpayPayload(target, total); // fails now, not when the QR is shown, on a bad ID or amount
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
      const schemeRow = await getGovCopayRow(tx);
      const scheme = schemeRow ? govCopaySchemeSchema.parse(schemeRow) : null;
      // Counter payments are face to face at the storefront whatever channel the order came by.
      if (
        !schemeRow ||
        !scheme ||
        !isCopayAvailable(scheme, now, 'storefront', order.fulfillment as Fulfillment)
      ) {
        throw unprocessable(
          'GOV_COPAY_UNAVAILABLE',
          'The government co-pay scheme is not available for this order right now',
        );
      }
      let split: ReturnType<typeof estimateGovCopaySplit>;
      try {
        split = estimateGovCopaySplit(total, scheme);
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
  return row;
}

/**
 * `replay` is true when the request id was seen before: the original payment comes back and
 * nothing is written, so a retry (or an offline outbox replay) never takes the money twice.
 */
export async function createPayment(
  ctx: AuthContext,
  actor: Principal,
  orderId: string,
  input: CreatePaymentInput,
  meta: RequestMeta,
): Promise<{ result: PaymentResult; replay: boolean }> {
  const requestHash = paymentRequestHash(orderId, input);
  const replayResult = async (db: Db, existing: paymentsRepo.PaymentRow) => {
    const { payment, order } = await replayOf(db, existing, orderId, requestHash);
    return { result: { payment: toPaymentDto(payment), order }, replay: true };
  };

  const early = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
  if (early) return replayResult(ctx.db, early);

  try {
    return await withTransaction(ctx, async (tx, emit) => {
      const order = await ordersRepo.lockOrderById(tx, orderId);
      if (!order) throw notFound('Order');
      // A request that waited for the lock may find its twin committed meanwhile.
      const twin = await paymentsRepo.findPaymentByClientRequestId(tx, input.clientRequestId);
      if (twin) return replayResult(tx, twin);

      const row = await insertPaymentFor(tx, ctx, actor, meta, order, input, requestHash);
      const payment = emitPayment(emit, row);
      return { result: { payment, order: await settleOrder(tx, order, emit) }, replay: false };
    });
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) throw error;
    // The transaction was rolled back; the request that won is committed.
    const winner = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
    if (!winner) throw error;
    return replayResult(ctx.db, winner);
  }
}

// ---------- Change the method (02 §4.4) ----------

/**
 * Cancels the pending payment and creates the new one in ONE transaction: if the new payment
 * cannot be made (co-pay closed, no PromptPay ID, a tender that is too low) the old one stays
 * pending. Only a pending payment can be replaced; a claimed one needs cancel-claimed first, and
 * a confirmed one a manager void.
 */
export async function changePaymentMethod(
  ctx: AuthContext,
  actor: Principal,
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
    if (!(error instanceof DuplicateRequest)) throw error;
    const winner = await paymentsRepo.findPaymentByClientRequestId(ctx.db, input.clientRequestId);
    const source = await paymentsRepo.findPaymentById(ctx.db, paymentId);
    if (!winner || !source) throw error;
    return replayResult(ctx.db, winner, source);
  }
}

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
}

/**
 * Claim never confirms (rule 2): it only records "โอนแล้ว". Void and refund need the manager
 * permission, a fresh step-up, a reason, an audit row and an owner alert (rule 9). A payment that
 * is already in the target status answers 200 and changes nothing, so a lost response can be
 * retried.
 */
export async function movePayment(
  ctx: AuthContext,
  actor: Principal,
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
    const row = await paymentsRepo.lockPaymentById(tx, paymentId);
    if (!row) throw notFound('Payment');

    if (row.status === spec.to) {
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
    if (result.stepUp && !hasFreshStepUp(actor, ctx.now())) throw stepUpRequired();

    const now = ctx.now();
    const patch: paymentsRepo.PaymentPatch =
      spec.to === 'claimed'
        ? { status: 'claimed', claimedAt: now }
        : spec.to === 'confirmed'
          ? {
              status: 'confirmed',
              confirmedByStaffId: actor.staffId,
              confirmedAt: now,
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
            },
      );
    }
    if (spec.to === 'voided' || spec.to === 'refunded') {
      emit(
        securityAlert(ctx, `payment.${spec.to}`, 'critical', {
          staffId: actor.staffId,
          deviceId: actor.deviceId,
        }),
      );
    }
    const payment = emitPayment(emit, updated);
    return { payment, order: await settleOrder(tx, order, emit) };
  });
}

// ---------- Read ----------

export async function listOrderPayments(
  ctx: AuthContext,
  orderId: string,
): Promise<OrderPaymentsResponse> {
  const order = await ordersRepo.findOrderById(ctx.db, orderId);
  if (!order) throw notFound('Order');
  const rows = await paymentsRepo.listPaymentsForOrder(ctx.db, orderId);
  return { payments: rows.map(toPaymentDto) };
}

// ---------- The QR picture ----------

const qrReady = (row: paymentsRepo.PaymentRow) =>
  row.method === 'promptpay' && (row.status === 'pending' || row.status === 'claimed');

/** A short-lived link for the staff app's `<img>`. Only for a PromptPay payment still waiting. */
export async function paymentQrUrl(
  ctx: AuthContext,
  paymentId: string,
): Promise<PaymentQrUrlResponse> {
  const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!row) throw notFound('Payment');
  if (!qrReady(row)) {
    throw conflict('QR_NOT_AVAILABLE', 'There is no PromptPay QR for this payment', {
      method: row.method,
      status: row.status,
    });
  }
  const target = await currentPromptpayId(ctx.db);
  if (!target) throw promptpayNotConfigured();
  const expiresAt = Math.floor(ctx.now().getTime() / 1000) + QR_URL_TTL_SECONDS;
  const signature = signQrLink(ctx.keys.qrUrlKey, row.id, expiresAt);
  return {
    url: `/v1/payments/${row.id}/qr.png?exp=${expiresAt}&sig=${signature}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    promptpayTargetMasked: maskPromptpayId(target.idValue),
  };
}

/**
 * The QR picture, rebuilt NOW from the current PromptPay ID in settings and the exact amount of
 * the payment (the order total). Nothing is cached or stored: a changed ID shows on the next
 * fetch. The payment must still be waiting; a confirmed, cancelled or voided one is a 404.
 */
export async function renderPaymentQr(ctx: AuthContext, paymentId: string): Promise<Buffer> {
  const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!row || !qrReady(row)) throw notFound('Payment');
  const target = await currentPromptpayId(ctx.db);
  if (!target) throw promptpayNotConfigured();
  let payload: string;
  try {
    payload = promptpayPayload(target, satang(row.amountSatang));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw unprocessable(
      'PROMPTPAY_PAYLOAD_INVALID',
      'A PromptPay QR cannot be made for this order',
    );
  }
  return qrPng(payload);
}

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
