/**
 * Telegram payment alerts (D-42): when an order becomes paid, or a slip needs staff review
 * (`alert.payment`, published after the transaction committed), one message goes to the owner's
 * private staff group through a bot. Background work only: a failure is logged by order id and
 * error class and never reaches the payment write.
 *
 * What may be said is fixed in `message.ts` (the LINE name, the name given in the order, the
 * building, the dishes, the total). Never a phone number, room, note or slip image.
 *
 * Delivery: the LINE picture and up to 9 dish photos go as one album (`sendMediaGroup`, or
 * `sendPhoto` for a single picture) with the text as the first caption. If Telegram refuses the
 * photos (a bad URL, a timeout) the text goes alone, so a photo problem never loses the alert.
 * A 429 waits `retry_after` (at most 5 s) and a 5xx waits a moment; each is tried once more.
 */
import { customersRepo, type Db, menuRepo, ordersRepo } from '@sds/db';
import { itemPhotoPath } from '@sds/shared';
import type { EventBus } from '../events.ts';
import {
  absolutePhotoUrl,
  alertHeader,
  alertText,
  CAPTION_LIMIT,
  isLinePictureUrl,
  noticeCoversTelegram,
  type TelegramAlert,
} from './message.ts';

export interface TelegramReply {
  status: number;
  /** The parsed JSON answer, or null when it was not JSON. */
  body: unknown;
}

/** One POST of a JSON body to `url` (which contains the bot token: never log it). */
export type TelegramTransport = (
  url: string,
  body: object,
  signal: AbortSignal,
) => Promise<TelegramReply>;

export interface TelegramRuntime {
  /** A secret: only ever put in the request URL. */
  token: string;
  chatId: string;
  /** https base that makes menu photo paths absolute (`PUBLIC_API_BASE_URL`). */
  publicBaseUrl: string;
  transport?: TelegramTransport;
  /** Per call. Default 10 s. */
  timeoutMs?: number;
  /** Alerts being sent at once. Default 2. */
  concurrency?: number;
  /** The same order and kind inside this window is sent once. Default 2 minutes. */
  dedupeMs?: number;
  /** Waits before a retry; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

export const TELEGRAM_DEFAULTS = {
  timeoutMs: 10_000,
  concurrency: 2,
  dedupeMs: 120_000,
  maxRetryAfterMs: 5_000,
  serverErrorWaitMs: 500,
} as const;

const MAX_PHOTOS = 10;
const MAX_REMEMBERED = 500;

/** The part of the logger used here. Only ids, statuses and error classes go in. */
export interface TelegramLog {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface TelegramNotifier {
  /** Resolves when every alert started so far has been sent (tests wait on it). */
  idle(): Promise<void>;
  stop(): void;
}

/** An error's class and code, never its message (a fetch error can name the URL, which holds the token). */
function describeError(error: unknown): Record<string, unknown> {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return {
    error: error instanceof Error ? error.name : 'unknown',
    ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
  };
}

export function createFetchTransport(): TelegramTransport {
  return async (url, body, signal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const parsed: unknown = await response.json().catch(() => null);
    return { status: response.status, body: parsed };
  };
}

function retryAfterMs(body: unknown): number {
  const seconds = (body as { parameters?: { retry_after?: unknown } } | null)?.parameters
    ?.retry_after;
  const wait = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : 1000;
  return Math.min(Math.max(wait, 0), TELEGRAM_DEFAULTS.maxRetryAfterMs);
}

/** What a call came to: delivered, or why not (a status, or the class of the error). */
type Outcome =
  | { ok: true }
  | { ok: false; status: number | null; failure: Record<string, unknown> };

export function registerTelegramNotifier(deps: {
  db: Db;
  events: EventBus;
  now: () => Date;
  log: TelegramLog;
  runtime: TelegramRuntime;
}): TelegramNotifier {
  const { db, events, now, log, runtime } = deps;
  const transport = runtime.transport ?? createFetchTransport();
  const timeoutMs = runtime.timeoutMs ?? TELEGRAM_DEFAULTS.timeoutMs;
  const concurrency = runtime.concurrency ?? TELEGRAM_DEFAULTS.concurrency;
  const dedupeMs = runtime.dedupeMs ?? TELEGRAM_DEFAULTS.dedupeMs;
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function attempt(method: string, payload: object): Promise<TelegramReply> {
    const signal = AbortSignal.timeout(timeoutMs);
    // Also stops waiting for a transport that ignores the signal.
    const timedOut = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    const url = `https://api.telegram.org/bot${runtime.token}/${method}`;
    return await Promise.race([transport(url, payload, signal), timedOut]);
  }

  async function call(method: string, fields: Record<string, unknown>): Promise<Outcome> {
    const payload = { chat_id: runtime.chatId, ...fields };
    let status: number | null = null;
    let failure: Record<string, unknown> = {};
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const reply = await attempt(method, payload);
        if (reply.status >= 200 && reply.status < 300) return { ok: true };
        status = reply.status;
        failure = {};
        const retryable = reply.status === 429 || reply.status >= 500;
        if (!retryable || tries === 1) break;
        await sleep(
          reply.status === 429 ? retryAfterMs(reply.body) : TELEGRAM_DEFAULTS.serverErrorWaitMs,
        );
      } catch (error) {
        // A timeout or network error is not retried: the wait would double the delay.
        status = null;
        failure = describeError(error);
        break;
      }
    }
    return { ok: false, status, failure };
  }

  async function loadAlert(orderId: string, kind: TelegramAlert['kind']) {
    const order = await ordersRepo.findOrderById(db, orderId);
    if (!order) return null;
    const items = (await ordersRepo.loadOrderItems(db, [orderId])).get(orderId) ?? [];
    const full = noticeCoversTelegram(
      order.customerId ? await customersRepo.getPrivacyAckVersion(db, order.customerId) : null,
    );
    const alert: TelegramAlert = {
      full,
      kind,
      orderNo: order.orderNo,
      totalSatang: order.totalSatang,
      lineName: order.lineDisplayName,
      recipientName: order.recipientName,
      building: order.deliveryBuilding,
      lines: items.map((item) => ({ name: item.nameThSnapshot, qty: item.qty })),
    };
    const photos: string[] = [];
    if (!full) return { alert, photos };
    if (isLinePictureUrl(order.linePictureUrl) && order.linePictureUrl) {
      photos.push(order.linePictureUrl);
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (photos.length >= MAX_PHOTOS) break;
      if (seen.has(item.menuItemId)) continue;
      seen.add(item.menuItemId);
      const menuItem = await menuRepo.findItem(db, item.menuItemId);
      const path = menuItem ? itemPhotoPath(menuItem) : null;
      const url = path ? absolutePhotoUrl(runtime.publicBaseUrl, path) : null;
      if (url) photos.push(url);
    }
    return { alert, photos };
  }

  async function deliver(orderId: string, kind: TelegramAlert['kind']) {
    const loaded = await loadAlert(orderId, kind);
    if (!loaded) return;
    const { alert, photos } = loaded;
    const text = alertText(alert);

    async function sendText() {
      const result = await call('sendMessage', { text });
      if (!result.ok) {
        log.warn({ orderId, status: result.status, ...result.failure }, 'telegram alert not sent');
      }
    }

    if (photos.length === 0) return await sendText();
    const caption = text.length <= CAPTION_LIMIT ? text : alertHeader(alert);
    const result =
      photos.length === 1
        ? await call('sendPhoto', { photo: photos[0], caption })
        : await call('sendMediaGroup', {
            media: photos.map((media, index) => ({
              type: 'photo',
              media,
              ...(index === 0 ? { caption } : {}),
            })),
          });
    if (!result.ok) {
      log.warn(
        { orderId, status: result.status, ...result.failure },
        'telegram photos refused, sending the text alone',
      );
      return await sendText();
    }
    if (caption !== text) await sendText();
  }

  const recent = new Map<string, number>();
  function isDuplicate(orderId: string, kind: string): boolean {
    const at = now().getTime();
    const key = `${orderId}:${kind}`;
    const last = recent.get(key);
    if (last !== undefined && at - last < dedupeMs) return true;
    recent.set(key, at);
    if (recent.size > MAX_REMEMBERED) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
    return false;
  }

  // At most `concurrency` alerts at once; the rest wait their turn.
  let running = 0;
  const waiting: (() => void)[] = [];
  async function limited(work: () => Promise<void>) {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  const pending = new Set<Promise<unknown>>();
  const stop = events.subscribe((event) => {
    if (event.type !== 'alert.payment') return;
    if (isDuplicate(event.orderId, event.kind)) return;
    const { orderId, kind } = event;
    const work = limited(() => deliver(orderId, kind)).catch((error) =>
      log.error({ orderId, ...describeError(error) }, 'telegram alert failed'),
    );
    pending.add(work);
    void work.then(() => pending.delete(work));
  });
  return {
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    stop,
  };
}
