/**
 * A customer changes, cancels or merges their own unpaid LINE orders (D-39). Customer app only.
 *
 * - Edit: allowed while the order is `new` with no claimed or confirmed payment and no slip ever
 *   sent (`canCustomerEdit`, A4). All lines are replaced: the old ones are marked removed (rows are
 *   never deleted), the new ones are priced by the server from the menu, the waiting payment is
 *   cancelled and, if there was one, a new one is made for the new total with the same method.
 * - Cancel: `new -> cancelled`, reason `customer_cancel`, through the order machine.
 * - Merge: the target order takes over the live lines of the source orders (copied, with their
 *   price snapshots); each source is cancelled with reason `merged:<target no>`. One payment still
 *   belongs to one order. A confirmed payment is never touched: it makes the order ineligible.
 *
 * Each is one transaction under the order lock(s): the state machines decide, the version and rev
 * move through the sync trigger, an audit row is written, and the events go out after the commit.
 * The `Idempotency-Key` is stored in the audit row; the same key on the same order answers with the
 * order as it is, writing nothing. Nothing here is a LINE message.
 */
import { findAuditByRequestId, insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import {
  type AppOrderCancelInput,
  type AppOrderEditInput,
  type CreatePaymentInput,
  canCustomerEdit,
  MAX_ORDER_QUANTITY,
  type MergeFacts,
  mergedReason,
  mergeEligible,
  ORDER_REASONS,
  type OrderChannel,
  type OrderStatus,
  orderMachine,
  type PaymentFacts,
  paymentMachine,
  priceOrder,
} from '@sds/shared';
import type { RequestMeta } from '../auth/service.ts';
import { ApiError, conflict, notFound, versionConflict } from '../errors.ts';
import { insertPaymentFor } from '../payments/create.ts';
import {
  type CustomerActor,
  DuplicateRequest,
  emitPayment,
  settleOrder,
  transitionFailure,
} from '../payments/internal.ts';
import { settlePaymentsForOrderCancel } from '../payments/order-hooks.ts';
import { paymentRequestHash } from '../payments/request-hash.ts';
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';
import { toOrderDto } from './dto.ts';

/** Who merges: the customer in the app, or the server for a slip that arrived in the LINE chat. */
export type MergeActor = CustomerActor | { kind: 'system' };

/** The two ids a write may need: the caller's `Idempotency-Key` and the id of a replacement payment. */
export interface EditIds {
  idempotencyKey?: string | undefined;
  /** The client request id of the payment made for the new total; derive it from the key for a retry. */
  paymentRequestId: string;
}

type Tx = Parameters<typeof ordersRepo.loadOrderItems>[0];

const AUDIT = {
  edit: 'order.customer_edit',
  cancel: 'order.customer_cancel',
  merge: 'order.merge',
  merged: 'order.merged_into',
} as const;

/** What an audit row keeps of a line: ids, quantity and amounts, no free text. */
const lineSummary = (item: ordersRepo.OrderItemRow) => ({
  id: item.id,
  menuItemId: item.menuItemId,
  qty: item.qty,
  lineTotalSatang: item.lineTotalSatang,
});

const notEditable = (code: string, row: ordersRepo.OrderRow) =>
  conflict(code, 'This order can no longer be changed by the customer', { status: row.status });

/** The order and its payments as the merge and edit rules read them. */
export function factsOf(
  order: ordersRepo.OrderRow,
  payments: readonly paymentsRepo.PaymentRow[],
): MergeFacts {
  return {
    customerId: order.customerId,
    channel: order.channel as OrderChannel,
    status: order.status as OrderStatus,
    businessDate: order.businessDate,
    deliveryBuilding: order.deliveryBuilding,
    recipientName: order.recipientName,
    payments: paymentFactsOf(payments),
  };
}

export const paymentFactsOf = (payments: readonly paymentsRepo.PaymentRow[]): PaymentFacts[] =>
  payments.map((p) => ({
    status: p.status as PaymentFacts['status'],
    hasSlip: p.slipImageKey !== null || p.slipImageHash !== null,
  }));

/** The customer may edit or cancel this order now (the same rule the order page's buttons use). */
export const customerCanEdit = (
  order: Pick<ordersRepo.OrderRow, 'status'>,
  payments: readonly paymentsRepo.PaymentRow[],
): boolean => canCustomerEdit({ status: order.status as OrderStatus }, paymentFactsOf(payments));

async function emitOrder(tx: Tx, emit: Emit, row: ordersRepo.OrderRow) {
  const items = await ordersRepo.loadOrderItems(tx, [row.id]);
  emit({
    type: 'order.upserted',
    id: row.id,
    rev: row.rev,
    data: toOrderDto(row, items.get(row.id) ?? []),
  });
}

/**
 * Cancels the pending payment of an order that is being changed, through the payment machine, and
 * returns it so a replacement can be made. A claimed or confirmed payment never gets here.
 */
async function cancelPending(
  tx: Tx,
  emit: Emit,
  actor: MergeActor,
  meta: RequestMeta,
  payments: readonly paymentsRepo.PaymentRow[],
  why: string,
): Promise<paymentsRepo.PaymentRow | undefined> {
  const pending = payments.find((p) => p.status === 'pending');
  if (!pending) return undefined;
  const move = paymentMachine.transition('pending', 'cancelled', { actor });
  if (!move.ok) throw transitionFailure(move.error, 'pending', 'cancelled');
  const cancelled = await paymentsRepo.updatePaymentIfVersion(tx, pending.id, pending.version, {
    status: 'cancelled',
  });
  if (!cancelled) throw versionConflict(pending.version); // cannot happen under the order lock
  emitPayment(emit, cancelled);
  await insertAudit(tx, {
    actorType: actor.kind === 'customer' ? 'customer' : 'system',
    actorId: actor.kind === 'customer' ? actor.customerId : null,
    ip: meta.ip,
    action: 'payment.cancel',
    entity: 'payments',
    entityId: pending.id,
    before: { method: pending.method, status: 'pending', amountSatang: pending.amountSatang },
    after: { status: 'cancelled', why },
  });
  return pending;
}

/** The same method again for the order's new total. Only the methods a customer can start. */
async function replacePayment(
  tx: Tx,
  ctx: CoreContext,
  customerId: string,
  meta: RequestMeta,
  order: ordersRepo.OrderRow,
  old: paymentsRepo.PaymentRow | undefined,
  requestId: string,
  emit: Emit,
): Promise<void> {
  if (!old || (old.method !== 'promptpay' && old.method !== 'gov_copay')) return;
  const input: CreatePaymentInput = { method: old.method, clientRequestId: requestId };
  const row = await insertPaymentFor(
    tx,
    ctx,
    { kind: 'customer', customerId },
    meta,
    order,
    input,
    paymentRequestHash(order.id, input),
  );
  emitPayment(emit, row);
}

/** `Idempotency-Key` seen before on this order for this action: the answer is the order as it is. */
async function replayed(
  tx: Tx,
  entityId: string,
  action: string,
  key: string | undefined,
): Promise<boolean> {
  if (!key) return false;
  const done = await findAuditByRequestId(tx, 'orders', entityId, key);
  return done?.action === action;
}

/** A reused key makes the replacement payment's request id collide: a client bug, refused plainly. */
async function guardKeyReuse<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) throw error;
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different request. Make a new one',
    );
  }
}

async function ownedOrder(tx: Tx, customerId: string, id: string) {
  const row = await ordersRepo.lockOrderById(tx, id);
  if (!row || row.customerId !== customerId) throw notFound('Order');
  return row;
}

// ---------- Edit ----------

/** Replaces all the lines of the customer's own order. Returns the order as it is afterwards. */
export async function editOrderItems(
  ctx: CoreContext,
  customerId: string,
  orderId: string,
  input: AppOrderEditInput,
  ids: EditIds,
  meta: RequestMeta,
): Promise<ordersRepo.OrderRow> {
  const quantity = input.items.reduce((sum, line) => sum + line.qty, 0);
  if (quantity > MAX_ORDER_QUANTITY) {
    throw new ApiError(422, 'ORDER_TOO_LARGE', 'That is too many items for one order', {
      max: MAX_ORDER_QUANTITY,
    });
  }
  return guardKeyReuse(() =>
    withTransaction(ctx, async (tx, emit) => {
      const row = await ownedOrder(tx, customerId, orderId);
      if (await replayed(tx, orderId, AUDIT.edit, ids.idempotencyKey)) return row;
      if (row.version !== input.expectedVersion) throw versionConflict(row.version);
      const payments = await paymentsRepo.listPaymentsForOrder(tx, orderId);
      if (!customerCanEdit(row, payments)) throw notEditable('ORDER_NOT_EDITABLE', row);

      const catalog = await ordersRepo.loadCatalog(tx, [
        ...new Set(input.items.map((l) => l.menuItemId)),
      ]);
      const priced = priceOrder('line', input.items, catalog);
      if (!priced.ok) {
        throw new ApiError(422, 'ORDER_INVALID', 'The order cannot be accepted', {
          errors: priced.errors.map((e) => ({ code: e.code, lineIndex: e.lineIndex })),
        });
      }
      const subtotal = priced.totals.subtotal;
      if (row.discountSatang > subtotal) {
        throw new ApiError(
          422,
          'DISCOUNT_EXCEEDS_SUBTOTAL',
          'The order discount is larger than the new subtotal',
        );
      }

      const before = (await ordersRepo.loadOrderItems(tx, [orderId])).get(orderId) ?? [];
      await ordersRepo.markOrderItemsRemoved(
        tx,
        before.map((item) => item.id),
        ctx.now(),
      );
      const inserted = await ordersRepo.insertOrderItems(
        tx,
        orderId,
        priced.lines.map((line) => ({
          menuItemId: line.menuItemId,
          nameThSnapshot: line.nameTh,
          nameEnSnapshot: line.nameEn,
          unitPriceSatang: line.unitPriceSatang,
          unitCostSatang: line.unitCostSatang,
          qty: line.qty,
          modifiers: line.modifiers,
          note: line.note,
          lineTotalSatang: line.lineTotalSatang,
        })),
      );

      const old = await cancelPending(
        tx,
        emit,
        { kind: 'customer', customerId },
        meta,
        payments,
        'order_edited',
      );
      const updated = await ordersRepo.updateOrderIfVersion(tx, orderId, row.version, {
        subtotalSatang: subtotal,
        totalSatang: subtotal - row.discountSatang,
      });
      if (!updated) throw versionConflict(row.version); // cannot happen under the order lock
      await replacePayment(tx, ctx, customerId, meta, updated, old, ids.paymentRequestId, emit);
      const settled = await settleAfter(tx, ctx, updated, emit);

      await insertAudit(tx, {
        actorType: 'customer',
        actorId: customerId,
        ip: meta.ip,
        action: AUDIT.edit,
        entity: 'orders',
        entityId: orderId,
        before: { totalSatang: row.totalSatang, items: before.map(lineSummary) },
        after: {
          totalSatang: settled.totalSatang,
          items: inserted.map(lineSummary),
          ...(ids.idempotencyKey ? { clientRequestId: ids.idempotencyKey } : {}),
        },
      });
      return settled;
    }),
  );
}

/** Settles the payment status after the lines or payments changed, and returns the row as stored. */
async function settleAfter(
  tx: Tx,
  ctx: CoreContext,
  order: ordersRepo.OrderRow,
  emit: Emit,
): Promise<ordersRepo.OrderRow> {
  await settleOrder(tx, order, emit, ctx.now());
  const row = await ordersRepo.findOrderById(tx, order.id);
  if (!row) throw notFound('Order');
  return row;
}

// ---------- Cancel ----------

/** Cancels the customer's own unpaid order (reason `customer_cancel`). */
export async function cancelByCustomer(
  ctx: CoreContext,
  customerId: string,
  orderId: string,
  input: AppOrderCancelInput,
  idempotencyKey: string | undefined,
  meta: RequestMeta,
): Promise<ordersRepo.OrderRow> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await ownedOrder(tx, customerId, orderId);
    if (await replayed(tx, orderId, AUDIT.cancel, idempotencyKey)) return row;
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    const payments = await paymentsRepo.listPaymentsForOrder(tx, orderId);
    // A payment the customer reported or the shop confirmed comes first: that is its own answer.
    const held = payments.find((p) => p.status === 'claimed' || p.status === 'confirmed');
    if (held) {
      throw conflict(
        'ORDER_HAS_PAYMENT',
        'This order has a payment that was claimed or confirmed. The shop has to cancel it',
        { status: held.status },
      );
    }
    const move = orderMachine.transition(row.status as OrderStatus, 'cancelled', {
      actor: { kind: 'customer' },
      reason: ORDER_REASONS.customer_cancel,
    });
    if (!move.ok) throw transitionFailure(move.error, row.status, 'cancelled');
    if (!customerCanEdit(row, payments)) throw notEditable('ORDER_NOT_CANCELLABLE', row);

    const paymentStatus = await settlePaymentsForOrderCancel(tx, row, emit);
    const updated = await ordersRepo.updateOrderIfVersion(tx, orderId, row.version, {
      status: 'cancelled',
      cancelledAt: ctx.now(),
      cancelReason: ORDER_REASONS.customer_cancel,
      paymentStatus,
    });
    if (!updated) throw versionConflict(row.version); // cannot happen under the order lock
    await emitOrder(tx, emit, updated);
    await insertAudit(tx, {
      actorType: 'customer',
      actorId: customerId,
      ip: meta.ip,
      action: AUDIT.cancel,
      entity: 'orders',
      entityId: orderId,
      before: { status: row.status, totalSatang: row.totalSatang },
      after: {
        status: 'cancelled',
        reason: ORDER_REASONS.customer_cancel,
        ...(idempotencyKey ? { clientRequestId: idempotencyKey } : {}),
      },
    });
    return updated;
  });
}

// ---------- Merge ----------

/** The versions a merge was shown: the target's and each source's, in `sourceIds` order. */
export interface MergeVersions {
  target: number;
  sources: readonly number[];
}

/**
 * Folds `sourceIds` into `targetId`. The customer calls it from the app with the versions they saw;
 * the server calls it (actor `system`, no versions) for a slip that arrived in the LINE chat.
 * The caller must be the owner of every order (a foreign id is a plain 404). Returns the target.
 */
export async function mergeOrders(
  ctx: CoreContext,
  actor: MergeActor,
  targetId: string,
  sourceIds: readonly string[],
  versions: MergeVersions | undefined,
  ids: EditIds,
  meta: RequestMeta,
): Promise<ordersRepo.OrderRow> {
  if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) {
    throw new ApiError(422, 'MERGE_INVALID', 'Name each order to merge once');
  }
  if (sourceIds.includes(targetId)) {
    throw new ApiError(422, 'MERGE_INVALID', 'An order cannot be merged into itself');
  }
  return guardKeyReuse(() =>
    withTransaction(ctx, async (tx, emit) => {
      // Lock order: every order row in id order, then read them under the locks.
      await paymentsRepo.lockOrders(tx, [targetId, ...sourceIds]);
      const target = await ordersRepo.findOrderById(tx, targetId);
      if (!target) throw notFound('Order');
      const sources: ordersRepo.OrderRow[] = [];
      for (const id of sourceIds) {
        const source = await ordersRepo.findOrderById(tx, id);
        if (!source) throw notFound('Order');
        sources.push(source);
      }
      if (actor.kind === 'customer') {
        for (const order of [target, ...sources]) {
          if (order.customerId !== actor.customerId) throw notFound('Order');
        }
      }
      if (await replayed(tx, targetId, AUDIT.merge, ids.idempotencyKey)) return target;
      if (versions) {
        if (target.version !== versions.target) throw versionConflict(target.version);
        for (const [i, source] of sources.entries()) {
          if (source.version !== versions.sources[i]) throw versionConflict(source.version);
        }
      }

      const paymentsOf = new Map<string, paymentsRepo.PaymentRow[]>();
      for (const order of [target, ...sources]) {
        paymentsOf.set(order.id, await paymentsRepo.listPaymentsForOrder(tx, order.id));
      }
      const eligible =
        [target, ...sources].every((o) => o.discountSatang === 0) &&
        mergeEligible(
          factsOf(target, paymentsOf.get(target.id) ?? []),
          sources.map((s) => factsOf(s, paymentsOf.get(s.id) ?? [])),
        );
      if (!eligible) {
        throw conflict('MERGE_NOT_ALLOWED', 'These orders cannot be combined', {
          targetStatus: target.status,
        });
      }

      // The sources' live lines become new rows on the target, with their price snapshots.
      const sourceLines = await ordersRepo.loadOrderItems(
        tx,
        sources.map((s) => s.id),
      );
      const targetLines = (await ordersRepo.loadOrderItems(tx, [targetId])).get(targetId) ?? [];
      const copying = sources.flatMap((s) => sourceLines.get(s.id) ?? []);
      const quantity = [...targetLines, ...copying].reduce((sum, line) => sum + line.qty, 0);
      if (quantity > MAX_ORDER_QUANTITY) {
        throw new ApiError(422, 'ORDER_TOO_LARGE', 'That is too many items for one order', {
          max: MAX_ORDER_QUANTITY,
        });
      }
      const copied = await ordersRepo.insertOrderItems(
        tx,
        targetId,
        copying.map((line) => ({
          menuItemId: line.menuItemId,
          nameThSnapshot: line.nameThSnapshot,
          nameEnSnapshot: line.nameEnSnapshot,
          unitPriceSatang: line.unitPriceSatang,
          unitCostSatang: line.unitCostSatang,
          qty: line.qty,
          modifiers: line.modifiers as ordersRepo.NewOrderItem['modifiers'],
          note: line.note,
          lineTotalSatang: line.lineTotalSatang,
        })),
      );

      // Each source goes: its pending payment is cancelled with it, then the order itself.
      const reason = mergedReason(target.orderNo);
      for (const source of sources) {
        const move = orderMachine.transition(source.status as OrderStatus, 'cancelled', {
          actor,
          reason,
        });
        if (!move.ok) throw transitionFailure(move.error, source.status, 'cancelled');
        const paymentStatus = await settlePaymentsForOrderCancel(tx, source, emit);
        const gone = await ordersRepo.updateOrderIfVersion(tx, source.id, source.version, {
          status: 'cancelled',
          cancelledAt: ctx.now(),
          cancelReason: reason,
          paymentStatus,
        });
        if (!gone) throw versionConflict(source.version); // cannot happen under the order locks
        await emitOrder(tx, emit, gone);
        await insertAudit(tx, {
          actorType: actor.kind === 'customer' ? 'customer' : 'system',
          actorId: actor.kind === 'customer' ? actor.customerId : null,
          ip: meta.ip,
          action: AUDIT.merged,
          entity: 'orders',
          entityId: source.id,
          before: { status: source.status, totalSatang: source.totalSatang },
          after: { status: 'cancelled', reason, mergedInto: target.id },
        });
      }

      // The target: its pending payment is replaced by one for the new total, same method.
      const subtotal = [...targetLines, ...copied].reduce((sum, l) => sum + l.lineTotalSatang, 0);
      const old = await cancelPending(
        tx,
        emit,
        actor,
        meta,
        paymentsOf.get(targetId) ?? [],
        'order_merged',
      );
      const updated = await ordersRepo.updateOrderIfVersion(tx, targetId, target.version, {
        subtotalSatang: subtotal,
        totalSatang: subtotal - target.discountSatang,
      });
      if (!updated) throw versionConflict(target.version); // cannot happen under the order locks
      const customerId = target.customerId as string; // mergeEligible refused a guest order
      await replacePayment(tx, ctx, customerId, meta, updated, old, ids.paymentRequestId, emit);
      const settled = await settleAfter(tx, ctx, updated, emit);

      await insertAudit(tx, {
        actorType: actor.kind === 'customer' ? 'customer' : 'system',
        actorId: actor.kind === 'customer' ? actor.customerId : null,
        ip: meta.ip,
        action: AUDIT.merge,
        entity: 'orders',
        entityId: targetId,
        before: { totalSatang: target.totalSatang },
        after: {
          totalSatang: settled.totalSatang,
          sources: sources.map((s) => ({ id: s.id, orderNo: s.orderNo })),
          copiedLines: copying.map((line, i) => ({ from: line.id, to: copied[i]?.id ?? null })),
          ...(ids.idempotencyKey ? { clientRequestId: ids.idempotencyKey } : {}),
        },
      });
      return settled;
    }),
  );
}
