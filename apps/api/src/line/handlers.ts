import { type Db, lineRepo, ordersRepo } from '@sds/db';
import {
  botText,
  followGreeting,
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
  receiptCard,
} from '@sds/line';
import { type MyOrder, PRIVACY_NOTICE_VERSION, serviceOpenAt } from '@sds/shared';
import { claimPayment, selectPayment, viewOrder } from '../customer-app/service.ts';
import { ApiError } from '../errors.ts';
import type { EventBus } from '../events.ts';
import { currentOpeningHours, currentPromptpayId } from '../settings/service.ts';
import type { CoreContext } from '../tx.ts';
import { methodLabelOf, READY_RECEIPT_TEMPLATE, receiptItems } from './receipt.ts';
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
    case 'slip_image': {
      // The picture itself is not downloaded or kept here: staff see it in OA Manager, and the
      // payment only moves when the customer taps "โอนแล้ว" (and staff confirm).
      const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
      await ctx.sender.reply(event.replyToken, [botText('lineBot.slip.reply')], {
        template: 'slip_received',
        ...(customer ? { customerId: customer.id } : {}),
      });
      return;
    }
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
  await say(ctx, replyToken, [botText(key)], { template: 'refusal', customerId });
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
    await say(ctx, event.replyToken, [botText('lineBot.claim.done', { orderNo: order.orderNo })], {
      template: 'payment_claimed',
      customerId: customer.id,
      orderId: order.id,
    });
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

async function handleKeyword(
  ctx: HandlerContext,
  event: Extract<RoutedEvent, { kind: 'keyword' }>,
): Promise<void> {
  const customer = await lineRepo.findCustomerByLineUserId(ctx.db, event.userId);
  const who = customer ? { customerId: customer.id } : {};
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
      ctx.events.publish({
        type: 'alert.security',
        kind: 'line.contact_request',
        severity: 'info',
        at: ctx.now().toISOString(),
        staffId: null,
        deviceId: null,
      });
      await say(ctx, event.replyToken, [botText('lineBot.contact.reply')], {
        template: 'contact',
        ...who,
      });
      return;
    case 'hours': {
      const open = serviceOpenAt(await currentOpeningHours(ctx.db), ctx.now(), 'delivery');
      const text = open.window
        ? said('lineBot.hours.today', {
            from: hhmm(open.window.openMinute),
            to: hhmm(open.window.closeMinute),
          })
        : said('lineBot.hours.closed');
      await say(ctx, event.replyToken, [{ type: 'text', text }], { template: 'hours', ...who });
      return;
    }
    case 'status':
      return handleStatus(ctx, event.replyToken, customer?.id);
  }
}

/**
 * "สถานะ": the latest order of the last day. When that order is completed and the one
 * "ready + receipt" push never went out (policy off, or the month's quota was used up), the
 * e-receipt comes here instead, as a free reply: the receipt is never lost to the quota.
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
  if (
    order.status === 'completed' &&
    !(await lineRepo.hasPushForOrder(ctx.db, order.id, READY_RECEIPT_TEMPLATE))
  ) {
    messages.push(
      receiptCard({
        orderNo: order.orderNo,
        building: order.deliveryBuilding ?? '',
        items: receiptItems(order),
        totalSatang: order.totalSatang,
        methodLabel: methodLabelOf(order),
      }),
    );
  }
  await say(ctx, replyToken, messages, { template: 'status', customerId, orderId: order.id });
}
