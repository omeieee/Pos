/**
 * Feeds the print queue from the event bus. When an order reaches `preparing` (event
 * `order.sent_to_kitchen`, published after the order's transaction committed) and the owner's
 * printing switch is on, one kitchen job is added. Never in the order's own transaction, so a
 * failure here cannot undo or slow an order: the bus logs a failed subscriber and moves on.
 *
 * LINE and platform orders are printed when staff accept them, not when they arrive.
 */
import type { EventBus } from '../events.ts';
import type { CoreContext } from '../tx.ts';
import { enqueueKitchenJob } from './service.ts';

export interface KitchenQueue {
  /** Resolves when every enqueue started so far has finished (tests wait on it). */
  idle(): Promise<void>;
  stop(): void;
}

export function registerKitchenQueue(
  ctx: Pick<CoreContext, 'db' | 'now' | 'events'>,
): KitchenQueue {
  const pending = new Set<Promise<unknown>>();
  const events: EventBus = ctx.events;
  const stop = events.subscribe((event) => {
    if (event.type !== 'order.sent_to_kitchen') return;
    const work = enqueueKitchenJob(ctx, event.orderId);
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    pending.add(tracked);
    void tracked.then(() => pending.delete(tracked));
    // The bus catches and logs a rejection.
    return work.then(() => undefined);
  });
  return {
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    stop,
  };
}
