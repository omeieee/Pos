/**
 * The sound for orders that wait for someone: a chime when a new order arrives (`alert.new_order`)
 * and a different, repeated sound while an order stays `new` (nobody has started it).
 *
 * Simple on purpose, and no setting: a reminder every two minutes, five at most, and only while
 * the order is `new`. The reminders come from the orders in the store, not from the alert ids, so
 * an order that arrived while the device was offline (`/v1/sync` does not replay alerts) is still
 * reminded about. Nothing is made while the sound is off or blocked, and a reminder not played is
 * not used up: turning the sound on rings for the order that is waiting.
 *
 * It runs on the clock (`Date.now`) and one interval, so a test with fake timers drives it.
 */
import type { OrderDto } from '@sds/shared';
import { subscribeTicks } from '../lib/clock.ts';
import type { SoundKind } from '../platform/sound.ts';
import type { EntityStore } from '../realtime/entity-store.ts';

export const REMINDER_EVERY_MS = 2 * 60_000;
export const MAX_REMINDERS = 5;
/** How often the store is looked at for orders that are due a reminder. */
const TICK_MS = 10_000;
/** No two sounds closer than this: a burst of orders is one chime. */
const MIN_GAP_MS = 1_500;

/**
 * How many reminders an order is due by now: one per two minutes since it was placed, at most
 * `MAX_REMINDERS`, none once it is older than the window (a stale order left over from yesterday
 * must not ring at every start) and none unless it is still `new`.
 */
export function remindersDue(order: Pick<OrderDto, 'status' | 'placedAt'>, nowMs: number): number {
  if (order.status !== 'new') return 0;
  const age = nowMs - Date.parse(order.placedAt);
  if (!(age >= 0) || age >= (MAX_REMINDERS + 1) * REMINDER_EVERY_MS) return 0;
  return Math.min(MAX_REMINDERS, Math.floor(age / REMINDER_EVERY_MS));
}

export interface NewOrderAlarm {
  /** Starts listening. Returns the function that stops it. */
  start(): () => void;
}

export function createNewOrderAlarm(deps: {
  entities: Pick<EntityStore, 'getState' | 'onAlert'>;
  sound: { play(kind: SoundKind): boolean };
  /** This device's id: an order it rang up itself does not chime here. */
  deviceId: () => string | null;
}): NewOrderAlarm {
  return {
    start() {
      /** order id -> reminders already given. */
      const given = new Map<string, number>();
      let lastAt = Number.NEGATIVE_INFINITY;

      function ring(kind: SoundKind): boolean {
        const now = Date.now();
        if (now - lastAt < MIN_GAP_MS) return false;
        const played = deps.sound.play(kind);
        if (played) lastAt = now;
        return played;
      }

      const stopAlerts = deps.entities.onAlert((frame) => {
        const own = frame.data.createdOnDeviceId;
        if (own !== null && own === deps.deviceId()) return;
        ring('newOrder');
      });

      const stopTicks = subscribeTicks(TICK_MS, () => {
        const now = Date.now();
        const due: [string, number][] = [];
        const waiting = new Set<string>();
        for (const order of deps.entities.getState().orders.values()) {
          if (order.status !== 'new') continue;
          waiting.add(order.id);
          const target = remindersDue(order, now);
          if (target > (given.get(order.id) ?? 0)) due.push([order.id, target]);
        }
        // An order that is no longer new leaves the book.
        for (const id of [...given.keys()]) if (!waiting.has(id)) given.delete(id);
        // One sound however many orders are waiting; they all count as reminded once it played.
        if (due.length > 0 && ring('reminder')) {
          for (const [id, target] of due) given.set(id, target);
        }
      });

      return () => {
        stopAlerts();
        stopTicks();
      };
    },
  };
}
