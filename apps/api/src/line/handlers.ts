import { type Db, lineRepo, ordersRepo } from '@sds/db';
import {
  botText,
  followGreeting,
  type LineClient,
  type LineMessage,
  type LineSender,
  menuLink,
  methodPicker,
  orderConfirmation,
  orderStatusCard,
  payInfoCard,
  paymentInstructions,
  privacyAcknowledged,
  type RoutedEvent,
} from '@sds/line';
import { type MyOrder, PRIVACY_NOTICE_VERSION } from '@sds/shared';
import {
  claimPayment,
  derivedRequestId,
  selectPayment,
  viewOrder,
} from '../customer-app/service.ts';
import { ApiError } from '../errors.ts';
import type { EventBus } from '../events.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { mergeOrders } from '../orders/customer-edit.ts';
import { currentPromptpayId, lineOrderingNow } from '../settings/service.ts';
import { openPromptpayCandidates, planChatSlip, slipFree } from '../slips/allocate.ts';
import { activeSlipChecker } from '../slips/checker.ts';
import { MAX_SLIP_BYTES } from '../slips/image.ts';
import { keepLateSlip, LATE_SLIP_WINDOW_MS } from '../slips/late.ts';
import { looksLikeSlip } from '../slips/qr.ts';
import { attachSlip } from '../slips/service.ts';
import type { SlipStore } from '../slips/store.ts';
import type { CoreContext } from '../tx.ts';
import { receiptItems } from './receipt.ts';
import type { LineRuntime } from './runtime.ts';

export interface HandlerContext {
  db: Db;
  sender: LineSender;
  now: () => Date;
  events: EventBus;
  noticeUrl: string | undefined;
  /** `https://liff.line.me/<id>`: the base of every link a card carries. Undefined: no links. */
  liffUrl: string | undefined;
  privacy: LineRuntime['privacy'];
  contactAlertedAt: LineRuntime['contactAlertedAt'];
  /** Fetches the pictures customers send. Null when LINE is not configured. */
  client: LineClient | null;
  /** Where a slip picture is kept. */
  slips: SlipStore;
}

const CONTACT_ALERT_WINDOW_MS = 10 * 60_000;

/** True (and remembers it) when this customer has not raised a contact alert in the last 10 minutes. */
function contactAlertAllowed(ctx: HandlerContext, userId: string): boolean {
  const now = ctx.now().getTime();
  const last = ctx.contactAlertedAt.get(userId);
  if (last !== undefined && now - last < CONTACT_ALERT_WINDOW_MS) return false;
  for (const [key, at] of ctx.contactAlertedAt) {
    if (now - at >= CONTACT_ALERT_WINDOW_MS) ctx.contactAlertedAt.delete(key);
  }
  ctx.contactAlertedAt.set(userId, now);
  return true;
}

/** A status shown to the customer is about the latest order of the last day, no older. */
const STATUS_WINDOW_MS = 24 * 3_600_000;

/** The catalog text for a key, as a plain string. */
const said = (key: Parameters<typeof botText>[0], params?: Parameters<typeof botText>[1]) =>
  botText(key, params).text;

const core = (ctx: HandlerContext): CoreContext => ({
  db: ctx.db,
  now: ctx.now,
  events: ctx.events,
});

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** What the customer is told when a chat button cannot do what it asked, by the API's own code. */
const REFUSALS: Record<string, Parameters<typeof botText>[0]> = {
  NOT_FOUND: 'lineBot.err.noOrder',
  PAYMENT_NOT_PENDING: 'lineBot.err.claimed',
  ORDER_CLOSED: 'lineBot.err.closed',
  ORDER_ALREADY_PAID: 'lineBot.err.closed',
  GOV_COPAY_UNAVAILABLE: 'lineBot.err.methodUnavailable',
  METHOD_DISABLED: 'lineBot.err.methodUnavailable',
  PROMPTPAY_NOT_CONFIGURED: 'lineBot.err.methodUnavailable',
  NO_PAYMENT_TO_CLAIM: 'lineBot.err.generic',
  AMOUNT_TOO_LARGE: 'lineBot.err.generic',
  NOTHING_TO_PAY: 'lineBot.err.generic',
  SLIP_TOO_LARGE: 'lineBot.err.generic',
  SLIP_TYPE_UNSUPPORTED: 'lineBot.err.generic',
  // Neutral on purpose: the customer is never told why (see `slips/guard.ts`).
  SLIP_COOLDOWN: 'lineBot.err.slipCooldown',
  SLIP_BLOCKED: 'lineBot.err.slipBlocked',
};

/**
 * What the API does for one routed event: followers and the privacy acknowledgement, and the
 * ordering chat (the order confirmation the app asks for, "โอนแล้ว", changing the method, the
 * rich menu's buttons and the keywords). Every answer to something the customer did is a reply
 * (free). A retry has no reply token and so replies nothing; its writes are idempotent.
 *
 * - A chat button never trusts what it carries: the order is looked up among the SENDER's own
 *   orders by the user id LINE put on the event, so someone else's order id finds nothing.
 * - "โอนแล้ว" and a method change go through the same service calls as the customer app, so the
 *   POS hears of them in the same moment, and a claim only ever makes a payment `claimed`.
 * - The ถุงเงิน QR is never sent, and no QR picture is put in a chat card at all (rule 4): the
 *   PromptPay card links to the app, which makes a fresh one each time.
 *
 * Nothing here logs the event: it holds the LINE user id and what the customer typed.
 */
export async function handleEvent(ctx: HandlerContext, event: RoutedEvent): Promise<void> {
  switch (event.kind) {
    case 'follow': {
      const customerId = await lineRepo.upsertFollower(ctx.db, event.userId);
      // Following is not acknowledging: the notice is shown and the customer taps to confirm.
      await ctx.sender.reply(
        event.replyToken,
        followGreeting({
          controller: ctx.privacy.controller,
          contactEmail: ctx.privacy.contactEmail,
          ...(ctx.noticeUrl ? { noticeUrl: ctx.noticeUrl } : {}),
        }),
        { template: 'follow_greeting', customerId },
      );
      return;
    }
    case 'unfollow':
      await lineRepo.markUnfollowed(ctx.db, event.userId, ctx.now());
      return;
    case 'ack_privacy': {
      const customerId = await lineRepo.acknowledgePrivacy(
        ctx.db,
        event.userId,
        ctx.now(),
        PRIVACY_NOTICE_VERSION,
      );
      if (event.replyToken) {
        await ctx.sender.reply(event.replyToken, [privacyAcknowledged()], {
          template: 'privacy_ack',
          customerId,
        });
      }
      return;
    }
    case 'keyword':
      return handleKeyword(ctx, event);
    case 'order_placed':
      return handleOrderPlaced(ctx, event);
    case 'payment_claimed':
      return handleClaim(ctx, event);
    case 'change_method':
      return handleChangeMethod(ctx, event);
    case 'set_method':
      return handleSetMethod(ctx, event);
    case 'slip_image':
      return handleSlip(ctx, event);
    default:
      return;
  }
}

// ---------- Replies ----------

/** Replies when there is a token to reply with; a retried event has none and says nothing. */
async function say(
  ctx: HandlerContext,
  replyToken: string | undefined,
  messages: LineMessage[],
  meta: { template: string; customerId?: string; orderId?: string },
): Promise<void> {
  if (!replyToken) return;
  await ctx.sender.reply(replyToken, messages, meta);
}

/** A refusal the customer should hear about; anything else is a real failure and is rethrown. */
async function refuse(
  ctx: HandlerContext,
  replyToken: string | undefined,
  error: unknown,
  customerId: string,
): Promise<void> {
  if (!(error instanceof ApiError)) throw error;
  const key = REFUSALS[error.code];
  if (!key) throw error;
  // A cooldown says how long to wait, in whole minutes (never 0).
  const wait = Number(error.details.retryAfterSeconds);
  const params =
    error.code === 'SLIP_COOLDOWN' ? { minutes: Math.max(1, Math.ceil(wait / 60)) } : {};
  await say(ctx, replyToken, [botText(key, params)], { template: 'refusal', customerId });
}

/** The page of one order in the customer app, or undefined when there is no app address. */
const orderUrl = (ctx: HandlerContext, orderId: string) =>
  ctx.liffUrl ? `${ctx.liffUrl}/orders/${orderId}` : undefined;

/** The "how to pay" reply for an order as it stands now. Nothing for a paid order. */
async function instructionsFor(ctx: HandlerContext, order: MyOrder): Promise<LineMessage[]> {
  if (order.paymentStatus === 'paid' || order.status === 'cancelled') return [];
  const method = order.payment?.method ?? 'cash';
  const base = { orderNo: order.orderNo, orderId: order.id, totalSatang: order.totalSatang };
  if (method === 'gov_copay') return [paymentInstructions({ ...base, method: 'gov_copay' })];
  if (method !== 'promptpay') return [paymentInstructions({ ...base, method: 'cash' })];

  const target = await currentPromptpayId(ctx.db);
  const url = orderUrl(ctx, order.id);
  if (!target || !url) return [botText('lineBot.err.methodUnavailable')];
  return [
    paymentInstructions({
      ...base,
      method: 'promptpay',
      promptpayId: target.idValue,
      orderUrl: url,
    }),
  ];
}

// ---------- The ordering chat ----------

async function handleOrderPlaced(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'order_placed' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  if (!customer) return;
  // The text anyone can type is only a number: it is matched among THIS sender's orders.
  const row = await ordersRepo.findOrderForCustomerByNo(ctx.db, customer.id, event.orderNo);
  if (!row) return;
  const order = await viewOrder(core(ctx), row);
  await say(
    ctx,
    event.replyToken,
    [
      orderConfirmation({
        orderNo: order.orderNo,
        items: receiptItems(order),
        totalSatang: order.totalSatang,
        building: order.deliveryBuilding ?? '',
        recipientName: order.recipientName ?? '',
      }),
      ...(await instructionsFor(ctx, order)),
    ],
    { template: 'order_confirmation', customerId: customer.id, orderId: order.id },
  );
}

async function handleClaim(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'payment_claimed' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  if (!customer) return;
  try {
    const order = await claimPayment(core(ctx), customer.id, event.orderId, { ip: null });
    // No slip yet: ask for the picture here (a free reply; nothing is pushed later).
    // A slip already sent earlier: only say it is being checked.
    const key = order.hasSlip ? 'lineBot.claim.slipReceived' : 'lineBot.claim.noSlip';
    await say(ctx, event.replyToken, [botText(key, { orderNo: order.orderNo })], {
      template: 'payment_claimed',
      customerId: customer.id,
      orderId: order.id,
    });
  } catch (error) {
    await refuse(ctx, event.replyToken, error, customer.id);
  }
}

/**
 * A picture in the chat. When the sender has a PromptPay payment waiting (D-40 picks which open
 * order), the picture is fetched from LINE, kept as the slip and the payment becomes `claimed`
 * (the same service as the app's upload and the "โอนแล้ว" button); staff still confirm. With no
 * such order, or when the picture is not a bank slip, it is dropped in silence (no reply). A
 * picture that cannot be fetched is not kept and the sender hears the usual reply. A fetch that failed for a reason that may pass is thrown, so the retry sweep tries again.
 */
async function handleSlip(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'slip_image' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  const fetchContent = ctx.client?.getMessageContent?.bind(ctx.client);
  // No order waiting for a payment: nothing to check, nothing to say (no reply, no fetch, no call).
  if (!customer || !fetchContent) return;
  const noOrder = () =>
    say(ctx, event.replyToken, [botText('lineBot.slip.reply')], {
      template: 'slip_received',
      customerId: customer.id,
    });
  const candidates = await openPromptpayCandidates(ctx.db, customer.id);
  // No open order: a slip for an order the unpaid timeout just cancelled is kept for staff (D-41).
  const late =
    candidates.length === 0
      ? await ordersRepo.findTimeoutCancelledOrderForCustomer(
          ctx.db,
          customer.id,
          new Date(ctx.now().getTime() - LATE_SLIP_WINDOW_MS),
        )
      : undefined;
  if (candidates.length === 0 && !late) return;

  const content = await fetchContent(event.messageId, MAX_SLIP_BYTES);
  if (!content.ok) {
    await noOrder();
    if (content.definite) return;
    throw new Error('slip image could not be fetched');
  }
  // Not a bank slip (no slip QR): dropped without a trace, and without a reply.
  if (!(await looksLikeSlip(content.bytes))) return;
  const reply = (order: { id?: string; orderNo: string }) =>
    say(
      ctx,
      event.replyToken,
      [botText('lineBot.claim.slipReceived', { orderNo: order.orderNo })],
      {
        template: 'payment_claimed',
        customerId: customer.id,
        ...(order.id ? { orderId: order.id } : {}),
      },
    );
  try {
    if (late) {
      const kept = await keepLateSlip(core(ctx), ctx.slips, customer.id, late.id, content.bytes, {
        ip: null,
      });
      if (!kept) return noOrder();
      await reply({ id: late.id, orderNo: kept.orderNo });
      return;
    }
    // D-40 (PAY-05): with several open PromptPay orders the amount on the picture, read here for
    // free, chooses the order. It never confirms anything (that is the bank check, D-27).
    let plan = await planChatSlip(
      candidates,
      async () => (await activeSlipChecker()?.readLocalAmount(content.bytes)) ?? null,
    );
    if (plan.kind === 'merge') {
      try {
        const seed = `chat-slip:${event.messageId}`;
        await mergeOrders(
          core(ctx),
          { kind: 'system' },
          plan.targetId,
          plan.sourceIds,
          undefined,
          {
            idempotencyKey: derivedRequestId(`${seed}:merge`),
            paymentRequestId: derivedRequestId(`${seed}:payment`),
          },
          { ip: null },
        );
        plan = { kind: 'attach', orderId: plan.targetId, blocked: false };
      } catch (error) {
        // A merge that is not allowed any more (a discount, a payment that just arrived): staff decide.
        if (!(error instanceof ApiError)) throw error;
        const oldest = slipFree(candidates)[0];
        if (!oldest) throw error;
        plan = { kind: 'attach', orderId: oldest.order.id, blocked: true };
      }
    }
    const order = await attachSlip(
      core(ctx),
      ctx.slips,
      customer.id,
      plan.orderId,
      content.bytes,
      { ip: null },
      plan.blocked ? { autoConfirmBlocked: true } : {},
    );
    await reply(order);
  } catch (error) {
    await refuse(ctx, event.replyToken, error, customer.id);
  }
}

async function handleChangeMethod(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'change_method' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  if (!customer) return;
  const row = await ordersRepo.findOrderForCustomer(ctx.db, customer.id, event.orderId);
  if (!row) {
    await say(ctx, event.replyToken, [botText('lineBot.err.noOrder')], {
      template: 'refusal',
      customerId: customer.id,
    });
    return;
  }
  const order = await viewOrder(core(ctx), row);
  if (!order.actions.changeMethod) {
    const key = order.payment?.status === 'claimed' ? 'lineBot.err.claimed' : 'lineBot.err.closed';
    await say(ctx, event.replyToken, [botText(key)], {
      template: 'refusal',
      customerId: customer.id,
      orderId: order.id,
    });
    return;
  }
  await say(
    ctx,
    event.replyToken,
    [
      methodPicker({
        orderNo: order.orderNo,
        orderId: order.id,
        totalSatang: order.totalSatang,
        methods: order.actions.methods,
      }),
    ],
    { template: 'method_picker', customerId: customer.id, orderId: order.id },
  );
}

async function handleSetMethod(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'set_method' }>,
): Promise<void> {
  // Only the live run: a retry minutes or hours later (no reply token) could undo a newer choice
  // the customer made in the app meanwhile.
  if (!event.replyToken) return;
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  if (!customer) return;
  try {
    const order = await selectPayment(
      core(ctx),
      customer.id,
      event.orderId,
      { method: event.method },
      { ip: null },
    );
    await say(ctx, event.replyToken, await instructionsFor(ctx, order), {
      template: 'payment_instructions',
      customerId: customer.id,
      orderId: order.id,
    });
  } catch (error) {
    await refuse(ctx, event.replyToken, error, customer.id);
  }
}

// ---------- Keywords and the rich menu ----------

/**
 * A chat button (menu, payment, contact, hours, status) is answered once per customer per business
 * day (owner, 2026-10-11); a repeat press the same day sends nothing. The mark is in the database,
 * so it survives a restart. Only the live delivery counts (a retry has no reply token and says
 * nothing anyway, so it must not use up the day), and a send that fails gives the mark back.
 * Replies that carry an order's result (confirmation, slip received, errors) never come here.
 * A customer the bot does not know yet is answered every time: there is no one to key the mark on.
 */
async function oncePerDay(
  ctx: HandlerContext,
  customerId: string | undefined,
  button: string,
  replyToken: string | undefined,
  send: () => Promise<void>,
): Promise<void> {
  if (!customerId || !replyToken) return send();
  const day = await currentBusinessDate(ctx.db, ctx.now());
  if (!(await lineRepo.claimButtonReply(ctx.db, customerId, button, day))) return;
  try {
    await send();
  } catch (error) {
    await lineRepo.releaseButtonReply(ctx.db, customerId, button, day).catch(() => undefined);
    throw error;
  }
}

async function handleKeyword(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'keyword' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  // Staff are still alerted to every contact request (one per 10 minutes); only the reply is limited.
  if (event.keyword === 'contact' && contactAlertAllowed(ctx, event.userId)) {
    ctx.events.publish({
      type: 'alert.security',
      kind: 'line.contact_request',
      severity: 'info',
      at: ctx.now().toISOString(),
      staffId: null,
      deviceId: null,
    });
  }
  return oncePerDay(ctx, customer?.id, event.keyword, event.replyToken, () =>
    answerKeyword(ctx, event, customer?.id),
  );
}

async function answerKeyword(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'keyword' }>,
  customerId: string | undefined,
): Promise<void> {
  const who = customerId ? { customerId } : {};
  switch (event.keyword) {
    case 'menu':
      await say(
        ctx,
        event.replyToken,
        [ctx.liffUrl ? menuLink({ menuUrl: `${ctx.liffUrl}/menu` }) : botText('lineBot.menu.text')],
        { template: 'menu', ...who },
      );
      return;
    case 'payment':
      await say(ctx, event.replyToken, [payInfoCard()], { template: 'pay_info', ...who });
      return;
    case 'contact':
      // Staff answer in OA Manager (the rich-menu tap shows in the chat as "ติดต่อร้าน").
      await say(ctx, event.replyToken, [botText('lineBot.contact.reply')], {
        template: 'contact',
        ...who,
      });
      return;
    case 'hours': {
      const open = await lineOrderingNow(ctx.db, ctx.now());
      const text =
        open.mode === 'open'
          ? said('lineBot.hours.always')
          : open.mode === 'closed'
            ? said('lineBot.hours.paused')
            : open.window
              ? said('lineBot.hours.today', {
                  from: hhmm(open.window.openMinute),
                  to: hhmm(open.window.closeMinute),
                })
              : said('lineBot.hours.closed');
      await say(ctx, event.replyToken, [{ type: 'text', text }], { template: 'hours', ...who });
      return;
    }
    case 'status':
      return handleStatus(ctx, event.replyToken, customerId);
  }
}

/**
 * "สถานะ": the latest order of the last day, as a free reply. No receipt is attached: staff issue
 * one only on request (owner, 2026-10-11).
 */
async function handleStatus(
  ctx: HandlerContext,
  replyToken: string,
  customerId: string | undefined,
): Promise<void> {
  const none = () =>
    say(ctx, replyToken, [botText('lineBot.status.none')], {
      template: 'status',
      ...(customerId ? { customerId } : {}),
    });
  if (!customerId) return none();
  const [latest] = await ordersRepo.listOrdersForCustomer(ctx.db, customerId, 1);
  if (!latest) return none();
  const since =
    ctx.now().getTime() - (latest.completedAt ?? latest.cancelledAt ?? ctx.now()).getTime();
  if (
    (latest.status === 'completed' || latest.status === 'cancelled') &&
    since > STATUS_WINDOW_MS
  ) {
    return none();
  }
  const order = await viewOrder(core(ctx), latest);
  const url = orderUrl(ctx, order.id);
  const messages: LineMessage[] = [
    url
      ? orderStatusCard({
          orderNo: order.orderNo,
          orderStatus: order.status,
          paymentStatus: order.paymentStatus,
          orderUrl: url,
        })
      : botText('lineBot.status.altText', {
          orderNo: order.orderNo,
          status: said(`lineBot.status.${order.status}`),
        }),
  ];
  await say(ctx, replyToken, messages, { template: 'status', customerId, orderId: order.id });
}
