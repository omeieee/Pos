/**
 * Phone alerts (P8, D-37): when an order is created (`alert.new_order`, published after the order's
 * transaction committed) one Web Push goes to every subscribed device that is not revoked, except
 * the device the order was typed on. Background work only: a failure is logged by id and status and
 * never reaches the order write.
 *
 * What a push may say is fixed in `payload.ts`: an order number, the channel, an item count and a
 * link. Never a name, phone, room, address or note.
 *
 * Failure policy per subscription:
 * - 2xx: success, the failure count resets.
 * - 404 or 410: the browser unsubscribed; the row is deleted.
 * - 400, 401, 403, 413: OUR request was refused (a wrong key, subject or size). Counting these
 *   would wipe every device after a few orders because of one bad setting, so they are only logged.
 * - 429, 5xx, a timeout or a network error: counted; the row is deleted at `maxFailures`.
 */
import { type Db, ordersRepo, pushRepo } from '@sds/db';
import type { OrderChannel } from '@sds/shared';
import type { EventBus } from '../events.ts';
import { newOrderPayload } from './payload.ts';
import {
  buildPushRequest,
  createFetchTransport,
  type PushTransport,
  type VapidConfig,
} from './webpush.ts';

/** What the server is told to run with: the identity and, in tests, a fake transport and short limits. */
export interface PushRuntime {
  vapid: VapidConfig;
  transport?: PushTransport;
  /** Per send. Default 10 s. */
  timeoutMs?: number;
  /** How long a push service may hold an alert for a sleeping phone. Default 120 s. */
  ttlSeconds?: number;
  /** Counted failures before a subscription is dropped. Default 5. */
  maxFailures?: number;
  /** Sends in flight at once. Default 5. */
  concurrency?: number;
}

export const PUSH_DEFAULTS = {
  timeoutMs: 10_000,
  ttlSeconds: 120,
  maxFailures: 5,
  concurrency: 5,
} as const;

/** The part of the logger used here. Only ids, statuses and error classes go in. */
export interface PushLog {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface PushNotifier {
  /** Resolves when every alert started so far has been sent (tests wait on it). */
  idle(): Promise<void>;
  stop(): void;
}

const NOT_COUNTED = new Set([400, 401, 403, 413]);
const GONE = new Set([404, 410]);

/** An error's class and code, never its message (a fetch error can name the endpoint). */
function describeError(error: unknown): Record<string, unknown> {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return {
    error: error instanceof Error ? error.name : 'unknown',
    ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
  };
}

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function registerPushNotifier(deps: {
  db: Db;
  events: EventBus;
  now: () => Date;
  log: PushLog;
  runtime: PushRuntime;
}): PushNotifier {
  const { db, events, now, log, runtime } = deps;
  const transport = runtime.transport ?? createFetchTransport();
  const timeoutMs = runtime.timeoutMs ?? PUSH_DEFAULTS.timeoutMs;
  const ttlSeconds = runtime.ttlSeconds ?? PUSH_DEFAULTS.ttlSeconds;
  const maxFailures = runtime.maxFailures ?? PUSH_DEFAULTS.maxFailures;
  const concurrency = runtime.concurrency ?? PUSH_DEFAULTS.concurrency;

  async function status(request: ReturnType<typeof buildPushRequest>): Promise<number> {
    const signal = AbortSignal.timeout(timeoutMs);
    // Also stops waiting for a transport that ignores the signal.
    const timedOut = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    return (await Promise.race([transport(request, signal), timedOut])).status;
  }

  async function sendOne(sub: pushRepo.PushSubscriptionRow, message: string) {
    try {
      let request: ReturnType<typeof buildPushRequest>;
      try {
        request = buildPushRequest(sub, message, runtime.vapid, { now: now(), ttlSeconds });
      } catch {
        // A stored endpoint that is no longer allowed, or keys that cannot encrypt: never usable.
        await pushRepo.deleteById(db, sub.id);
        log.warn({ subscriptionId: sub.id }, 'push subscription unusable, removed');
        return;
      }
      let code: number | null = null;
      let failure: Record<string, unknown> = {};
      try {
        code = await status(request);
      } catch (error) {
        failure = describeError(error);
      }
      if (code !== null && code >= 200 && code < 300) {
        await pushRepo.markSuccess(db, sub.id, now());
      } else if (code !== null && GONE.has(code)) {
        await pushRepo.deleteById(db, sub.id);
      } else if (code !== null && NOT_COUNTED.has(code)) {
        log.warn({ subscriptionId: sub.id, status: code }, 'push refused by the push service');
      } else {
        const outcome = await pushRepo.recordFailure(db, sub.id, maxFailures);
        log.warn(
          { subscriptionId: sub.id, status: code, ...failure, outcome },
          'push not delivered',
        );
      }
    } catch (error) {
      log.error({ subscriptionId: sub.id, ...describeError(error) }, 'push send failed');
    }
  }

  async function alertNewOrder(orderId: string, createdOnDeviceId: string | null) {
    const order = await ordersRepo.findOrderById(db, orderId);
    if (!order) return;
    const items = (await ordersRepo.loadOrderItems(db, [orderId])).get(orderId) ?? [];
    const message = JSON.stringify(
      newOrderPayload(
        { id: order.id, orderNo: order.orderNo, channel: order.channel as OrderChannel },
        items.reduce((sum, item) => sum + item.qty, 0),
      ),
    );
    const subscriptions = (await pushRepo.listDeliverable(db)).filter(
      (sub) => sub.deviceId !== createdOnDeviceId,
    );
    await mapLimit(subscriptions, concurrency, (sub) => sendOne(sub, message));
  }

  const pending = new Set<Promise<unknown>>();
  const stop = events.subscribe((event) => {
    if (event.type !== 'alert.new_order') return;
    const work = alertNewOrder(event.orderId, event.createdOnDeviceId).catch((error) =>
      log.error(describeError(error), 'push alert failed'),
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
