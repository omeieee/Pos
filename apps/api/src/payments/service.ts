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
  type GovCopayRow,
  getGovCopayRow,
  getSettingRow,
  insertAudit,
  ordersRepo,
  paymentsRepo,
} from '@sds/db';
import { promptpayPayload } from '@sds/promptpay';
import {
  type AdjustRefundInput,
  CashPaymentError,
  type ChangePaymentMethodInput,
  type ChangePaymentMethodResult,
  type CreatePaymentInput,
  calculateCashChange,
  derivePaymentStatus,
  estimateGovCopaySplit,
  type Fulfillment,
  type GovCopayScheme,
  govCopaySchemeSchema,
  isCopayAvailable,
  maskPromptpayId,
  netPaid,
  type OrderDto,
  type OrderPaymentStatus,
  type OrderPaymentsResponse,
  type PastOrderPaymentAction,
  type PaymentMethod,
  type PaymentQrUrlResponse,
  type PaymentResult,
  type PaymentStatus,
  paymentMachine,
  paymentsSettingsSchema,
  planAdjustment,
  satang,
  type TransitionError,
} from '@sds/shared';
import {
  assertOriginalStaffExists,
  assertReplayOriginalStaff,
  requireOwnerForOriginalStaff,
} from '../admin/original-staff.ts';
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
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';
import { toPaymentDto } from './dto.ts';
import { QR_URL_TTL_SECONDS, qrPng, signQrLink } from './qr.ts';
import { paymentRequestHash } from './request-hash.ts';

/** Another request with the same client request id committed first. Thrown to undo our work. */
class DuplicateRequest extends Error {}

/**
 * A customer using the customer app, scoped to their own orders. Rule 2: the only thing a
 * customer's tap can do to a payment is make it `claimed` (the machine allows nothing else), and
 * the only payments they can start are PromptPay and ไทยช่วยไทย (cash is a choice with no record:
 * staff take it at the hand-over).
 */
export interface CustomerActor {
  kind: 'customer';
  customerId: string;
}
export type PaymentActor = Principal | CustomerActor;

const isCustomer = (actor: PaymentActor): actor is CustomerActor => actor.kind === 'customer';

/** A staff-only step: a customer never gets this far, and TypeScript knows it from here on. */
function staffOf(actor: PaymentActor): Principal {
  if (isCustomer(actor)) throw forbidden();
  return actor;
}

/** A customer sees and changes their own orders only; anyone else's looks like it does not exist. */
function assertOwns(actor: PaymentActor, order: ordersRepo.OrderRow): void {
  if (isCustomer(actor) && order.customerId !== actor.customerId) throw notFound('Order');
}

const CUSTOMER_METHODS: readonly PaymentMethod[] = ['promptpay', 'gov_copay'];

const actorOf = (actor: PaymentActor) =>
  isCustomer(actor) ? { kind: 'customer' as const } : { kind: 'staff' as const, role: actor.role };
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

/**
 * The unique index on open payments fired: another request's payment got past the order lock.
 * Postgres has aborted our transaction, so this runs on the plain connection afterwards and
 * reports the payment that won (if it has committed by now).
 */
async function openPaymentRace(
  db: Db,
  orderId: string | undefined,
  error: unknown,
): Promise<ApiError | undefined> {
  if (!paymentsRepo.isOpenPaymentConflict(error)) return undefined;
  const open = orderId
    ? (await paymentsRepo.listPaymentsForOrder(db, orderId)).find(
        (p) => p.status === 'pending' || p.status === 'claimed',
      )
    : undefined;
  return conflict(
    'PAYMENT_ALREADY_OPEN',
    'This order already has a payment in progress',
    open ? { paymentId: open.id, status: open.status } : {},
  );
}

/**
 * The co-pay scheme row when the method may be offered for an order of this channel and
 * fulfilment right now, else null. Staff take the payment face to face (at the counter or at the
 * entrance hand-over, owner 2026-10-02) whatever channel the order came by: a LINE or phone
 * entrance delivery paid at hand-over qualifies, and the real fulfilment is checked (platform and
 * legacy room delivery are refused). Grab and LINE MAN orders are paid on the platform, so co-pay
 * never applies to them (D-08). The ถุงเงิน QR is made by staff and never sent through LINE.
 * One definition, used both to create the payment and to decide whether the customer app shows
 * the option.
 */
export async function offeredCopay(
  db: Db,
  channel: string,
  fulfillment: Fulfillment,
  now: Date,
): Promise<{ row: GovCopayRow; scheme: GovCopayScheme } | null> {
  const row = await getGovCopayRow(db);
  if (!row || channel === 'grab' || channel === 'lineman') return null;
  const scheme = govCopaySchemeSchema.parse(row);
  return isCopayAvailable(scheme, now, 'storefront', fulfillment) ? { row, scheme } : null;
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

/** What each payment has partly returned so far (D-25), by payment id. */
const refundedBy = (refunds: readonly paymentsRepo.RefundRow[]) => {
  const byPayment = new Map<string, number>();
  for (const r of refunds) {
    byPayment.set(r.paymentId, (byPayment.get(r.paymentId) ?? 0) + r.amountSatang);
  }
  return byPayment;
};

const amountsOf = (
  rows: readonly paymentsRepo.PaymentRow[],
  refunds: readonly paymentsRepo.RefundRow[] = [],
) => {
  const returned = refundedBy(refunds);
  return rows.map((p) => ({
    id: p.id,
    method: p.method as PaymentMethod,
    status: p.status as PaymentStatus,
    amount: satang(p.amountSatang),
    refunded: satang(returned.get(p.id) ?? 0),
  }));
};

/** The order's payments with their partial refunds, for money maths. The caller holds the order lock. */
async function moneyOf(tx: Db, orderId: string) {
  const [rows, refunds] = await Promise.all([
    paymentsRepo.listPaymentsForOrder(tx, orderId),
    paymentsRepo.listRefundsForOrder(tx, orderId),
  ]);
  return { rows, refunds, amounts: amountsOf(rows, refunds) };
}

/**
 * Recomputes the order's payment status from ALL its payments, writes it in this transaction
 * (the sync trigger bumps the order's version and rev, whether or not the value changed) and
 * emits `order.upserted`. The caller holds the order lock.
 */
async function settleOrder(tx: Db, order: ordersRepo.OrderRow, emit: Emit): Promise<OrderDto> {
  const { amounts } = await moneyOf(tx, order.id);
  const status = derivePaymentStatus(satang(order.totalSatang), amounts);
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
  actor: PaymentActor,
  meta: RequestMeta,
  action: string,
  paymentId: string,
  before: unknown,
  after: unknown,
) {
  await insertAudit(tx, {
    actorType: isCustomer(actor) ? 'customer' : 'staff',
    actorId: isCustomer(actor) ? actor.customerId : actor.staffId,
    deviceId: isCustomer(actor) ? null : actor.deviceId,
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
async function insertPaymentFor(
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
      return { result: { payment, order: await settleOrder(tx, order, emit) }, replay: false };
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
  /**
   * Claim only: the customer's slip image, already stored under `key`. It is written in the same
   * transaction as the claim (or, on a payment that is already claimed, replaces the old slip).
   * `onReplaced` is called inside the transaction with the key of the slip it replaced, so the
   * caller can delete that file once the transaction has committed.
   */
  slip?: { key: string; onReplaced?: (oldKey: string) => void } | undefined;
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

    if (row.status === spec.to) {
      // A second slip on a claim that is already made replaces the first; nothing else changes.
      if (input.slip && moveName === 'claim') {
        const swapped = await paymentsRepo.updatePaymentIfVersion(tx, row.id, row.version, {
          slipImageKey: input.slip.key,
        });
        if (!swapped) throw versionConflict(row.version); // cannot happen under the row lock
        if (row.slipImageKey) input.slip.onReplaced?.(row.slipImageKey);
        return { payment: emitPayment(emit, swapped), order: await orderDto(tx, order) };
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
            ...(input.slip && moveName === 'claim' ? { slipImageKey: input.slip.key } : {}),
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

// ---------- Read ----------

export async function listOrderPayments(
  ctx: AuthContext,
  orderId: string,
): Promise<OrderPaymentsResponse> {
  const order = await ordersRepo.findOrderById(ctx.db, orderId);
  if (!order) throw notFound('Order');
  const { rows, refunds, amounts } = await moneyOf(ctx.db, orderId);
  const paid = netPaid(amounts);
  return {
    payments: rows.map(toPaymentDto),
    slipPaymentIds: rows.filter((r) => r.slipImageKey !== null).map((r) => r.id),
    refunds: refunds.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      amountSatang: satang(r.amountSatang),
      method: r.method as 'cash' | 'promptpay',
      referenceNote: r.referenceNote,
      reason: r.reason,
      refundedAt: r.refundedAt.toISOString(),
    })),
    netPaidSatang: paid,
    dueSatang: satang(Math.max(0, order.totalSatang - paid)),
  };
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
): Promise<{ paymentStatus: OrderPaymentStatus; refundedSatang: number }> {
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
