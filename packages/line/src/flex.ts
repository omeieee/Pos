import { formatBaht, type Locale, t } from '@sds/i18n';
import { encodePostback } from './postback.ts';

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
 * How to pay, per method. Only PromptPay carries a QR picture. The government co-pay variant has
 * no QR input at all: the scheme QR is created per transaction by staff in ถุงเงิน face to face
 * and is never sent through LINE (CLAUDE.md rule 4).
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
      /** https URL of the server-built PromptPay QR for exactly `totalSatang`. */
      qrImageUrl: string;
    }
);

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
  let hero: FlexNode | undefined;

  if (input.method === 'cash') {
    body.push(text(t(locale, 'lineBot.pay.cash', { amount })));
  } else if (input.method === 'gov_copay') {
    body.push(text(t(locale, 'lineBot.pay.govCopay', { amount })));
    body.push(text(t(locale, 'lineBot.pay.govCopayNote'), { size: 'sm', color: '#666666' }));
  } else {
    if (!input.qrImageUrl.startsWith('https://')) {
      throw new RangeError('the PromptPay QR image URL must be https');
    }
    hero = {
      type: 'image',
      url: input.qrImageUrl,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'fit',
    };
    body.push(text(t(locale, 'lineBot.pay.promptpay', { promptpayId: input.promptpayId, amount })));
    body.push(text(t(locale, 'lineBot.pay.promptpayAfter'), { size: 'sm', color: '#666666' }));
    footer.push(
      postbackButton(
        t(locale, 'lineBot.pay.paidButton'),
        encodePostback({ action: 'paid', orderId: input.orderId }),
        true,
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
    contents: bubble(body, footer, hero),
  };
}

export interface ReadyReceiptInput {
  orderNo: string;
  building: string;
  items: readonly ReceiptItem[];
  totalSatang: number;
  /** The payment method's display name, already translated. */
  methodLabel: string;
}

/** The one push per LINE order: "ready" and the e-receipt together. */
export function readyWithReceipt(input: ReadyReceiptInput, locale: Locale = 'th'): FlexMessage {
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
      separator,
      text(t(locale, 'lineBot.receipt.title'), { weight: 'bold', size: 'sm' }),
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
