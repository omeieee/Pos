/**
 * Orders (D-04, 02 §4–6). Every write is one transaction that bumps version and rev (the sync
 * trigger does it) and publishes its events only after the commit. Status changes go through the
 * state machine in `@sds/shared`; the server prices every order from the menu.
 */
import { customersRepo, type Db, insertAudit, ordersRepo } from '@sds/db';
import {
  allowedFulfillments,
  businessDate,
  type CreateOrderInput,
  initialOrderStatus,
  type ListOrdersQuery,
  type ListOrdersResponse,
  ORDER_NO_PREFIX,
  type OrderDto,
  type OrderStatus,
  orderMachine,
  type PatchOrderInput,
  type PricingError,
  priceOrder,
  recipientKey,
  type TransitionError,
  type TransitionOrderInput,
} from '@sds/shared';
import {
  assertOriginalStaffExists,
  assertReplayOriginalStaff,
  requireOwnerForOriginalStaff,
} from '../admin/original-staff.ts';
import { hasFreshStepUp, type Principal } from '../auth/service.ts';
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  stepUpRequired,
  versionConflict,
} from '../errors.ts';
import { settlePaymentsForOrderCancel } from '../payments/service.ts';
import { currentDeliverySettings } from '../settings/service.ts';
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';
import { currentBusinessDate, loadBusinessDay } from './business-day.ts';
import { toOrderDto } from './dto.ts';
import { orderRequestHash } from './request-hash.ts';

/** Another request with the same client request id committed first. Thrown to undo our counter step. */
class DuplicateRequest extends Error {}

async function withItems(db: Db, order: ordersRepo.OrderRow): Promise<OrderDto> {
  const items = await ordersRepo.loadOrderItems(db, [order.id]);
  return toOrderDto(order, items.get(order.id) ?? []);
}

/**
 * A request id that was seen before: the same content gets the original order back; different
 * content is refused (a client bug or a clash must not look like success). An order saved
 * before the fingerprint existed has none, and counts as a plain retry.
 */
async function replayOf(
  db: Db,
  existing: ordersRepo.OrderRow,
  requestHash: string,
  originalStaffId: string | undefined,
): Promise<{ order: OrderDto; replay: true }> {
  if (existing.requestHash !== null && existing.requestHash !== requestHash) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different order. Make a new request id for a new order',
    );
  }
  assertReplayOriginalStaff(
    { originalStaffId: existing.originalStaffId, creatorStaffId: existing.createdByStaffId },
    originalStaffId,
  );
  return { order: await withItems(db, existing), replay: true };
}

function emitUpserted(emit: Emit, order: ordersRepo.OrderRow, dto: OrderDto) {
  emit({ type: 'order.upserted', id: order.id, rev: order.rev, data: dto });
}

const orderInvalid = (errors: readonly PricingError[]) =>
  new ApiError(422, 'ORDER_INVALID', 'The order cannot be accepted', {
    errors: errors.map((e) => ({
      code: e.code,
      lineIndex: e.lineIndex,
      menuItemId: e.menuItemId,
      ...(e.groupId ? { groupId: e.groupId } : {}),
      ...(e.optionId ? { optionId: e.optionId } : {}),
    })),
  });

// ---------- Create ----------

/**
 * `replay` is true when the request id was seen before: the original order comes back and
 * nothing is written, so a retry (or an offline outbox replay) never duplicates an order.
 */
export async function createOrder(
  ctx: CoreContext,
  actor: Principal,
  input: CreateOrderInput,
): Promise<{ order: OrderDto; replay: boolean }> {
  // Owner decision 2026-10-02: each channel offers one way to be served (entrance delivery for
  // storefront, LINE and phone; the platform's for Grab and LINE MAN). Checked before anything is
  // written or numbered; a replay of an order that was already saved still gets it back below.
  const allowed = allowedFulfillments(input.channel);
  if (!allowed.includes(input.fulfillment)) {
    throw new ApiError(
      422,
      'FULFILLMENT_NOT_OFFERED',
      'This channel does not offer that way of receiving the order',
      { channel: input.channel, fulfillment: input.fulfillment, allowed: [...allowed] },
    );
  }

  requireOwnerForOriginalStaff(actor, input.originalStaffId, ctx.now());
  const requestHash = orderRequestHash(input);
  const existing = await ordersRepo.findOrderByClientRequestId(ctx.db, input.clientRequestId);
  if (existing) return replayOf(ctx.db, existing, requestHash, input.originalStaffId);

  const now = ctx.now();
  const day = await loadBusinessDay(ctx.db);
  const date = businessDate(now, day.cutoffMinutes, day.timeZone);

  try {
    const order = await withTransaction(ctx, async (tx, emit) => {
      if (input.customerId && !(await ordersRepo.customerExists(tx, input.customerId))) {
        throw new ApiError(422, 'UNKNOWN_CUSTOMER', 'That customer does not exist');
      }
      if (input.originalStaffId !== undefined) {
        await assertOriginalStaffExists(tx, input.originalStaffId);
      }
      // The building must be one the shop delivers to, from the saved list (or the default).
      if (
        input.deliveryBuilding !== undefined &&
        !(await currentDeliverySettings(tx)).buildings.includes(input.deliveryBuilding)
      ) {
        throw new ApiError(422, 'UNKNOWN_BUILDING', 'The shop does not deliver to that building');
      }
      const itemIds = [...new Set(input.items.map((i) => i.menuItemId))];
      const catalog = await ordersRepo.loadCatalog(tx, itemIds);
      const priced = priceOrder(input.channel, input.items, catalog);
      if (!priced.ok) throw orderInvalid(priced.errors);

      // Only after the order has been accepted does it take a number, in the same transaction.
      const seq = await ordersRepo.nextDailySeq(tx, date);

      // An entrance delivery remembers its recipient (automatic customer memory, owner
      // 2026-10-02) in this same transaction: find or create the customer by building and name
      // (or use the given customer id), record the order on them, and link the order. A replayed
      // request returned above and never gets here, so nothing counts twice; if this transaction
      // fails or loses a duplicate-request race, the customer and the count roll back with it.
      const customerId =
        input.deliveryBuilding !== undefined && input.recipientName !== undefined
          ? await customersRepo.recordRecipientOrder(
              tx,
              {
                building: input.deliveryBuilding,
                recipientName: input.recipientName,
                recipientKey: recipientKey(input.recipientName),
                deliveryNote: input.deliveryNote || null,
              },
              now,
              input.customerId,
            )
          : (input.customerId ?? null);
      const status = initialOrderStatus(input.channel);
      const row = await ordersRepo.insertOrder(tx, {
        orderNo: `${ORDER_NO_PREFIX[input.channel]}-${String(seq).padStart(3, '0')}`,
        businessDate: date,
        channel: input.channel,
        fulfillment: input.fulfillment,
        roomNo: input.roomNo ?? null,
        deliveryBuilding: input.deliveryBuilding ?? null,
        recipientName: input.recipientName ?? null,
        deliveryNote: input.deliveryNote || null,
        customerId,
        status,
        subtotalSatang: priced.totals.subtotal,
        discountSatang: priced.totals.discount,
        totalSatang: priced.totals.total,
        note: input.note ?? null,
        createdByStaffId: actor.staffId,
        createdOnDeviceId: actor.deviceId,
        originalStaffId: input.originalStaffId ?? null,
        clientRequestId: input.clientRequestId,
        requestHash,
        placedAt: now,
        acceptedAt: status === 'preparing' ? now : null,
      });
      if (!row) throw new DuplicateRequest();
      if (input.originalStaffId !== undefined) {
        await insertAudit(tx, {
          actorType: 'staff',
          actorId: actor.staffId,
          deviceId: actor.deviceId,
          action: 'order.create_on_behalf',
          entity: 'orders',
          entityId: row.id,
          after: { originalStaffId: input.originalStaffId },
        });
      }

      const items = await ordersRepo.insertOrderItems(
        tx,
        row.id,
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
      const dto = toOrderDto(row, items);
      emitUpserted(emit, row, dto);
      emit({
        type: 'alert.new_order',
        orderId: row.id,
        orderNo: row.orderNo,
        channel: input.channel,
        status,
        createdOnDeviceId: actor.deviceId,
      });
      return dto;
    });
    return { order, replay: false };
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) throw error;
    // The transaction was rolled back (no number used); the request that won is committed.
    const winner = await ordersRepo.findOrderByClientRequestId(ctx.db, input.clientRequestId);
    if (!winner) throw error;
    return replayOf(ctx.db, winner, requestHash, input.originalStaffId);
  }
}

// ---------- Read ----------

export async function listOrdersForDay(
  ctx: CoreContext,
  query: ListOrdersQuery,
): Promise<ListOrdersResponse> {
  const day = query.day ?? (await currentBusinessDate(ctx.db, ctx.now()));
  const rows = await ordersRepo.listOrders(ctx.db, {
    businessDate: day,
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
  });
  const items = await ordersRepo.loadOrderItems(
    ctx.db,
    rows.map((r) => r.id),
  );
  return { day, orders: rows.map((row) => toOrderDto(row, items.get(row.id) ?? [])) };
}

export async function getOrder(ctx: CoreContext, id: string): Promise<OrderDto> {
  const row = await ordersRepo.findOrderById(ctx.db, id);
  if (!row) throw notFound('Order');
  return withItems(ctx.db, row);
}

// ---------- Change ----------

const isClosed = (status: string) => status === 'completed' || status === 'cancelled';

/** Non-money fields only: note and room number. Items and totals are never edited here. */
export async function patchOrder(
  ctx: CoreContext,
  id: string,
  input: PatchOrderInput,
): Promise<OrderDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await ordersRepo.lockOrderById(tx, id);
    if (!row) throw notFound('Order');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (isClosed(row.status)) {
      throw conflict('ORDER_CLOSED', 'A finished order cannot be edited', { status: row.status });
    }
    const roomNo = input.roomNo === undefined ? row.roomNo : input.roomNo;
    if (row.fulfillment === 'room_delivery' && roomNo === null) {
      throw new ApiError(400, 'ROOM_REQUIRED', 'A room delivery needs a room number');
    }

    const patch: ordersRepo.OrderPatch = {};
    if (input.note !== undefined) patch.note = input.note;
    if (input.roomNo !== undefined) patch.roomNo = input.roomNo;
    const updated = await ordersRepo.updateOrderIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    const dto = await withItems(tx, updated);
    emitUpserted(emit, updated, dto);
    return dto;
  });
}

function transitionFailure(error: TransitionError, from: string, to: string): ApiError {
  switch (error) {
    case 'invalid_transition':
      return conflict('INVALID_TRANSITION', `An order cannot go from ${from} to ${to}`, {
        from,
        to,
      });
    case 'forbidden':
      return forbidden();
    case 'reason_required':
      return new ApiError(400, 'REASON_REQUIRED', 'A reason is required for this change');
  }
}

/** The timestamp columns that belong to each new status. */
function stampsFor(to: OrderStatus, now: Date, reason: string | undefined): ordersRepo.OrderPatch {
  switch (to) {
    case 'preparing':
      return { status: to, acceptedAt: now };
    case 'ready':
      return { status: to, readyAt: now };
    case 'completed':
      return { status: to, completedAt: now };
    case 'cancelled':
      return { status: to, cancelledAt: now, cancelReason: reason ?? '' };
    case 'new':
      return { status: to };
  }
}

/**
 * Moves an order to another status. The state machine decides whether the move exists, whether
 * this role may make it, and whether it needs a reason or a step-up. `cancel` is the same move
 * to `cancelled`, and it also settles the order's payments (see `settlePaymentsForOrderCancel`):
 * pending ones are cancelled with it, and a claimed or confirmed one refuses the cancel.
 */
export async function transitionOrder(
  ctx: CoreContext,
  actor: Principal,
  id: string,
  input: TransitionOrderInput,
): Promise<OrderDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await ordersRepo.lockOrderById(tx, id);
    if (!row) throw notFound('Order');
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw versionConflict(row.version);
    }

    const reason = input.reason?.trim() || undefined;
    const result = orderMachine.transition(row.status as OrderStatus, input.to, {
      actor: { kind: 'staff', role: actor.role },
      reason,
    });
    if (!result.ok) throw transitionFailure(result.error, row.status, input.to);
    if (result.stepUp && !hasFreshStepUp(actor, ctx.now())) throw stepUpRequired();

    const patch = stampsFor(input.to, ctx.now(), reason);
    if (input.to === 'cancelled') {
      patch.paymentStatus = await settlePaymentsForOrderCancel(tx, row, emit);
    }
    const updated = await ordersRepo.updateOrderIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    const dto = await withItems(tx, updated);
    emitUpserted(emit, updated, dto);
    return dto;
  });
}
