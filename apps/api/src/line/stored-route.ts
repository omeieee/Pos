import { KEYWORDS, type Keyword, type RoutedEvent } from '@sds/line';
import { z } from 'zod';

/**
 * What `line_events.route` keeps of an event: the router's result cut to ids and fixed words. No
 * chat text, no reply token (it lives about a minute and is single-use), no raw postback data.
 * It is enough to run the handler again from the retry sweep.
 */
export const storedRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('unfollow'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('ack_privacy'), userId: z.string().min(1) }),
  z.object({
    kind: z.literal('payment_claimed'),
    userId: z.string().min(1),
    orderId: z.uuid(),
  }),
  z.object({ kind: z.literal('change_method'), userId: z.string().min(1), orderId: z.uuid() }),
  z.object({
    kind: z.literal('keyword'),
    keyword: z.enum(Object.keys(KEYWORDS) as [Keyword, ...Keyword[]]),
    userId: z.string().min(1),
  }),
  z.object({ kind: z.literal('slip_image'), userId: z.string().min(1), messageId: z.string() }),
  z.object({ kind: z.literal('ignore') }),
]);
export type StoredRoute = z.infer<typeof storedRouteSchema>;

export function toStoredRoute(event: RoutedEvent): StoredRoute {
  switch (event.kind) {
    case 'follow':
    case 'unfollow':
    case 'ack_privacy':
      return { kind: event.kind, userId: event.userId };
    case 'payment_claimed':
    case 'change_method':
      return { kind: event.kind, userId: event.userId, orderId: event.orderId };
    case 'keyword':
      return { kind: 'keyword', keyword: event.keyword, userId: event.userId };
    case 'slip_image':
      return { kind: 'slip_image', userId: event.userId, messageId: event.messageId };
    case 'ignore':
      return { kind: 'ignore' };
  }
}

/** The routed event again, for a retry. There is no reply token: a retry never answers. */
export function fromStoredRoute(route: StoredRoute): RoutedEvent {
  switch (route.kind) {
    case 'follow':
      return { kind: 'follow', userId: route.userId, replyToken: '' };
    case 'unfollow':
      return route;
    case 'ack_privacy':
      return { kind: 'ack_privacy', userId: route.userId, replyToken: undefined };
    case 'payment_claimed':
    case 'change_method':
      return { ...route, replyToken: undefined };
    case 'keyword':
      return { ...route, replyToken: '' };
    case 'slip_image':
      return { ...route, replyToken: '' };
    case 'ignore':
      return route;
  }
}
