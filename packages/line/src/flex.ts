import { formatBaht, type Locale, type MessageKey, type MessageParams, t } from '@sds/i18n';
import { type ChatPayMethod, encodePostback } from './postback.ts';

/** The parts of the LINE Flex Message format this shop uses. */
export type FlexNode = { type: string; [key: string]: unknown };
export interface FlexMessage {
  type: 'flex';
  /** Shown in notifications and chat lists. Required by LINE, at most 400 characters. */
  altText: string;
  contents: FlexNode;
}
export interface TextMessage {
  type: 'text';
  text: string;
}
export type LineMessage = FlexMessage | TextMessage;

/** A plain text reply from the message catalog (Thai by default). */
export function botText(
  key: MessageKey,
  params?: MessageParams,
  locale: Locale = 'th',
): TextMessage {
  return { type: 'text', text: t(locale, key, params) };
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  lineTotalSatang: number;
}

const text = (value: string, extra: Record<string, unknown> = {}): FlexNode => ({
  type: 'text',
  text: value,
  wrap: true,
  ...extra,
});

const row = (left: string, right: string, bold = false): FlexNode => ({
  type: 'box',
  layout: 'horizontal',
  contents: [
    text(left, { flex: 4, size: 'sm', ...(bold ? { weight: 'bold' } : {}) }),
    text(right, { flex: 2, size: 'sm', align: 'end', ...(bold ? { weight: 'bold' } : {}) }),
  ],
});

const itemRows = (items: readonly ReceiptItem[], locale: Locale): FlexNode[] =>
  items.map((i) => row(`${i.quantity} × ${i.name}`, formatBaht(i.lineTotalSatang, locale)));

const bubble = (body: FlexNode[], footer?: FlexNode[], hero?: FlexNode): FlexNode => ({
  type: 'bubble',
  ...(hero ? { hero } : {}),
  body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
  ...(footer && footer.length > 0
    ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
    : {}),
});

const separator: FlexNode = { type: 'separator' };

const postbackButton = (label: string, data: string, primary = false): FlexNode => ({
  type: 'button',
  style: primary ? 'primary' : 'secondary',
  action: { type: 'postback', label, data },
});

/** Altered by `t` only; amounts always go through `formatBaht` from integer satang. */
export interface OrderConfirmationInput {
  orderNo: string;
  items: readonly ReceiptItem[];
  totalSatang: number;
  building: string;
  recipientName: string;
}

export function orderConfirmation(
  input: OrderConfirmationInput,
  locale: Locale = 'th',
): FlexMessage {
  const total = formatBaht(input.totalSatang, locale);
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.order.altText', { orderNo: input.orderNo, total }),
    contents: bubble([
      text(t(locale, 'lineBot.order.title', { orderNo: input.orderNo }), {
        weight: 'bold',
        size: 'lg',
      }),
      text(
        t(locale, 'lineBot.order.deliverTo', {
          building: input.building,
          name: input.recipientName,
        }),
        { size: 'sm', color: '#666666' },
      ),
      separator,
      ...itemRows(input.items, locale),
      separator,
      row(t(locale, 'lineBot.order.total'), total, true),
    ]),
  };
}

/**
 * How to pay, per method. NO method carries a QR picture: a Flex image URL must stay valid for
 * as long as the chat message is read, and the signed QR links last five minutes. PromptPay gets
 * the shop's PromptPay ID and the exact amount as text plus a button that opens the customer app's
 * order page, which shows a freshly made QR every time. The government co-pay variant has no QR
 * and no link at all: staff handle it with the customer face to face at the hand-over and the
 * scheme QR is never sent through LINE (CLAUDE.md rule 4).
 */
export type PaymentInstructionsInput = {
  orderNo: string;
  orderId: string;
  /** The server-computed total. */
  totalSatang: number;
} & (
  | { method: 'cash' }
  | { method: 'gov_copay' }
  | {
      method: 'promptpay';
      /** The shop's PromptPay ID, shown in the text with the exact amount. */
      promptpayId: string;
      /** https URL of the customer app's page for this order (it makes the QR when opened). */
      orderUrl: string;
    }
);

const uriButton = (label: string, uri: string, primary = false): FlexNode => {
  if (!uri.startsWith('https://')) throw new RangeError('a button link must be https');
  return {
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    action: { type: 'uri', label, uri },
  };
};

export function paymentInstructions(
  input: PaymentInstructionsInput,
  locale: Locale = 'th',
): FlexMessage {
  const amount = formatBaht(input.totalSatang, locale);
  const body: FlexNode[] = [
    text(t(locale, 'lineBot.pay.title', { orderNo: input.orderNo }), {
      weight: 'bold',
      size: 'lg',
    }),
  ];
  const footer: FlexNode[] = [];

  if (input.method === 'cash') {
    body.push(text(t(locale, 'lineBot.pay.cash', { amount })));
  } else if (input.method === 'gov_copay') {
    body.push(text(t(locale, 'lineBot.pay.govCopay', { amount })));
    body.push(text(t(locale, 'lineBot.pay.govCopayNote'), { size: 'sm', color: '#666666' }));
  } else {
    body.push(text(t(locale, 'lineBot.pay.promptpay', { promptpayId: input.promptpayId, amount })));
    body.push(text(t(locale, 'lineBot.pay.qrNote'), { size: 'sm', color: '#666666' }));
    body.push(text(t(locale, 'lineBot.pay.promptpayAfter'), { size: 'sm', color: '#666666' }));
    footer.push(uriButton(t(locale, 'lineBot.pay.openQr'), input.orderUrl, true));
    footer.push(
      postbackButton(
        t(locale, 'lineBot.pay.paidButton'),
        encodePostback({ action: 'paid', orderId: input.orderId }),
      ),
    );
  }
  footer.push(
    postbackButton(
      t(locale, 'lineBot.pay.changeButton'),
      encodePostback({ action: 'change_method', orderId: input.orderId }),
    ),
  );

  return {
    type: 'flex',
    altText: t(locale, 'lineBot.pay.altText', { orderNo: input.orderNo, total: amount }),
    contents: bubble(body, footer),
  };
}

export interface MethodPickerInput {
  orderNo: string;
  orderId: string;
  totalSatang: number;
  /** The methods on offer right now (already filtered by the server). */
  methods: readonly ChatPayMethod[];
}

/** "Change payment method": one button per method on offer. */
export function methodPicker(input: MethodPickerInput, locale: Locale = 'th'): FlexMessage {
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.pick.altText', { orderNo: input.orderNo }),
    contents: bubble(
      [
        text(t(locale, 'lineBot.pick.title', { orderNo: input.orderNo }), {
          weight: 'bold',
          size: 'lg',
        }),
        text(t(locale, 'lineBot.pick.hint', { amount: formatBaht(input.totalSatang, locale) }), {
          size: 'sm',
          color: '#666666',
        }),
      ],
      input.methods.map((method) =>
        postbackButton(
          t(locale, `payment.method.${method}`),
          encodePostback({ action: 'set_method', orderId: input.orderId, method }),
        ),
      ),
    ),
  };
}

export interface OrderStatusInput {
  orderNo: string;
  orderStatus: 'new' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  paymentStatus: 'unpaid' | 'awaiting_confirmation' | 'partially_paid' | 'paid' | 'refunded';
  /** https URL of the customer app's page for this order. */
  orderUrl: string;
}

/** The reply to "สถานะ": where the order is and what the payment says. */
export function orderStatusCard(input: OrderStatusInput, locale: Locale = 'th'): FlexMessage {
  const status = t(locale, `lineBot.status.${input.orderStatus}`);
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.status.altText', { orderNo: input.orderNo, status }),
    contents: bubble(
      [
        text(t(locale, 'lineBot.status.title', { orderNo: input.orderNo }), {
          weight: 'bold',
          size: 'lg',
        }),
        text(t(locale, 'lineBot.status.order', { status })),
        text(
          t(locale, 'lineBot.status.payment', {
            payment: t(locale, `status.payment.${input.paymentStatus}`),
          }),
        ),
      ],
      [uriButton(t(locale, 'lineBot.status.open'), input.orderUrl, true)],
    ),
  };
}

/** The reply to "เมนู": a link to the customer app. */
export function menuLink(input: { menuUrl: string }, locale: Locale = 'th'): FlexMessage {
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.menu.open'),
    contents: bubble(
      [text(t(locale, 'lineBot.menu.text'))],
      [uriButton(t(locale, 'lineBot.menu.open'), input.menuUrl, true)],
    ),
  };
}

/**
 * The reply to the rich menu's "วิธีชำระเงิน": the three methods in words. It is not about one
 * order, so it has no amount, no ID and no QR; co-pay is a displayed option only.
 */
export function payInfoCard(locale: Locale = 'th'): FlexMessage {
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.payInfo.altText'),
    contents: bubble([
      text(t(locale, 'lineBot.payInfo.title'), { weight: 'bold', size: 'lg' }),
      text(t(locale, 'lineBot.payInfo.promptpay'), { size: 'sm' }),
      text(t(locale, 'lineBot.payInfo.cash'), { size: 'sm' }),
      text(t(locale, 'lineBot.payInfo.govCopay'), { size: 'sm' }),
    ]),
  };
}

export interface ReadyInput {
  orderNo: string;
  building: string;
}

/** The one push per LINE order: the food is ready at the building entrance. No receipt (owner, 2026-10-11). */
export function readyCard(input: ReadyInput, locale: Locale = 'th'): FlexMessage {
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.ready.altText', { orderNo: input.orderNo }),
    contents: bubble([
      text(t(locale, 'lineBot.ready.title', { orderNo: input.orderNo }), {
        weight: 'bold',
        size: 'lg',
      }),
      text(t(locale, 'lineBot.ready.body', { orderNo: input.orderNo, building: input.building }), {
        size: 'sm',
      }),
    ]),
  };
}

export interface ReceiptInput {
  orderNo: string;
  building: string;
  items: readonly ReceiptItem[];
  totalSatang: number;
  methodLabel: string;
}

/** The e-receipt card. It is never sent on its own; staff issue it on request. */
export function receiptCard(input: ReceiptInput, locale: Locale = 'th'): FlexMessage {
  return {
    type: 'flex',
    altText: t(locale, 'lineBot.receipt.altText', { orderNo: input.orderNo }),
    contents: bubble([
      text(`${t(locale, 'lineBot.receipt.title')} · ${input.orderNo}`, {
        weight: 'bold',
        size: 'sm',
      }),
      text(t(locale, 'lineBot.receipt.deliveredTo', { building: input.building }), {
        size: 'xs',
        color: '#666666',
      }),
      ...itemRows(input.items, locale),
      separator,
      row(t(locale, 'lineBot.receipt.total'), formatBaht(input.totalSatang, locale), true),
      text(t(locale, 'lineBot.receipt.method', { method: input.methodLabel }), {
        size: 'xs',
        color: '#666666',
      }),
      text(t(locale, 'lineBot.receipt.thanks'), { size: 'xs', color: '#666666' }),
    ]),
  };
}

export interface GreetingInput {
  /** The data controller named in the notice (an individual: "omeie"). */
  controller: string;
  /** Where to send data requests. */
  contactEmail: string;
  /** Link to the full notice, only when one is published. */
  noticeUrl?: string;
}

/** The reply to a `follow` event: a greeting, then the privacy summary with an acknowledge button. */
export function followGreeting(input: GreetingInput, locale: Locale = 'th'): LineMessage[] {
  const footer: FlexNode[] = [];
  if (input.noticeUrl !== undefined) {
    if (!input.noticeUrl.startsWith('https://')) throw new RangeError('noticeUrl must be https');
    footer.push({
      type: 'button',
      style: 'link',
      action: { type: 'uri', label: t(locale, 'lineBot.privacy.readNotice'), uri: input.noticeUrl },
    });
  }
  footer.push(
    postbackButton(
      t(locale, 'lineBot.privacy.ackButton'),
      encodePostback({ action: 'ack_privacy' }),
      true,
    ),
  );
  return [
    { type: 'text', text: `${t(locale, 'lineBot.greeting')}\n${t(locale, 'lineBot.greetingHow')}` },
    {
      type: 'flex',
      altText: t(locale, 'lineBot.privacy.title'),
      contents: bubble(
        [
          text(t(locale, 'lineBot.privacy.title'), { weight: 'bold' }),
          text(
            t(locale, 'lineBot.privacy.summary', {
              controller: input.controller,
              contact: input.contactEmail,
            }),
            { size: 'sm' },
          ),
        ],
        footer,
      ),
    },
  ];
}

export function privacyAcknowledged(locale: Locale = 'th'): TextMessage {
  return { type: 'text', text: t(locale, 'lineBot.privacy.acked') };
}
