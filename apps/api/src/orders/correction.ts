/**
 * The owner's correction and void of a past order (owner decision, 2026-10-11): any order, even a
 * paid or finished one. Owner only with a fresh step-up (the route guard asks for
 * `order.edit_past`), an audit row with before and after and the reason, and an owner alert.
 * Each change is one transaction under the order lock; events go out after the commit.
 *
 * - Prices: a saved line keeps the price it was sold at; only a NEW line is priced from the menu.
 *   Every total is computed here from the lines. Nothing is deleted: a removed line is marked.
 * - Money: a changed total retires the order's payments through the payment state machine
 *   (`retirePaymentsForOwnerChange`): pending or claimed ones are cancelled, a confirmed one is
 *   voided or refunded as the owner chose. Staff then take the new total with the usual payment
 *   flow. No payment is created here. `paymentAction: 'adjust'` (D-25) keeps the confirmed money
 *   instead: a lower total records a partial refund of the difference, a higher total leaves the
 *   difference for staff to collect. A LINE customer is told afterwards (`notice`).
 * - Status: a void is the order machine's move to `cancelled` (a finished order may make it only
 *   under `order.edit_past`).
 */
import { findAuditByRequestId, insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import {
  type CorrectOrderInput,
  lineTotal,
  type OrderChannel,
  type OrderDto,
  type OrderLineInput,
  type OrderStatus,
  orderMachine,
  priceOrder,
  satang,
  sumSatang,
  type VoidOrderInput,
} from '@sds/shared';
import { z } from 'zod';
import {
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
import { adjustPaymentsForOwnerChange, retirePaymentsForOwnerChange } from '../payments/service.ts';
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';
import type { OrderChangeNotice } from './change-notice.ts';
import { toOrderDto } from './dto.ts';

const modifierDeltas = z.array(z.object({ priceDeltaSatang: z.number().int() }));

/** What an audit row keeps of a line: ids, quantity and amounts, no free text. */
const lineSummary = (item: ordersRepo.OrderItemRow) => ({
  id: item.id,
  menuItemId: item.menuItemId,
  qty: item.qty,
  lineTotalSatang: item.lineTotalSatang,
});

async function dtoOf(
  tx: Parameters<typeof ordersRepo.loadOrderItems>[0],
  row: ordersRepo.OrderRow,
) {
  const items = await ordersRepo.loadOrderItems(tx, [row.id]);
  return toOrderDto(row, items.get(row.id) ?? []);
}

function emitUpserted(emit: Emit, row: ordersRepo.OrderRow, dto: OrderDto) {
  emit({ type: 'order.upserted', id: row.id, rev: row.rev, data: dto });
}

function requireFreshStepUp(ctx: CoreContext, actor: Principal) {
  if (!hasFreshStepUp(actor, ctx.now())) throw stepUpRequired();
}

// ---------- Correct ----------

export async function correctOrder(
  ctx: CoreContext,
  actor: Principal,
  id: string,
  input: CorrectOrderInput,
  meta: RequestMeta,
): Promise<{ order: OrderDto; notice: OrderChangeNotice | null }> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await ordersRepo.lockOrderById(tx, id);
    if (!row) throw notFound('Order');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    requireFreshStepUp(ctx, actor);
    if (row.status === 'cancelled') {
      throw conflict('ORDER_CLOSED', 'A voided order cannot be corrected', { status: row.status });
    }

    const active = (await ordersRepo.loadOrderItems(tx, [id])).get(id) ?? [];
    const before = {
      note: row.note,
      subtotalSatang: row.subtotalSatang,
      totalSatang: row.totalSatang,
      items: active.map(lineSummary),
    };

    let subtotal = row.subtotalSatang;
    const patch: ordersRepo.OrderPatch = {};
    let itemsChanged = false;
    if (input.items) {
      const byId = new Map(active.map((item) => [item.id, item]));
      const seen = new Set<string>();
      const newLines: OrderLineInput[] = [];
      const plan: { item: ordersRepo.OrderItemRow; qty: number; note: string | null }[] = [];
      for (const [index, line] of input.items.entries()) {
        if ('orderItemId' in line) {
          const item = byId.get(line.orderItemId);
          if (!item || seen.has(item.id)) {
            throw new ApiError(422, 'UNKNOWN_ORDER_ITEM', 'That line is not on this order', {
              lineIndex: index,
            });
          }
          seen.add(item.id);
          plan.push({
            item,
            qty: line.qty,
            note: line.note === undefined ? item.note : line.note,
          });
        } else {
          newLines.push({
            menuItemId: line.menuItemId,
            qty: line.qty,
            modifierOptionIds: line.modifierOptionIds,
            note: line.note,
          });
        }
      }

      let pricedNew: ReturnType<typeof priceOrder> | undefined;
      if (newLines.length > 0) {
        const catalog = await ordersRepo.loadCatalog(tx, [
          ...new Set(newLines.map((l) => l.menuItemId)),
        ]);
        pricedNew = priceOrder(row.channel as OrderChannel, newLines, catalog);
        if (!pricedNew.ok) {
          throw new ApiError(422, 'ORDER_INVALID', 'The order cannot be accepted', {
            errors: pricedNew.errors.map((e) => ({ code: e.code, lineIndex: e.lineIndex })),
          });
        }
      }

      const keptTotals = plan.map(({ item, qty }) =>
        lineTotal({
          unitPrice: satang(item.unitPriceSatang),
          qty,
          modifierDeltas: modifierDeltas
            .parse(item.modifiers)
            .map((m) => satang(m.priceDeltaSatang)),
        }),
      );
      const newTotals = pricedNew?.ok ? pricedNew.lines.map((l) => l.lineTotalSatang) : [];
      subtotal = sumSatang([...keptTotals, ...newTotals]);
      if (row.discountSatang > subtotal) {
        throw new ApiError(
          422,
          'DISCOUNT_EXCEEDS_SUBTOTAL',
          'The order discount is larger than the new subtotal',
        );
      }

      for (const [i, { item, qty, note }] of plan.entries()) {
        const total = keptTotals[i] ?? satang(item.lineTotalSatang);
        if (qty !== item.qty || note !== item.note) {
          await ordersRepo.updateOrderItemLine(tx, item.id, {
            qty,
            note,
            lineTotalSatang: total,
          });
          itemsChanged = true;
        }
      }
      const removed = active.filter((item) => !seen.has(item.id)).map((item) => item.id);
      await ordersRepo.markOrderItemsRemoved(tx, removed, ctx.now());
      if (pricedNew?.ok) {
        await ordersRepo.insertOrderItems(
          tx,
          id,
          pricedNew.lines.map((line) => ({
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
      }
      itemsChanged = itemsChanged || removed.length > 0 || newLines.length > 0;
      if (subtotal !== row.subtotalSatang) {
        patch.subtotalSatang = subtotal;
        patch.totalSatang = subtotal - row.discountSatang;
      }
    }
    if (input.note !== undefined && input.note !== row.note) patch.note = input.note;

    const totalChanged = patch.totalSatang !== undefined && patch.totalSatang !== row.totalSatang;
    let refundedSatang = 0;
    let dueSatang = 0;
    if (totalChanged) {
      const payments = await paymentsRepo.listPaymentsForOrder(tx, id);
      const heldMoney = payments.some((p) => p.status === 'claimed' || p.status === 'confirmed');
      if (heldMoney && input.paymentAction === undefined) {
        throw conflict(
          'PAYMENT_ACTION_REQUIRED',
          'The total changes while a payment is claimed or confirmed. Say whether to void or refund it, or adjust it; staff then take the new total or the difference',
          { oldTotalSatang: row.totalSatang, newTotalSatang: patch.totalSatang },
        );
      }
      if (input.paymentAction === 'adjust') {
        const done = await adjustPaymentsForOwnerChange(
          tx,
          ctx,
          actor,
          row,
          patch.totalSatang ?? row.totalSatang,
          input.reason,
          input.refund,
          emit,
          meta,
        );
        patch.paymentStatus = done.paymentStatus;
        refundedSatang = done.refundedSatang;
        dueSatang = done.dueSatang;
      } else if (payments.some((p) => ['pending', 'claimed', 'confirmed'].includes(p.status))) {
        const retired = await retirePaymentsForOwnerChange(
          tx,
          ctx,
          actor,
          row,
          input.reason,
          input.paymentAction,
          emit,
          meta,
        );
        patch.paymentStatus = retired.paymentStatus;
        refundedSatang = retired.refundedSatang;
        // Money was held and is now out of play: the customer owes the whole new total again.
        if (payments.some((p) => p.status === 'confirmed')) {
          dueSatang = patch.totalSatang ?? row.totalSatang;
        }
      }
    } else if (input.refund !== undefined) {
      throw new ApiError(
        422,
        'REFUND_NOT_NEEDED',
        'The total does not change, so nothing is refunded',
      );
    }

    if (Object.keys(patch).length === 0 && !itemsChanged) {
      throw conflict('NOTHING_TO_CHANGE', 'That is already how the order is');
    }
    // An items-only change that left the amounts alone still needs a new version and rev: any
    // UPDATE makes the sync trigger bump both, so write the note back as it is.
    if (Object.keys(patch).length === 0) patch.note = row.note;
    const updated = await ordersRepo.updateOrderIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    const dto = await dtoOf(tx, updated);

    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      ip: meta.ip,
      action: 'order.correct',
      entity: 'orders',
      entityId: id,
      before,
      after: {
        note: updated.note,
        subtotalSatang: updated.subtotalSatang,
        totalSatang: updated.totalSatang,
        items: dto.items.map((item) => ({
          id: item.id,
          menuItemId: item.menuItemId,
          qty: item.qty,
          lineTotalSatang: item.lineTotalSatang,
        })),
        reason: input.reason,
        ...(input.paymentAction ? { paymentAction: input.paymentAction } : {}),
      },
    });
    emit(
      securityAlert(ctx, 'order.correct', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
        subject: { orderId: id },
      }),
    );
    emitUpserted(emit, updated, dto);
    // The customer hears of a change to what they ordered or owe, not of a staff note.
    const notice: OrderChangeNotice | null =
      itemsChanged || totalChanged
        ? {
            kind: 'edit',
            orderId: id,
            version: updated.version,
            totalSatang: updated.totalSatang,
            refundedSatang,
            dueSatang,
          }
        : null;
    return { order: dto, notice };
  });
}

// ---------- Void ----------

/**
 * Cancels any order that is not cancelled yet, with a reason. Retrying with the same
 * `clientRequestId` answers 200 with the order as it is; any other request for an order that is
 * already cancelled is a 409 (the machine has no exit from `cancelled`).
 */
export async function voidOrder(
  ctx: CoreContext,
  actor: Principal,
  id: string,
  input: VoidOrderInput,
  meta: RequestMeta,
): Promise<{ order: OrderDto; replay: boolean; notice: OrderChangeNotice | null }> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await ordersRepo.lockOrderById(tx, id);
    if (!row) throw notFound('Order');
    if (row.status === 'cancelled') {
      const done = await findAuditByRequestId(tx, 'orders', id, input.clientRequestId);
      if (done?.action === 'order.void')
        return { order: await dtoOf(tx, row), replay: true, notice: null };
    }
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw versionConflict(row.version);
    }
    requireFreshStepUp(ctx, actor);

    const move = orderMachine.transition(row.status as OrderStatus, 'cancelled', {
      actor: { kind: 'staff', role: actor.role },
      reason: input.reason,
    });
    if (!move.ok) {
      if (move.error === 'forbidden') throw forbidden();
      if (move.error === 'reason_required') {
        throw new ApiError(400, 'REASON_REQUIRED', 'A reason is required for this change');
      }
      throw conflict('INVALID_TRANSITION', `An order cannot go from ${row.status} to cancelled`, {
        from: row.status,
        to: 'cancelled',
      });
    }

    const retired = await retirePaymentsForOwnerChange(
      tx,
      ctx,
      actor,
      row,
      input.reason,
      input.paymentAction,
      emit,
      meta,
    );
    const updated = await ordersRepo.updateOrderIfVersion(tx, id, row.version, {
      status: 'cancelled',
      cancelledAt: ctx.now(),
      cancelReason: input.reason,
      paymentStatus: retired.paymentStatus,
    });
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    const dto = await dtoOf(tx, updated);
    const { paymentStatus } = retired;

    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      ip: meta.ip,
      action: 'order.void',
      entity: 'orders',
      entityId: id,
      before: {
        status: row.status,
        paymentStatus: row.paymentStatus,
        totalSatang: row.totalSatang,
      },
      after: {
        status: 'cancelled',
        paymentStatus,
        reason: input.reason,
        clientRequestId: input.clientRequestId,
        ...(input.paymentAction ? { paymentAction: input.paymentAction } : {}),
      },
    });
    emit(
      securityAlert(ctx, 'order.void', 'critical', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
        subject: { orderId: id },
      }),
    );
    emitUpserted(emit, updated, dto);
    return {
      order: dto,
      replay: false,
      notice: {
        kind: 'void',
        orderId: id,
        version: updated.version,
        totalSatang: updated.totalSatang,
        refundedSatang: retired.refundedSatang,
        dueSatang: 0,
      },
    };
  });
}
