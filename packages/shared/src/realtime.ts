/**
 * Realtime and catch-up sync shapes (D-04, 02 §5). Pure: no I/O.
 *
 * One list of frames serves both paths: `WS /v1/ws` pushes a frame per change after commit, and
 * `GET /v1/sync?since=` returns the same frames for everything newer than the client's `lastRev`,
 * so a client has one reducer. A frame is `{type, id, rev, data}` (menu frames add `kind`,
 * settings frames add `version`). Every `data` is parsed through the same DTO schema the REST
 * routes use, and a schema drops unknown keys, so a column added to a table later cannot reach a
 * device by accident. Settings frames are default-deny: a key that is not listed here is refused.
 *
 * Client rules:
 * - key the store by `(type, kind?, id)` and apply a frame only if `frame.rev` is greater than the
 *   stored `rev` of that entity;
 * - start every catch-up from `max(0, lastRev - SYNC_SAFETY_REVS)`: revs are taken when a row is
 *   written, so a slow transaction can commit after a newer one. Replaying a few frames is
 *   harmless because of the rev rule above.
 */
import { z } from 'zod';
import { ORDER_STATUSES } from './enums.ts';
import { categoryDtoSchema, groupDtoSchema, itemDtoSchema, optionDtoSchema } from './menu.ts';
import { orderDtoSchema } from './orders.ts';
import { paymentDtoSchema } from './payments.ts';
import {
  businessDaySettingsSchema,
  nonNegativeSatangSchema,
  orderChannelSchema,
} from './schemas.ts';
import {
  govCopayDtoSchema,
  openingHoursSchema,
  paymentsSettingsSchema,
  shopSettingsSchema,
} from './settings.ts';

// ---------- Constants a client needs ----------

/**
 * WebSocket close codes. 4401 and 4403 mean "sign in again": do not reconnect with the same
 * credentials. Everything else (1001, 1006, 4408, 4429) means "retry with backoff".
 */
export const WS_CLOSE = {
  /** The server is shutting down or restarting. */
  GOING_AWAY: 1001,
  /** Something broke on the server while handling the connection. Retry with backoff. */
  INTERNAL: 1011,
  /** A message above the size cap (sent by the protocol layer itself). */
  MESSAGE_TOO_BIG: 1009,
  /** Not JSON, not a known message, or a message at the wrong time. */
  BAD_MESSAGE: 4400,
  /** Unknown, expired, idle or revoked session; also a later logout. */
  UNAUTHENTICATED: 4401,
  /** A PIN session sent without the token of the device it was opened on. */
  FORBIDDEN: 4403,
  /** No auth message within the deadline. */
  AUTH_TIMEOUT: 4408,
  /** Too many sockets (per IP, per session or overall) or too many messages. */
  TOO_MANY: 4429,
} as const;
export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** The first message must arrive within this long of the connection opening. */
export const WS_AUTH_TIMEOUT_MS = 5000;
/** The server pings every this many seconds; a client that hears nothing for twice that is dead. */
export const WS_HEARTBEAT_SECONDS = 25;
/** The largest message a client may send; the auth message is far below it. */
export const WS_MAX_CLIENT_MESSAGE_BYTES = 2048;

export const SYNC_DEFAULT_LIMIT = 200;
export const SYNC_MAX_LIMIT = 500;
/** Rewind before each catch-up (see the header). Generous: staff and device writes use revs too. */
export const SYNC_SAFETY_REVS = 200;

// ---------- What a client sends ----------

/** The same shape the REST guard accepts for a bearer token and a device token. */
const token = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);

export const wsAuthMessageSchema = z.strictObject({
  type: z.literal('auth'),
  sessionToken: token,
  /** Required for a PIN session (it is bound to its device); ignored for an owner session. */
  deviceToken: token.optional(),
});
export type WsAuthMessage = z.infer<typeof wsAuthMessageSchema>;

/** Optional answer to a `ping` frame. Browsers cannot see protocol pings, so this is the app-level one. */
export const wsPongMessageSchema = z.strictObject({ type: z.literal('pong') });

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  wsAuthMessageSchema,
  wsPongMessageSchema,
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

// ---------- What the server sends ----------

const rev = z.number().int().min(0);
const version = z.number().int().min(1);

export const orderUpsertedFrameSchema = z.object({
  type: z.literal('order.upserted'),
  id: z.uuid(),
  rev,
  data: orderDtoSchema,
});

export const paymentUpsertedFrameSchema = z.object({
  type: z.literal('payment.upserted'),
  id: z.uuid(),
  rev,
  data: paymentDtoSchema,
});

const menuFrame = <K extends string, D extends z.ZodType>(kind: K, data: D) =>
  z.object({
    type: z.literal('menu.upserted'),
    kind: z.literal(kind),
    id: z.uuid(),
    rev,
    data,
  });

/** A group's `options` are a convenience copy: apply each by its own rev (they also arrive as `option` frames). */
export const menuUpsertedFrameSchema = z.union([
  menuFrame('category', categoryDtoSchema),
  menuFrame('item', itemDtoSchema),
  menuFrame('group', groupDtoSchema),
  menuFrame('option', optionDtoSchema),
]);

/** What the PromptPay setting looks like outside the owner's screen: the type and the masked tail. */
export const promptpayMaskedSchema = z.object({
  idType: z.enum(['phone', 'national_id', 'ewallet']),
  idMasked: z.string().min(1).max(40),
});
export type PromptpayMasked = z.infer<typeof promptpayMaskedSchema>;

const settingsFrame = <K extends string, D extends z.ZodType>(key: K, data: D) =>
  z.object({
    type: z.literal('settings.updated'),
    /** The settings key (`shop`, `promptpay`, `gov_copay` ...). */
    id: z.literal(key),
    rev,
    version,
    data,
  });

/**
 * Default deny: only these keys travel, each through its own schema. A setting added later (a LINE
 * secret, say) stays out of the feed until someone lists it here on purpose.
 */
export const settingsUpdatedFrameSchema = z.union([
  settingsFrame('shop', shopSettingsSchema),
  settingsFrame('opening_hours', openingHoursSchema),
  settingsFrame('business_day', businessDaySettingsSchema),
  settingsFrame('payment_methods', paymentsSettingsSchema),
  settingsFrame('promptpay', promptpayMaskedSchema),
  settingsFrame('gov_copay', govCopayDtoSchema),
]);
/** The keys above, for the database layer that decides which setting rows to read at all. */
export const SYNCED_SETTING_KEYS = [
  'shop',
  'opening_hours',
  'business_day',
  'payment_methods',
  'promptpay',
] as const;

/**
 * A customer as staff see them in the feed. Deliberately small (PDPA): no LINE user id, phone,
 * picture, note or consent dates. Nothing publishes it yet; the customer module comes with P4.
 */
export const customerDtoSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  nickname: z.string().nullable(),
  roomNo: z.string().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastOrderAt: z.iso.datetime().nullable(),
  orderCount: z.number().int().min(0),
  totalSpentSatang: nonNegativeSatangSchema,
  anonymized: z.boolean(),
  version,
  rev,
});
export type CustomerDto = z.infer<typeof customerDtoSchema>;

export const customerUpsertedFrameSchema = z.object({
  type: z.literal('customer.upserted'),
  id: z.uuid(),
  rev,
  data: customerDtoSchema,
});

/** Plays the new-order sound. Not a stored row: no `rev`, never applied to the store, never moves `lastRev`. */
export const newOrderAlertFrameSchema = z.object({
  type: z.literal('alert.new_order'),
  id: z.uuid(),
  data: z.object({
    orderNo: z.string(),
    channel: orderChannelSchema,
    status: z.enum(ORDER_STATUSES),
    createdOnDeviceId: z.uuid().nullable(),
  }),
});

/** Every type of frame. An audience is chosen for each in the API; a new one must be listed here. */
export const FRAME_TYPES = [
  'order.upserted',
  'payment.upserted',
  'menu.upserted',
  'settings.updated',
  'customer.upserted',
  'alert.new_order',
] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

/** The frames that describe a stored row: what `GET /v1/sync` returns. */
export const syncChangeSchema = z.union([
  orderUpsertedFrameSchema,
  paymentUpsertedFrameSchema,
  menuUpsertedFrameSchema,
  settingsUpdatedFrameSchema,
  customerUpsertedFrameSchema,
]);
export type SyncChange = z.infer<typeof syncChangeSchema>;

export const realtimeFrameSchema = z.union([syncChangeSchema, newOrderAlertFrameSchema]);
export type RealtimeFrame = z.infer<typeof realtimeFrameSchema>;

export const wsReadyMessageSchema = z.object({
  type: z.literal('ready'),
  /** The newest rev the server has handed out; below your `lastRev` means the database was restored. */
  serverRev: rev,
  heartbeatSeconds: z.number().int().min(1),
});

export const wsPingMessageSchema = z.object({ type: z.literal('ping'), serverRev: rev });

export const wsServerMessageSchema = z.union([
  wsReadyMessageSchema,
  wsPingMessageSchema,
  realtimeFrameSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

// ---------- GET /v1/sync ----------

export const syncQuerySchema = z.strictObject({
  /** The highest rev the client has seen (minus the safety rewind); 0 for a fresh device. */
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(SYNC_MAX_LIMIT).default(SYNC_DEFAULT_LIMIT),
});
export type SyncQuery = z.infer<typeof syncQuerySchema>;

export const syncResponseSchema = z.object({
  /** In rev order, oldest first. Only what the signed-in role may see. */
  changes: z.array(syncChangeSchema),
  /** Ask for this next. It moves with every page, including pages with nothing the role may see. */
  nextSince: rev,
  hasMore: z.boolean(),
  /** The newest rev the server has handed out. */
  serverRev: rev,
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
