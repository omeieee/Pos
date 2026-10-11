/**
 * What a customer can do (docs/04 §1.5, CLAUDE.md rules 1, 2, 4, 5). Every function takes the
 * customer's own id from the verified session (or from a verified chat event) and reads and
 * writes ONLY that customer's orders: a foreign order id is a plain 404.
 *
 * - The server prices the order and fixes channel (`line`) and fulfilment (entrance delivery).
 * - Orders and payments go through the same services staff use (`createOrder`, `createPayment`,
 *   `movePayment`), with the customer as the actor, so the state machines in `@sds/shared` decide
 *   and the POS gets the same events: a new LINE order chimes the kitchen, and a claim reaches
 *   every device as `payment.upserted` in the same transaction that makes it.
 * - A customer's "โอนแล้ว" only makes a PromptPay payment `claimed`. Staff confirm (rule 2).
 * - Cash and ไทยช่วยไทย leave no QR anywhere: cash is paid at the hand-over and recorded by staff;
 *   ไทยช่วยไทย is a pending payment staff handle face to face (rule 4).
 */
import { createHash } from 'node:crypto';
import { customersRepo, type Db, lineRepo, ordersRepo, paymentsRepo } from '@sds/db';
import {
  type AppOrderInput,
  type AppOrderResult,
  type AppPayMethod,
  type CheckoutInfo,
  type CustomerSessionResponse,
  MAX_ORDER_QUANTITY,
  type MemberInput,
  type MemberProfile,
  type MemberResponse,
  type MyOrder,
  type MyOrdersResponse,
  type MyQrResponse,
  mergeMember,
  myOrderSchema,
  PRIVACY_NOTICE_VERSION,
  type PrivacyAckResponse,
  type SelectPaymentInput,
} from '@sds/shared';
import { z } from 'zod';
import type { AuthContext, RequestMeta } from '../auth/service.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { createOrder } from '../orders/service.ts';
import {
  type CustomerActor,
  changePaymentMethod,
  createPayment,
  type MoveInput,
  movePayment,
  paymentQrUrl,
  withdrawPendingPayment,
} from '../payments/service.ts';
import {
  currentDeliverySettings,
  currentPaymentsSettings,
  currentPromptpayId,
  currentShopPhone,
  lineOrderingNow,
} from '../settings/service.ts';
import type { CoreContext } from '../tx.ts';
import { CUSTOMER_SESSION_SECONDS, type CustomerPrincipal, signCustomerToken } from './session.ts';

/** How many of their latest orders the app lists. */
const MY_ORDERS_LIMIT = 10;

const actorOf = (customerId: string): CustomerActor => ({ kind: 'customer', customerId });

/**
 * A UUID made from a seed (SHA-256, version 8), so one request that needs two idempotency keys
 * (the order and its first payment) derives the second from the first and a retry reuses it.
 */
export function derivedRequestId(seed: string): string {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Session and privacy ----------

export async function openSession(
  ctx: AuthContext,
  lineUserId: string,
): Promise<CustomerSessionResponse> {
  const customer = await lineRepo.upsertLiffCustomer(ctx.db, lineUserId);
  const expires = Math.floor(ctx.now().getTime() / 1000) + CUSTOMER_SESSION_SECONDS;
  return {
    token: signCustomerToken(ctx.keys.customerSessionKey, customer.id, expires),
    expiresAt: new Date(expires * 1000).toISOString(),
    privacyAcknowledged: customer.privacyAckVersion === PRIVACY_NOTICE_VERSION,
    privacyVersion: PRIVACY_NOTICE_VERSION,
  };
}

/** Stores that the customer saw the current notice (time and version). The same call as the chat button. */
export async function acknowledgePrivacy(
  ctx: CoreContext,
  customer: CustomerPrincipal,
): Promise<PrivacyAckResponse> {
  await lineRepo.acknowledgePrivacy(ctx.db, customer.lineUserId, ctx.now(), PRIVACY_NOTICE_VERSION);
  return { privacyAcknowledged: true, privacyVersion: PRIVACY_NOTICE_VERSION };
}

// ---------- The member page ----------

/** The profile, or null when nothing is saved (every field empty). */
const memberOrNull = (profile: MemberProfile): MemberResponse['member'] =>
  Object.values(profile).every((v) => v === null) ? null : profile;

export async function getMember(
  ctx: CoreContext,
  customer: CustomerPrincipal,
): Promise<MemberResponse> {
  return {
    member: memberOrNull(await customersRepo.getMemberProfile(ctx.db, customer.customerId)),
  };
}

/**
 * Saves the member form on the customer only (no order): a field left out keeps its value, an empty
 * one clears it. Like placing an order, it needs the current privacy notice acknowledged. Nothing
 * here is logged or audited with the values.
 */
export async function saveMember(
  ctx: CoreContext,
  customer: CustomerPrincipal,
  input: MemberInput,
): Promise<MemberResponse> {
  if (customer.privacyAckVersion !== PRIVACY_NOTICE_VERSION) {
    throw new ApiError(
      403,
      'PRIVACY_NOT_ACKNOWLEDGED',
      'Please read and accept the privacy notice first',
    );
  }
  const merged = await ctx.db.transaction(async (tx) => {
    const next = mergeMember(await customersRepo.getMemberProfile(tx, customer.customerId), input);
    await customersRepo.saveMemberProfile(tx, customer.customerId, next);
    return next;
  });
  return { member: memberOrNull(merged) };
}

// ---------- What is on offer right now ----------

/**
 * The methods a LINE customer can pick right now. PromptPay needs the owner's switch and a
 * PromptPay ID; cash needs the owner's switch. ไทยช่วยไทย is always listed: choosing it only tells
 * staff the customer wants it, and staff check the scheme at the hand-over (`insertPaymentFor`
 * records no scheme figures when the scheme is not running).
 */
export async function methodsOffered(db: Db): Promise<AppPayMethod[]> {
  const settings = await currentPaymentsSettings(db);
  const methods: AppPayMethod[] = [];
  if (settings.cash) methods.push('cash');
  if (settings.promptpay && (await currentPromptpayId(db)) !== null) methods.push('promptpay');
  methods.push('gov_copay');
  return methods;
}

export async function checkoutInfo(
  ctx: CoreContext,
  customer: CustomerPrincipal,
): Promise<CheckoutInfo> {
  const now = ctx.now();
  const open = await lineOrderingNow(ctx.db, now);
  const recipient = await ordersRepo.latestRecipientForCustomer(ctx.db, customer.customerId);
  return {
    delivery: open,
    buildings: (await currentDeliverySettings(ctx.db)).buildings,
    methods: await methodsOffered(ctx.db),
    lastRecipient: recipient ?? null,
    member: await customersRepo.getMemberProfile(ctx.db, customer.customerId),
    privacyAcknowledged: customer.privacyAckVersion === PRIVACY_NOTICE_VERSION,
    privacyVersion: PRIVACY_NOTICE_VERSION,
    promptpayConfigured: (await currentPromptpayId(ctx.db)) !== null,
    shopPhone: await currentShopPhone(ctx.db),
  };
}

// ---------- The customer's view of an order ----------

const CLOSED = new Set(['completed', 'cancelled']);

/** Only the names of the saved modifiers: prices and costs are not for the customer's view. */
const modifierNames = z.array(z.object({ nameTh: z.string(), nameEn: z.string().nullable() }));

/** The order as the customer sees it, with what they may do next decided here, not in the app. */
export async function viewOrder(ctx: CoreContext, order: ordersRepo.OrderRow): Promise<MyOrder> {
  const items = (await ordersRepo.loadOrderItems(ctx.db, [order.id])).get(order.id) ?? [];
  const payments = await paymentsRepo.listPaymentsForOrder(ctx.db, order.id);
  const open = payments.find((p) => p.status === 'pending' || p.status === 'claimed');
  const confirmed = [...payments].reverse().find((p) => p.status === 'confirmed');
  const payment = open ?? confirmed ?? null;

  const closed = CLOSED.has(order.status);
  const settled = payments.some((p) => p.status === 'claimed' || p.status === 'confirmed');
  const canChange = !closed && !settled;
  return myOrderSchema.parse({
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotalSatang: order.subtotalSatang,
    totalSatang: order.totalSatang,
    items: items.map((item) => ({
      nameTh: item.nameThSnapshot,
      nameEn: item.nameEnSnapshot,
      qty: item.qty,
      modifiers: modifierNames.parse(item.modifiers),
      note: item.note,
      lineTotalSatang: item.lineTotalSatang,
    })),
    deliveryBuilding: order.deliveryBuilding,
    recipientName: order.recipientName,
    deliveryNote: order.deliveryNote,
    note: order.note,
    placedAt: order.placedAt.toISOString(),
    readyAt: order.readyAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    payment: payment
      ? {
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amountSatang: payment.amountSatang,
        }
      : null,
    actions: {
      claim: !closed && open?.method === 'promptpay' && open.status === 'pending',
      changeMethod: canChange,
      showQr: !closed && open?.method === 'promptpay',
      attachSlip: !closed && open?.method === 'promptpay',
      methods: canChange ? await methodsOffered(ctx.db) : [],
    },
  });
}

/** One of the customer's own orders, or 404. The filter in the query is the ownership check. */
async function ownOrder(db: Db, customerId: string, orderId: string): Promise<ordersRepo.OrderRow> {
  const order = await ordersRepo.findOrderForCustomer(db, customerId, orderId);
  if (!order) throw notFound('Order');
  return order;
}

export async function listMyOrders(
  ctx: CoreContext,
  customer: CustomerPrincipal,
): Promise<MyOrdersResponse> {
  const rows = await ordersRepo.listOrdersForCustomer(ctx.db, customer.customerId, MY_ORDERS_LIMIT);
  return { orders: await Promise.all(rows.map((row) => viewOrder(ctx, row))) };
}

export async function getMyOrder(
  ctx: CoreContext,
  customer: CustomerPrincipal,
  orderId: string,
): Promise<MyOrder> {
  return viewOrder(ctx, await ownOrder(ctx.db, customer.customerId, orderId));
}

// ---------- Placing an order ----------

/** The method is on offer now, or the order is refused before anything is written. */
async function assertMethodOffered(db: Db, method: AppPayMethod): Promise<void> {
  if (!(await methodsOffered(db)).includes(method)) {
    throw new ApiError(422, 'METHOD_UNAVAILABLE', 'That payment method is not available right now');
  }
}

/**
 * Places a LINE order for this customer, idempotent by `clientRequestId`: the same request again
 * returns the same order with `replay: true` (nothing is written, so no second chime and no second
 * payment), and the same id on another customer's order is refused. A retry therefore skips the
 * opening-hours and method checks: the order already exists.
 */
export async function placeOrder(
  ctx: AuthContext,
  customer: CustomerPrincipal,
  input: AppOrderInput,
  meta: RequestMeta,
): Promise<AppOrderResult> {
  const now = ctx.now();
  const existing = await ordersRepo.findOrderByClientRequestId(ctx.db, input.clientRequestId);
  if (existing && existing.customerId !== customer.customerId) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different order. Make a new request id for a new order',
    );
  }
  if (!existing) {
    if (customer.privacyAckVersion !== PRIVACY_NOTICE_VERSION) {
      throw new ApiError(
        403,
        'PRIVACY_NOT_ACKNOWLEDGED',
        'Please read and accept the privacy notice first',
      );
    }
    const open = await lineOrderingNow(ctx.db, now);
    if (!open.open) {
      throw conflict('SHOP_CLOSED', 'The shop is not taking LINE orders right now', {
        window: open.window,
        mode: open.mode,
      });
    }
    await assertMethodOffered(ctx.db, input.paymentMethod);
    const quantity = input.items.reduce((sum, line) => sum + line.qty, 0);
    if (quantity > MAX_ORDER_QUANTITY) {
      throw new ApiError(422, 'ORDER_TOO_LARGE', 'That is too many items for one order', {
        max: MAX_ORDER_QUANTITY,
      });
    }
  }

  const { order, replay } = await createOrder(
    ctx,
    null,
    {
      clientRequestId: input.clientRequestId,
      channel: 'line',
      fulfillment: 'entrance_delivery',
      customerId: customer.customerId,
      deliveryBuilding: input.deliveryBuilding,
      recipientName: input.recipientName,
      ...(input.deliveryNote ? { deliveryNote: input.deliveryNote } : {}),
      ...(input.note ? { note: input.note } : {}),
      items: input.items,
    },
    input.member,
  );
  if (order.customerId !== customer.customerId) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different order',
    );
  }

  let paymentError: string | null = null;
  if (input.paymentMethod !== 'cash') {
    try {
      await createPayment(
        ctx,
        actorOf(customer.customerId),
        order.id,
        {
          method: input.paymentMethod,
          clientRequestId: derivedRequestId(`order-payment:${input.clientRequestId}`),
        },
        meta,
      );
    } catch (error) {
      // The order stands (and staff see it); the customer picks a method again on the order page.
      if (!(error instanceof ApiError)) throw error;
      paymentError = error.code;
    }
  }
  const row = await ordersRepo.findOrderById(ctx.db, order.id);
  if (!row) throw notFound('Order');
  return { order: await viewOrder(ctx, row), paymentError, replay };
}

// ---------- Paying ----------

/**
 * Chooses or changes how this order will be paid, for the app and for the chat button alike.
 * - cash: drops a waiting PromptPay or co-pay payment; nothing is recorded for cash (staff take it
 *   at the hand-over);
 * - PromptPay or ไทยช่วยไทย: starts the payment, or swaps the waiting one (the same
 *   cancel-and-create staff use), or does nothing when it is already the waiting method.
 * A payment the customer already reported (`claimed`), or a paid or closed order, cannot change.
 */
export async function selectPayment(
  ctx: CoreContext,
  customerId: string,
  orderId: string,
  input: SelectPaymentInput,
  meta: RequestMeta,
): Promise<MyOrder> {
  const order = await ownOrder(ctx.db, customerId, orderId);
  const actor = actorOf(customerId);
  if (input.method === 'cash') {
    await withdrawPendingPayment(ctx, actor, order.id, meta);
    return viewOrder(ctx, await ownOrder(ctx.db, customerId, orderId));
  }
  const payments = await paymentsRepo.listPaymentsForOrder(ctx.db, order.id);
  const waiting = payments.find((p) => p.status === 'pending' || p.status === 'claimed');
  const clientRequestId = input.clientRequestId ?? crypto.randomUUID();
  if (waiting?.status === 'claimed') {
    throw conflict(
      'PAYMENT_NOT_PENDING',
      'Only a payment that is still pending can change method',
      { status: 'claimed' },
    );
  }
  if (!waiting) {
    await createPayment(ctx, actor, order.id, { method: input.method, clientRequestId }, meta);
  } else if (waiting.method !== input.method) {
    await changePaymentMethod(
      ctx,
      actor,
      waiting.id,
      { method: input.method, clientRequestId },
      meta,
    );
  }
  return viewOrder(ctx, await ownOrder(ctx.db, customerId, orderId));
}

/**
 * "โอนแล้ว": the customer says they transferred. Only a pending PromptPay payment can be claimed,
 * and it only becomes `claimed`: staff check the bank app and confirm (rule 2). The same service
 * call as a staff claim, so every device gets `payment.upserted` as the transaction commits.
 * Claiming again answers 200 with nothing written.
 */
export async function claimPayment(
  ctx: CoreContext,
  customerId: string,
  orderId: string,
  meta: RequestMeta,
  slip?: MoveInput['slip'],
): Promise<MyOrder> {
  const order = await ownOrder(ctx.db, customerId, orderId);
  const payments = await paymentsRepo.listPaymentsForOrder(ctx.db, order.id);
  const waiting = payments.find((p) => p.status === 'pending' || p.status === 'claimed');
  if (!waiting || waiting.method !== 'promptpay') {
    throw conflict('NO_PAYMENT_TO_CLAIM', 'There is no PromptPay payment waiting for this order');
  }
  await movePayment(ctx, actorOf(customerId), waiting.id, 'claim', slip ? { slip } : {}, meta);
  return viewOrder(ctx, await ownOrder(ctx.db, customerId, orderId));
}

/**
 * A fresh signed link to the PromptPay QR of this customer's own order. Rebuilt for the exact
 * order total from the CURRENT PromptPay ID every time the picture is fetched; the link lasts
 * five minutes, so the app asks again whenever it shows the QR.
 */
export async function myQr(
  ctx: AuthContext,
  customerId: string,
  orderId: string,
): Promise<MyQrResponse> {
  const order = await ownOrder(ctx.db, customerId, orderId);
  const payments = await paymentsRepo.listPaymentsForOrder(ctx.db, order.id);
  const waiting = payments.find(
    (p) => p.method === 'promptpay' && (p.status === 'pending' || p.status === 'claimed'),
  );
  if (!waiting || CLOSED.has(order.status)) {
    throw conflict('QR_NOT_AVAILABLE', 'There is no PromptPay QR for this order');
  }
  const link = await paymentQrUrl(ctx, waiting.id);
  const target = await currentPromptpayId(ctx.db);
  if (!target) throw conflict('PROMPTPAY_NOT_CONFIGURED', 'No PromptPay ID is set');
  return {
    url: link.url,
    expiresAt: link.expiresAt,
    amountSatang: waiting.amountSatang,
    promptpayId: target.idValue,
  };
}
