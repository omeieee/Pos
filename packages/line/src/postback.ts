import { z } from 'zod';

/** The methods a customer can pick from a chat button. */
export const CHAT_PAY_METHODS = ['cash', 'promptpay', 'gov_copay'] as const;
export type ChatPayMethod = (typeof CHAT_PAY_METHODS)[number];

/**
 * What a button in a Flex message (or a rich-menu postback area) sends back (`postback.data`, at
 * most 300 characters).
 */
export type PostbackAction =
  | { action: 'ack_privacy' }
  | { action: 'paid'; orderId: string }
  | { action: 'change_method'; orderId: string }
  | { action: 'set_method'; orderId: string; method: ChatPayMethod }
  /** Rich menu "วิธีชำระเงิน" (`rm=pay-info`). */
  | { action: 'pay_info' }
  /** Rich menu "ติดต่อร้าน" (`rm=contact`). */
  | { action: 'contact' };

const uuid = z.uuid();

export function encodePostback(a: PostbackAction): string {
  if (a.action === 'pay_info') return 'rm=pay-info';
  if (a.action === 'contact') return 'rm=contact';
  const params = new URLSearchParams({ action: a.action });
  if (a.action !== 'ack_privacy') params.set('order', a.orderId);
  if (a.action === 'set_method') params.set('method', a.method);
  return params.toString();
}

/** Parses postback data. Anything that is not exactly one of ours is `null`: never trusted. */
export function parsePostback(data: string): PostbackAction | null {
  const params = new URLSearchParams(data);
  const rm = params.get('rm');
  if (rm === 'pay-info') return { action: 'pay_info' };
  if (rm === 'contact') return { action: 'contact' };
  const action = params.get('action');
  if (action === 'ack_privacy') return { action };
  if (action === 'paid' || action === 'change_method') {
    const order = uuid.safeParse(params.get('order'));
    return order.success ? { action, orderId: order.data } : null;
  }
  if (action === 'set_method') {
    const order = uuid.safeParse(params.get('order'));
    const method = z.enum(CHAT_PAY_METHODS).safeParse(params.get('method'));
    return order.success && method.success
      ? { action, orderId: order.data, method: method.data }
      : null;
  }
  return null;
}
