/**
 * The offline outbox as pure functions (no React, no I/O): the shape of a queued entry, the
 * provisional label, how a failed replay is classified, the backoff, and what a person may see.
 *
 * What an entry holds is only what the order needs: item ids, quantities, chosen options, notes
 * and (for a delivery) the building and the recipient name as the order carries them. The recipient
 * name is personal data (PDPA): it lives only inside the entry, is never logged and never put in a
 * URL, and the entry is removed once the server has the order. No token, no QR link and no
 * PromptPay ID is ever stored here.
 *
 * Money: nothing here adds prices. The estimate shown for a queued order is the shared pricing
 * (`priceCart`); the real total is the server's, after the replay.
 */
import type { OrderChannel } from '@sds/shared';
import { z } from 'zod';
import type { NewOrderInput } from '../api/client.ts';
import { isApiClientError } from '../api/errors.ts';
import type { OutboxEntry } from '../platform/localStore.ts';
import type { EntityState } from '../realtime/entity-store.ts';
import { type CartLine, priceCart } from './cart-pricing.ts';

/** How many entries one device keeps in total (all people on it). Past this, saving is refused. */
export const MAX_QUEUE = 50;
/** After this many failed tries an entry is shown as stuck (it is still retried). */
export const STUCK_AFTER = 5;

export const KIND_ORDER = 'order.create';
export const KIND_CASH = 'payment.cash';

// ---------- What is stored ----------

const nameSchema = z.object({ th: z.string(), en: z.string().nullable() });

const orderPayloadSchema = z.object({
  /** The exact request body of the first attempt: a replay sends this and nothing rebuilt. */
  body: z.custom<NewOrderInput>((value) => typeof value === 'object' && value !== null),
  label: z.string().min(1),
  /** What the order page shows without the menu (a reload while offline has no menu). */
  lines: z.array(
    z.object({
      name: nameSchema,
      options: z.array(nameSchema),
      qty: z.number().int(),
      note: z.string(),
      lineTotalSatang: z.number().int().nullable(),
    }),
  ),
  /** The estimate at the time of saving; null when it could not be worked out. */
  estimateSatang: z.number().int().nullable(),
});
export type OrderPayload = z.infer<typeof orderPayloadSchema>;
export type OrderLineView = OrderPayload['lines'][number];

const paymentPayloadSchema = z.object({
  /** The order entry this payment waits for, or the server order once it is known. */
  target: z.union([z.object({ entryId: z.string() }), z.object({ orderId: z.uuid() })]),
  tenderedSatang: z.number().int().positive(),
  /** The label of the order, for the screens. */
  label: z.string().min(1),
  /** The total the change was shown against: an estimate for an order not synced yet. */
  totalSatang: z.number().int().nullable(),
  /** The tender was changed after it was first saved (and before it was sent). */
  changed: z.boolean().optional(),
});
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;

/** The error codes kept on an entry: only a code, never a message. */
export const ERROR_NOT_UNDERSTOOD = 'ENTRY_UNREADABLE';
export const ERROR_PARENT_MISSING = 'ORDER_ENTRY_MISSING';
const ERROR_REUSED = 'IDEMPOTENCY_KEY_REUSED';

export type QueueState = 'queued' | 'attention' | 'blocked';

interface QueueBase {
  id: string;
  createdAt: number;
  /** Failed tries so far (this run). */
  attempts: number;
  /**
   * `queued`: will be sent. `attention`: the server refused it, or it cannot be read. `blocked`:
   * a payment whose order needs attention first.
   */
  state: QueueState;
  /** The error code of the last refusal. */
  error: string | null;
  /** Tried many times without an answer; still retried. */
  stuck: boolean;
  /** A retry is allowed (a reused request id can only be discarded). */
  canRetry: boolean;
  label: string;
}

export interface QueuedOrder extends QueueBase {
  kind: 'order';
  channel: OrderChannel;
  /** "B1 · Fah", or null for an order without a recipient (a platform order). */
  recipient: { building: string; name: string; note: string | null } | null;
  lines: OrderLineView[];
  estimateSatang: number | null;
  note: string | null;
}

export interface QueuedPayment extends QueueBase {
  kind: 'payment';
  /** The server order, once known. */
  orderId: string | null;
  /** The order entry it waits for, until that one has synced. */
  dependsOn: string | null;
  tenderedSatang: number;
  totalSatang: number | null;
  /** The tender was changed after it was first saved. */
  tenderChanged: boolean;
  /** Not sent yet and not refused: the amount can still be corrected. */
  canChangeTender: boolean;
}

export type QueueItem = QueuedOrder | QueuedPayment;

const unreadable = (entry: OutboxEntry): QueuedOrder => ({
  id: entry.id,
  kind: 'order',
  createdAt: entry.createdAt,
  attempts: entry.attempts,
  state: 'attention',
  error: ERROR_NOT_UNDERSTOOD,
  stuck: false,
  canRetry: false,
  label: '?',
  channel: 'storefront',
  recipient: null,
  lines: [],
  estimateSatang: null,
  note: null,
});

function toBase(
  entry: OutboxEntry,
  attempts: number,
  label: string,
): Omit<QueueBase, 'state' | 'canRetry'> & { error: string | null } {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    attempts,
    error: entry.lastError ?? null,
    stuck: attempts >= STUCK_AFTER,
    label,
  };
}

/**
 * The entries a person may see, parsed and with the derived state. `attempts` are this run's failed
 * tries by id. A payment is `blocked` while its order entry needs attention (it is never sent
 * before its order), and needs attention itself when the order entry is gone.
 */
export function toQueueItems(
  entries: readonly OutboxEntry[],
  attempts: ReadonlyMap<string, number> = new Map(),
): QueueItem[] {
  const parsedOrders = new Map<string, { entry: OutboxEntry; payload: OrderPayload }>();
  for (const entry of entries) {
    if (entry.kind !== KIND_ORDER) continue;
    const parsed = orderPayloadSchema.safeParse(entry.payload);
    if (parsed.success) parsedOrders.set(entry.id, { entry, payload: parsed.data });
  }

  const items: QueueItem[] = [];
  for (const entry of entries) {
    const tries = attempts.get(entry.id) ?? entry.attempts;
    if (entry.kind === KIND_ORDER) {
      const found = parsedOrders.get(entry.id);
      if (!found) {
        items.push(unreadable(entry));
        continue;
      }
      const { payload } = found;
      const body = payload.body;
      const base = toBase(entry, tries, payload.label);
      const attention = entry.state === 'attention';
      items.push({
        ...base,
        kind: 'order',
        state: attention ? 'attention' : 'queued',
        canRetry: attention && base.error !== ERROR_REUSED,
        channel: body.channel,
        recipient:
          body.deliveryBuilding !== undefined && body.recipientName !== undefined
            ? {
                building: body.deliveryBuilding,
                name: body.recipientName,
                note: body.deliveryNote ?? null,
              }
            : null,
        lines: payload.lines,
        estimateSatang: payload.estimateSatang,
        note: body.note ?? null,
      });
    } else if (entry.kind === KIND_CASH) {
      const parsed = paymentPayloadSchema.safeParse(entry.payload);
      if (!parsed.success) {
        items.push(unreadable(entry));
        continue;
      }
      const { target, tenderedSatang, label, totalSatang, changed } = parsed.data;
      const base = toBase(entry, tries, label);
      let state: QueueState = entry.state === 'attention' ? 'attention' : 'queued';
      let error = base.error;
      let dependsOn: string | null = null;
      let orderId: string | null = null;
      if ('entryId' in target) {
        dependsOn = target.entryId;
        const parent = parsedOrders.get(target.entryId);
        if (!parent) {
          state = 'attention';
          error = ERROR_PARENT_MISSING;
        } else if (parent.entry.state === 'attention' && state === 'queued') {
          state = 'blocked';
        }
      } else {
        orderId = target.orderId;
      }
      items.push({
        ...base,
        error,
        kind: 'payment',
        state,
        canRetry: state === 'attention' && error !== ERROR_PARENT_MISSING && error !== ERROR_REUSED,
        orderId,
        dependsOn,
        tenderedSatang,
        totalSatang,
        tenderChanged: changed === true,
        canChangeTender: state === 'queued' && entry.sentAt === undefined && totalSatang !== null,
      });
    } else {
      items.push(unreadable(entry));
    }
  }
  return items;
}

export const orderPayloadOf = (entry: OutboxEntry): OrderPayload | null => {
  const parsed = orderPayloadSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : null;
};

export const paymentPayloadOf = (entry: OutboxEntry): PaymentPayload | null => {
  const parsed = paymentPayloadSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : null;
};

export function orderEntry(
  clientRequestId: string,
  payload: OrderPayload,
  owner: { staffId: string; deviceId: string },
  now: number,
): OutboxEntry {
  return {
    id: clientRequestId,
    kind: KIND_ORDER,
    payload,
    createdAt: now,
    attempts: 0,
    state: 'queued',
    ...owner,
  };
}

export function cashEntry(
  clientRequestId: string,
  payload: PaymentPayload,
  owner: { staffId: string; deviceId: string },
  now: number,
): OutboxEntry {
  return {
    id: clientRequestId,
    kind: KIND_CASH,
    payload,
    createdAt: now,
    attempts: 0,
    state: 'queued',
    ...owner,
  };
}

// ---------- Who may see and replay an entry ----------

/**
 * An entry belongs to the person who made it, on the device it was made on. Only that person's
 * session replays it or sees what is in it: the server records who created an order and who
 * confirmed the cash, so another person's session must never send it. Anyone else on the device
 * is only told that there are entries (a count), never what they are.
 */
export function ownsEntry(
  entry: Pick<OutboxEntry, 'staffId' | 'deviceId'>,
  who: { staffId: string; deviceId: string },
): boolean {
  return entry.staffId === who.staffId && entry.deviceId === who.deviceId;
}

// ---------- Entries that never sync ----------

const DAY_MS = 86_400_000;
/**
 * Entries of OTHER people (or of this person on a device id that no longer exists) that are older
 * than this have never synced and nobody is coming for them: they are purged at sign-in.
 */
export const PURGE_AFTER_MS = 14 * DAY_MS;
/** The signed-in person's own entries are real orders and are never purged; after this they are flagged. */
export const OLD_AFTER_MS = 3 * DAY_MS;

export const isOldEntry = (createdAt: number, now: number): boolean =>
  now - createdAt > OLD_AFTER_MS;

/**
 * The rows to purge for the person who just signed in: not theirs, never synced (every row is
 * unsynced: a synced one is removed) and older than `PURGE_AFTER_MS`, plus the cash that waits for
 * a purged order (it could never be sent). Their own rows are never in the list.
 */
export function purgeableIds(
  rows: readonly OutboxEntry[],
  who: { staffId: string; deviceId: string },
  now: number,
): string[] {
  const doomed = new Set(
    rows.filter((r) => !ownsEntry(r, who) && now - r.createdAt > PURGE_AFTER_MS).map((r) => r.id),
  );
  for (const row of rows) {
    if (row.kind !== KIND_CASH || ownsEntry(row, who)) continue;
    const payload = paymentPayloadOf(row);
    if (payload && 'entryId' in payload.target && doomed.has(payload.target.entryId)) {
      doomed.add(row.id);
    }
  }
  return [...doomed];
}

// ---------- The provisional label ----------

const CODE_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** "XK": a short code for this device, from its id. Cosmetic: the server gives the real number. */
export function deviceCode(deviceId: string): string {
  const byte = Number.parseInt(deviceId.replace(/[^0-9a-f]/gi, '').slice(0, 2) || '0', 16);
  return `X${CODE_CHARS[byte % CODE_CHARS.length]}`;
}

/** "XK-07": the device code and the local counter, two digits at least. */
export function provisionalLabel(deviceId: string, seq: number): string {
  return `${deviceCode(deviceId)}-${String(seq).padStart(2, '0')}`;
}

// ---------- A failed replay ----------

export type ReplayVerdict =
  /** No answer from the server: try again later, and stop trying the others for now. */
  | 'unreachable'
  /** The server answered with a fault of its own (5xx, a garbled body): try again later. */
  | 'transient'
  /** The session or the device is gone: the queue pauses until the person signs in again. */
  | 'pause'
  /** The server refused this entry: it needs a person. */
  | 'refused';

export function classifyReplayError(error: unknown): ReplayVerdict {
  if (!isApiClientError(error)) return 'transient';
  switch (error.code) {
    case 'NETWORK':
    case 'TIMEOUT':
      return 'unreachable';
    case 'UNAUTHENTICATED':
    case 'DEVICE_UNREGISTERED':
    case 'DEVICE_MISMATCH':
      return 'pause';
    case 'RESPONSE_INVALID':
    case 'RATE_LIMITED':
      return 'transient';
    default:
      return error.status !== null && error.status >= 500 ? 'transient' : 'refused';
  }
}

/** The code to keep on an entry; nothing but the code is ever stored. */
export const errorCodeOf = (error: unknown): string =>
  isApiClientError(error) ? error.code : 'UNKNOWN';

/** The wait before the next try after `attempts` failures: doubling, capped, jittered 0.5 to 1.5. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.5 + random()));
}

// ---------- The snapshot taken when an order is saved ----------

const nameOf = (nameTh: string, nameEn: string | null) => ({ th: nameTh, en: nameEn });

/** The lines and the estimate to keep next to the body, so the order can be shown without the menu. */
export function snapshotOrder(
  entities: EntityState,
  lines: readonly CartLine[],
  channel: OrderChannel,
): Pick<OrderPayload, 'lines' | 'estimateSatang'> {
  const pricing = priceCart(entities, lines, channel);
  const priced = new Map(pricing.lines.map((l) => [l.key, l]));
  return {
    lines: lines.map((line) => {
      const item = entities.items.get(line.itemId);
      return {
        name: nameOf(item?.nameTh ?? '', item?.nameEn ?? null),
        options: line.optionIds.flatMap((id) => {
          const option = entities.options.get(id);
          return option ? [nameOf(option.nameTh, option.nameEn)] : [];
        }),
        qty: line.qty,
        note: line.note.trim(),
        lineTotalSatang: priced.get(line.key)?.lineTotalSatang ?? null,
      };
    }),
    estimateSatang: pricing.valid ? pricing.totalSatang : null,
  };
}
