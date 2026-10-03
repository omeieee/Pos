import { z } from 'zod';

/** What a button in a Flex message sends back (`postback.data`, at most 300 characters). */
export type PostbackAction =
  | { action: 'ack_privacy' }
  | { action: 'paid'; orderId: string }
  | { action: 'change_method'; orderId: string };

const uuid = z.uuid();

export function encodePostback(a: PostbackAction): string {
  const params = new URLSearchParams({ action: a.action });
  if (a.action !== 'ack_privacy') params.set('order', a.orderId);
  return params.toString();
}

/** Parses postback data. Anything that is not exactly one of ours is `null`: never trusted. */
export function parsePostback(data: string): PostbackAction | null {
  const params = new URLSearchParams(data);
  const action = params.get('action');
  if (action === 'ack_privacy') return { action };
  if (action === 'paid' || action === 'change_method') {
    const order = uuid.safeParse(params.get('order'));
    return order.success ? { action, orderId: order.data } : null;
  }
  return null;
}
