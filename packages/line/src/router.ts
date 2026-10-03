import { eventUserId, type WebhookEvent } from './events.ts';
import { parseOrderPlacedText } from './order-text.ts';
import { type ChatPayMethod, parsePostback } from './postback.ts';

export const KEYWORDS = {
  menu: 'เมนู',
  status: 'สถานะ',
  contact: 'ติดต่อ',
  payment: 'วิธีชำระเงิน',
  hours: 'เวลาเปิด',
} as const;
export type Keyword = keyof typeof KEYWORDS;

/** What the API should do for one event. `ignore` events are left for staff in OA Manager. */
export type RoutedEvent =
  | { kind: 'follow'; userId: string; replyToken: string }
  | { kind: 'unfollow'; userId: string }
  | { kind: 'ack_privacy'; userId: string; replyToken: string | undefined }
  | { kind: 'payment_claimed'; userId: string; orderId: string; replyToken: string | undefined }
  | { kind: 'change_method'; userId: string; orderId: string; replyToken: string | undefined }
  | {
      kind: 'set_method';
      userId: string;
      orderId: string;
      method: ChatPayMethod;
      replyToken: string | undefined;
    }
  | { kind: 'order_placed'; userId: string; orderNo: string; replyToken: string }
  | { kind: 'keyword'; keyword: Keyword; userId: string; replyToken: string }
  | { kind: 'slip_image'; userId: string; messageId: string; replyToken: string }
  | { kind: 'ignore' };

const IGNORE: RoutedEvent = { kind: 'ignore' };

/** Pure: no I/O, so each event type is covered by a plain table test. */
export function routeEvent(event: WebhookEvent): RoutedEvent {
  const userId = eventUserId(event);
  if (userId === undefined) return IGNORE;

  if (event.type === 'follow' && 'replyToken' in event && event.replyToken) {
    return { kind: 'follow', userId, replyToken: event.replyToken };
  }
  if (event.type === 'unfollow') return { kind: 'unfollow', userId };

  if (event.type === 'postback' && 'postback' in event) {
    const action = parsePostback(event.postback.data);
    const replyToken = 'replyToken' in event ? event.replyToken : undefined;
    if (action === null) return IGNORE;
    if (action.action === 'ack_privacy') return { kind: 'ack_privacy', userId, replyToken };
    // The rich menu's postback areas act like typing the keyword; they need a reply token.
    if (action.action === 'pay_info' || action.action === 'contact') {
      if (!replyToken) return IGNORE;
      return {
        kind: 'keyword',
        keyword: action.action === 'pay_info' ? 'payment' : 'contact',
        userId,
        replyToken,
      };
    }
    if (action.action === 'set_method') {
      return {
        kind: 'set_method',
        userId,
        orderId: action.orderId,
        method: action.method,
        replyToken,
      };
    }
    if (action.action === 'paid') {
      return { kind: 'payment_claimed', userId, orderId: action.orderId, replyToken };
    }
    if (action.action === 'change_method') {
      return { kind: 'change_method', userId, orderId: action.orderId, replyToken };
    }
    return IGNORE;
  }

  if (event.type === 'message' && 'message' in event && 'replyToken' in event) {
    const replyToken = event.replyToken;
    if (!replyToken) return IGNORE;
    const message = event.message;
    if (message.type === 'image' && typeof message.id === 'string') {
      return { kind: 'slip_image', userId, messageId: message.id, replyToken };
    }
    if (message.type === 'text' && 'text' in message) {
      const text = message.text.trim();
      const orderNo = parseOrderPlacedText(text);
      if (orderNo !== null) return { kind: 'order_placed', userId, orderNo, replyToken };
      for (const keyword of Object.keys(KEYWORDS) as Keyword[]) {
        if (text === KEYWORDS[keyword]) return { kind: 'keyword', keyword, userId, replyToken };
      }
    }
  }
  return IGNORE;
}
