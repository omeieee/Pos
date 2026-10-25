/**
 * Payments: what the other payment files share (actors, error mapping, money maths, order settling, audit).
 * Imports nothing from slips/ and none of the other use-case files (only dto.ts), so no import
 * cycle can start here.
 */
import {
  type Db,
  type GovCopayRow,
  getGovCopayRow,
  insertAudit,
  ordersRepo,
  paymentsRepo,
} from '@sds/db';
import {
  derivePaymentStatus,
  type Fulfillment,
  type GovCopayScheme,
  govCopaySchemeSchema,
  isCopayAvailable,
  isPayFirst,
  ORDER_REASONS,
  type OrderChannel,
  type OrderDto,
  orderMachine,
  type PaymentMethod,
  type PaymentStatus,
  satang,
  type TransitionError,
} from '@sds/shared';
import type { Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, conflict, forbidden, notFound, versionConflict } from '../errors.ts';
import { toOrderDto } from '../orders/dto.ts';
import { sendToKitchen } from '../print/service.ts';
import type { Emit } from '../tx.ts';
import { toPaymentDto } from './dto.ts';

/** Another request with the same client request id committed first. Thrown to undo our work. */
export class DuplicateRequest extends Error {}

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

export const isCustomer = (actor: PaymentActor): actor is CustomerActor =>
  actor.kind === 'customer';

/** A staff-only step: a customer never gets this far, and TypeScript knows it from here on. */
export function staffOf(actor: PaymentActor): Principal {
  if (isCustomer(actor)) throw forbidden();
  return actor;
}

/** A customer sees and changes their own orders only; anyone else's looks like it does not exist. */
export function assertOwns(actor: PaymentActor, order: ordersRepo.OrderRow): void {
  if (isCustomer(actor) && order.customerId !== actor.customerId) throw notFound('Order');
}

export const CUSTOMER_METHODS: readonly PaymentMethod[] = ['promptpay', 'gov_copay'];

export const actorOf = (actor: PaymentActor) =>
  isCustomer(actor) ? { kind: 'customer' as const } : { kind: 'staff' as const, role: actor.role };
export const unprocessable = (
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) => new ApiError(422, code, message, details);

export function transitionFailure(error: TransitionError, from: string, to: string): ApiError {
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
export async function openPaymentRace(
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

export const promptpayNotConfigured = () =>
  conflict('PROMPTPAY_NOT_CONFIGURED', 'No PromptPay ID is set. The owner sets it in settings');

// ---------- Shared pieces ----------

export async function orderDto(db: Db, order: ordersRepo.OrderRow): Promise<OrderDto> {
  const items = await ordersRepo.loadOrderItems(db, [order.id]);
  return toOrderDto(order, items.get(order.id) ?? []);
}

export function emitPayment(emit: Emit, row: paymentsRepo.PaymentRow) {
  const dto = toPaymentDto(row);
  emit({ type: 'payment.upserted', id: row.id, rev: row.rev, data: dto });
  return dto;
}

/** What each payment has partly returned so far (D-25), by payment id. */
export const refundedBy = (refunds: readonly paymentsRepo.RefundRow[]) => {
  const byPayment = new Map<string, number>();
  for (const r of refunds) {
    byPayment.set(r.paymentId, (byPayment.get(r.paymentId) ?? 0) + r.amountSatang);
  }
  return byPayment;
};

export const amountsOf = (
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
export async function moneyOf(tx: Db, orderId: string) {
  const [rows, refunds] = await Promise.all([
    paymentsRepo.listPaymentsForOrder(tx, orderId),
    paymentsRepo.listRefundsForOrder(tx, orderId),
  ]);
  return { rows, refunds, amounts: amountsOf(rows, refunds) };
}

/** The board flag: a claimed payment ("โอนแล้ว") that has no slip picture (`orders.claim_without_slip`). */
export const claimWithoutSlipOf = (rows: readonly paymentsRepo.PaymentRow[]): boolean =>
  rows.some((p) => p.status === 'claimed' && p.slipImageKey === null);

/**
 * The method of the order's current payment (`orders.payment_method`): the latest one that is
 * pending, claimed or confirmed; failing that, PromptPay when staff rejected its claim (the
 * customer may pay again). A customer who withdrew PromptPay to pay cash leaves a cancelled payment
 * that was never claimed, so the method is null. Only the methods a device shows are returned.
 */
export function currentMethodOf(
  payments: readonly paymentsRepo.PaymentRow[],
): 'cash' | 'promptpay' | 'gov_copay' | null {
  const shown = (m: string | undefined) =>
    m === 'cash' || m === 'promptpay' || m === 'gov_copay' ? m : null;
  const live = [...payments]
    .reverse()
    .find((p) => p.status === 'pending' || p.status === 'claimed' || p.status === 'confirmed');
  if (live) return shown(live.method);
  const last = payments.at(-1);
  return last?.method === 'promptpay' && last.status === 'cancelled' && last.claimedAt !== null
    ? 'promptpay'
    : null;
}

/** Pay-first (D-38) as the order's payments show it: a LINE order whose current method is PromptPay. */
export function payFirstOf(
  order: Pick<ordersRepo.OrderRow, 'channel'>,
  payments: readonly paymentsRepo.PaymentRow[],
): boolean {
  return isPayFirst({
    channel: order.channel as OrderChannel,
    paymentMethod: currentMethodOf(payments),
  });
}

/**
 * A claimed payment with a slip the bank check passed that the server did not confirm
 * (`orders.needs_manual_confirm`, D-42): staff must tick it.
 */
export const needsManualConfirmOf = (rows: readonly paymentsRepo.PaymentRow[]): boolean =>
  rows.some((p) => p.status === 'claimed' && p.slipImageKey !== null && p.slipVerify === 'valid');

/**
 * Recomputes the order's payment status and its "claimed, no slip" flag from ALL its payments,
 * writes them in this transaction (the sync trigger bumps the order's version and rev, whether or
 * not the values changed) and emits `order.upserted`. The caller holds the order lock.
 *
 * D-38: a pay-first order that is now `paid` and still `new` moves to `preparing` in the SAME
 * update (actor system, reason `paid`), and its kitchen ticket is queued in this same transaction
 * (`print/service.ts:sendToKitchen()`, BE-01). The `new` check makes a second settle do nothing
 * more. When a pay-first order first becomes paid, `alert.payment {kind: 'paid'}` goes out (D-42). Only pay-first orders alert: a
 * counter sale or a LINE cash order is paid by staff at the till, who need no pop-up for it.
 */
export async function settleOrder(
  tx: Db,
  order: ordersRepo.OrderRow,
  emit: Emit,
  now: Date = new Date(),
): Promise<OrderDto> {
  const { rows, amounts } = await moneyOf(tx, order.id);
  const status = derivePaymentStatus(satang(order.totalSatang), amounts);
  const payFirst = status === 'paid' && payFirstOf(order, rows);
  const patch: ordersRepo.OrderPatch = {
    paymentStatus: status,
    claimWithoutSlip: claimWithoutSlipOf(rows),
    paymentMethod: currentMethodOf(rows),
    needsManualConfirm: needsManualConfirmOf(rows),
  };
  const startKitchen = payFirst && order.status === 'new';
  if (startKitchen) {
    const move = orderMachine.transition('new', 'preparing', {
      actor: { kind: 'system' },
      reason: ORDER_REASONS.paid,
    });
    if (!move.ok) throw transitionFailure(move.error, 'new', 'preparing');
    patch.status = 'preparing';
    patch.acceptedAt = now;
  }
  const updated = await ordersRepo.updateOrderIfVersion(tx, order.id, order.version, patch);
  if (!updated) throw versionConflict(order.version); // cannot happen under the row lock
  const dto = await orderDto(tx, updated);
  emit({ type: 'order.upserted', id: updated.id, rev: updated.rev, data: dto });
  if (startKitchen) await sendToKitchen(tx, emit, updated, now);
  if (payFirst && order.paymentStatus !== 'paid') {
    emit({ type: 'alert.payment', orderId: updated.id, orderNo: updated.orderNo, kind: 'paid' });
  }
  return dto;
}

export async function auditPayment(
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

export const snapshot = (row: paymentsRepo.PaymentRow) => ({
  status: row.status,
  method: row.method,
  amountSatang: row.amountSatang,
});
