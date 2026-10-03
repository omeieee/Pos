import { z } from 'zod';

/**
 * Webhook payloads (Messaging API). Only the fields the shop uses are named; Zod objects drop the
 * rest. LINE adds event types over time, so an unknown type parses as `unknown` instead of
 * failing: a 4xx for a valid delivery would make LINE redeliver it again and again.
 */
const base = {
  webhookEventId: z.string().min(1).max(64),
  timestamp: z.number().optional(),
  source: z.object({ type: z.string(), userId: z.string().optional() }).optional(),
  deliveryContext: z.object({ isRedelivery: z.boolean() }).optional(),
};

const followEvent = z.object({
  ...base,
  type: z.literal('follow'),
  replyToken: z.string().min(1),
});

const unfollowEvent = z.object({ ...base, type: z.literal('unfollow') });

const textMessage = z.object({
  type: z.literal('text'),
  id: z.string(),
  text: z.string().max(5000),
});
const imageMessage = z.object({ type: z.literal('image'), id: z.string() });
const otherMessage = z.object({ type: z.string(), id: z.string().optional() });

const messageEvent = z.object({
  ...base,
  type: z.literal('message'),
  replyToken: z.string().min(1),
  message: z.union([textMessage, imageMessage, otherMessage]),
});

const postbackEvent = z.object({
  ...base,
  type: z.literal('postback'),
  replyToken: z.string().min(1).optional(),
  postback: z.object({ data: z.string().max(300) }),
});

/** Any event type this code does not handle (join, leave, beacon, ...). It still has an id. */
const unknownEvent = z.object({ ...base, type: z.string() });

export const webhookEventSchema = z.union([
  followEvent,
  unfollowEvent,
  messageEvent,
  postbackEvent,
  unknownEvent,
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** The envelope. `events` is empty for the console's "Verify" button. */
export const webhookBodySchema = z.object({
  destination: z.string().optional(),
  events: z.array(z.unknown()).max(100),
});

/** The user id of an event's source, when it is a user. */
export function eventUserId(event: WebhookEvent): string | undefined {
  return event.source?.type === 'user' ? event.source.userId : undefined;
}
