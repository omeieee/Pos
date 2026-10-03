/**
 * The offline outbox as pure functions (no React, no I/O): the shape of a queued entry, the
 * provisional label, how a failed replay is classified, the backoff, and what a person may see.
 *
 * What an entry holds is only what the order needs: item ids, quantities, chosen options, notes
 * and (for a delivery) the building and the recipient name as the order carries them. The recipient
 * name is personal data (PDPA): it lives only inside the entry, is never logged and never put in a
 * URL, and the entry is removed once the server has the order. No token, no QR link, no QR payload
 * and no PromptPay ID is ever stored here (a PromptPay entry keeps the amount the QR showed and the
 * MASKED account, to notice a changed account or amount at replay).
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
/**
 * An offline PromptPay payment is two entries (D-20): `create` makes the pending payment once the
 * order is on the server, `confirm` is the staff member's "I checked the bank app" (rule 2) and
 * goes only after the create has answered.
 */
export const KIND_PROMPTPAY = 'payment.promptpay.create';
export const KIND_PROMPTPAY_CONFIRM = 'payment.promptpay.confirm';

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

const orderTargetSchema = z.union([
  z.object({ entryId: z.string() }),
  z.object({ orderId: z.uuid() }),
]);
const amountKindSchema = z.enum(['estimate', 'server']);

const promptpayCreatePayloadSchema = z.object({
  /** The order entry this payment waits for, or the server order once it is known. */
  target: orderTargetSchema,
  /** The amount the QR showed (satang): an estimate for an order not synced yet, else the server's total. */
  qrAmountSatang: z.number().int().positive(),
  amountKind: amountKindSchema,
  /** The account the QR paid, MASKED (the last characters only), to notice a changed account at replay. */
  qrTargetMasked: z.string().min(1),
  label: z.string().min(1),
});
export type PromptpayCreatePayload = z.infer<typeof promptpayCreatePayloadSchema>;

const promptpayConfirmPayloadSchema = z.object({
  /** The create entry it waits for, or the payment the server made once that has answered. */
  target: z.union([
    z.object({ createEntryId: z.string() }),
    z.object({ paymentId: z.uuid(), orderId: z.uuid() }),
  ]),
  qrAmountSatang: z.number().int().positive(),
  amountKind: amountKindSchema,
  label: z.string().min(1),
  /** Set when the server's amount was not the one on the QR: the confirm then waits for a person. */
  serverAmountSatang: z.number().int().nonnegative().optional(),
});
export type PromptpayConfirmPayload = z.infer<typeof promptpayConfirmPayloadSchema>;

/** The error codes kept on an entry: only a code, never a message. */
export const ERROR_NOT_UNDERSTOOD = 'ENTRY_UNREADABLE';
export const ERROR_PARENT_MISSING = 'ORDER_ENTRY_MISSING';
const ERROR_REUSED = 'IDEMPOTENCY_KEY_REUSED';
/** The person an owner named when taking an entry over is not in the system: a person decides. */
export const ERROR_UNKNOWN_STAFF = 'UNKNOWN_STAFF';
/** The payment the server made is for another amount than the QR showed: money was taken, reconcile. */
export const ERROR_QR_AMOUNT = 'QR_AMOUNT_DIFFERS';
/** The server's PromptPay account is not the one the QR paid: money may have gone to the old account. */
export const ERROR_QR_TARGET = 'QR_ID_CHANGED';
/** Answers that mean money may have been taken twice: a person decides, never a retry. */
const NO_RETRY_CODES: readonly string[] = [
  ERROR_QR_AMOUNT,
  ERROR_QR_TARGET,
  ERROR_UNKNOWN_STAFF,
  'ORDER_ALREADY_PAID',
  'PAYMENT_ALREADY_OPEN',
];
/** The server's total is above the tender: sending the same tender again is refused again. */
export const ERROR_TENDER_BELOW = 'TENDERED_BELOW_TOTAL';

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

interface QueuedPaymentBase extends QueueBase {
  kind: 'payment';
  /** The server order, once known. */
  orderId: string | null;
  /** The order entry it waits for, until that one has synced. */
  dependsOn: string | null;
  /** What the screen was showing as the total: an estimate for an order not synced yet. */
  totalSatang: number | null;
}

export interface QueuedCashPayment extends QueuedPaymentBase {
  method: 'cash';
  tenderedSatang: number;
  /** The tender was changed after it was first saved. */
  tenderChanged: boolean;
  /** Not sent yet and not refused: the amount can still be corrected. */
  canChangeTender: boolean;
}

/** An offline PromptPay payment: the create and the staff's confirm, shown as one. */
export interface QueuedPromptpayPayment extends QueuedPaymentBase {
  method: 'promptpay';
  /** The amount the QR showed. */
  qrAmountSatang: number;
  amountKind: 'estimate' | 'server';
  /** What the server charged, when it was not the amount on the QR. */
  serverAmountSatang: number | null;
  /** The payment exists on the server already; only the confirm is left. */
  confirmOnly: boolean;
}

export type QueuedPayment = QueuedCashPayment | QueuedPromptpayPayment;

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
        canRetry: attention && base.error !== ERROR_REUSED && base.error !== ERROR_UNKNOWN_STAFF,
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
        method: 'cash',
        state,
        canRetry:
          state === 'attention' &&
          error !== ERROR_PARENT_MISSING &&
          error !== ERROR_REUSED &&
          error !== ERROR_UNKNOWN_STAFF &&
          error !== ERROR_TENDER_BELOW,
        orderId,
        dependsOn,
        tenderedSatang,
        totalSatang,
        tenderChanged: changed === true,
        canChangeTender: state === 'queued' && entry.sentAt === undefined && totalSatang !== null,
      });
    } else if (entry.kind === KIND_PROMPTPAY) {
      const parsed = promptpayCreatePayloadSchema.safeParse(entry.payload);
      if (!parsed.success) {
        items.push(unreadable(entry));
        continue;
      }
      const { target, qrAmountSatang, amountKind, label } = parsed.data;
      const base = toBase(entry, tries, label);
      const gate = gateOf(entry, base.error, target, parsedOrders);
      items.push({
        ...base,
        error: gate.error,
        kind: 'payment',
        method: 'promptpay',
        state: gate.state,
        canRetry: canRetryEntry(gate.state, gate.error),
        orderId: 'orderId' in target ? target.orderId : null,
        dependsOn: 'entryId' in target ? target.entryId : null,
        totalSatang: qrAmountSatang,
        qrAmountSatang,
        amountKind,
        serverAmountSatang: null,
        confirmOnly: false,
      });
    } else if (entry.kind === KIND_PROMPTPAY_CONFIRM) {
      const parsed = promptpayConfirmPayloadSchema.safeParse(entry.payload);
      if (!parsed.success) {
        items.push(unreadable(entry));
        continue;
      }
      const { target, label, qrAmountSatang, amountKind } = parsed.data;
      const base = toBase(entry, tries, label);
      if ('createEntryId' in target) {
        // Waiting behind its create entry: that one is the item, this one is part of it.
        if (entries.some((e) => e.id === target.createEntryId)) continue;
        // The create entry is gone without having answered: there is nothing to confirm.
        items.push({
          ...base,
          kind: 'payment',
          method: 'promptpay',
          state: 'attention',
          error: ERROR_PARENT_MISSING,
          canRetry: false,
          orderId: null,
          dependsOn: null,
          totalSatang: qrAmountSatang,
          qrAmountSatang,
          amountKind,
          serverAmountSatang: null,
          confirmOnly: false,
        });
        continue;
      }
      const state: QueueState = entry.state === 'attention' ? 'attention' : 'queued';
      items.push({
        ...base,
        kind: 'payment',
        method: 'promptpay',
        state,
        canRetry: canRetryEntry(state, base.error),
        orderId: target.orderId,
        dependsOn: null,
        totalSatang: qrAmountSatang,
        qrAmountSatang,
        amountKind,
        serverAmountSatang: parsed.data.serverAmountSatang ?? null,
        confirmOnly: true,
      });
    } else {
      items.push(unreadable(entry));
    }
  }
  return items;
}

type ParsedOrders = Map<string, { entry: OutboxEntry; payload: OrderPayload }>;

/** The state of a payment entry that waits for an order: blocked while its order needs attention. */
function gateOf(
  entry: OutboxEntry,
  error: string | null,
  target: { entryId: string } | { orderId: string },
  orders: ParsedOrders,
): { state: QueueState; error: string | null } {
  let state: QueueState = entry.state === 'attention' ? 'attention' : 'queued';
  let out = error;
  if ('entryId' in target) {
    const parent = orders.get(target.entryId);
    if (!parent) {
      state = 'attention';
      out = ERROR_PARENT_MISSING;
    } else if (parent.entry.state === 'attention' && state === 'queued') {
      state = 'blocked';
    }
  }
  return { state, error: out };
}

/** A retry is allowed unless the refusal is about money that may have been taken twice or a reused id. */
const canRetryEntry = (state: QueueState, error: string | null): boolean =>
  state === 'attention' &&
  error !== ERROR_PARENT_MISSING &&
  error !== ERROR_REUSED &&
  error !== ERROR_TENDER_BELOW &&
  !(error !== null && NO_RETRY_CODES.includes(error));

export const orderPayloadOf = (entry: OutboxEntry): OrderPayload | null => {
  const parsed = orderPayloadSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : null;
};

export const paymentPayloadOf = (entry: OutboxEntry): PaymentPayload | null => {
  const parsed = paymentPayloadSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : null;
};

export const promptpayCreatePayloadOf = (entry: OutboxEntry): PromptpayCreatePayload | null => {
  const parsed = promptpayCreatePayloadSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : null;
};

export const promptpayConfirmPayloadOf = (entry: OutboxEntry): PromptpayConfirmPayload | null => {
  const parsed = promptpayConfirmPayloadSchema.safeParse(entry.payload);
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

export function promptpayCreateEntry(
  clientRequestId: string,
  payload: PromptpayCreatePayload,
  owner: { staffId: string; deviceId: string },
  now: number,
): OutboxEntry {
  return {
    id: clientRequestId,
    kind: KIND_PROMPTPAY,
    payload,
    createdAt: now,
    attempts: 0,
    state: 'queued',
    ...owner,
  };
}

export function promptpayConfirmEntry(
  id: string,
  payload: PromptpayConfirmPayload,
  owner: { staffId: string; deviceId: string },
  now: number,
): OutboxEntry {
  return {
    id,
    kind: KIND_PROMPTPAY_CONFIRM,
    payload,
    createdAt: now,
    attempts: 0,
    state: 'queued',
    ...owner,
  };
}

/** The entry this one waits for, if it waits for an entry at all. */
function parentIdOf(row: OutboxEntry): string | null {
  if (row.kind === KIND_CASH) {
    const payload = paymentPayloadOf(row);
    return payload && 'entryId' in payload.target ? payload.target.entryId : null;
  }
  if (row.kind === KIND_PROMPTPAY) {
    const payload = promptpayCreatePayloadOf(row);
    return payload && 'entryId' in payload.target ? payload.target.entryId : null;
  }
  if (row.kind === KIND_PROMPTPAY_CONFIRM) {
    const payload = promptpayConfirmPayloadOf(row);
    return payload && 'createEntryId' in payload.target ? payload.target.createEntryId : null;
  }
  return null;
}

/**
 * The ids of the entries that cannot be sent without `id`, and the ones behind those: the payments
 * of an order entry, and the confirm behind a PromptPay create. `id` itself is not in the list.
 */
export function dependentIds(rows: readonly OutboxEntry[], id: string): string[] {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const row of rows) {
      if (row.id === id || found.has(row.id)) continue;
      if (parentIdOf(row) === current) {
        found.add(row.id);
        queue.push(row.id);
      }
    }
  }
  return [...found];
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

// ---------- What the server is told about a take-over or a clear ----------

/**
 * The counts the owner reports to the server before touching other people's rows: how many orders
 * and how many payments. A PromptPay create and its confirm are one payment; a row nobody can read
 * counts as a payment so the total is never empty while there is something to recover.
 */
export function recoveryCountsOf(rows: readonly OutboxEntry[]): {
  orders: number;
  payments: number;
} {
  const orders = rows.filter((row) => row.kind === KIND_ORDER).length;
  const joined = rows.filter(
    (row) => row.kind === KIND_PROMPTPAY_CONFIRM && rows.some((r) => r.id === parentIdOf(row)),
  ).length;
  return { orders, payments: rows.length - orders - joined };
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
  // What waits for a purged entry (cash, a PromptPay create and its confirm) could never be sent.
  for (const id of [...doomed]) {
    for (const dependent of dependentIds(rows, id)) {
      const row = rows.find((r) => r.id === dependent);
      if (row && !ownsEntry(row, who)) doomed.add(dependent);
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
  /** 429: the whole queue waits for the time the server named. */
  | 'rateLimited'
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
      return 'transient';
    case 'RATE_LIMITED':
      return 'rateLimited';
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
