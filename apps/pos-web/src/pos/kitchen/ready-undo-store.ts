/**
 * The 5-second undo of the kitchen's "ทำเสร็จ" (review finding UX-02). Marking an order ready makes
 * the server push "food ready" to a LINE customer at once (one of the 300 pushes a month), and the
 * order machine has no way back from `ready`. So the tap only starts a countdown on that ticket
 * ("เลิกทำ · 5"); the move is sent when the countdown ends, through the order moves store, and an
 * undo before then sends nothing at all. Client-side only: no server or order-machine change.
 *
 * - Each ticket counts on its own; several can wait at once.
 * - An undo in the first `READY_UNDO_GUARD_MS` is ignored: it is the second tap of a double tap on
 *   "ทำเสร็จ", whose place the undo button has just taken.
 * - The time left is read from the clock (`Date.now()`), not counted tick by tick, so a page whose
 *   timers were held back (iOS in the background) sends as soon as it runs again, and never twice.
 *   A page that wakes more than `READY_UNDO_LATE_MS` after the countdown ended sends nothing (owner,
 *   2026-10-26): "food ready" would reach the customer long after the cook tapped. The order stays
 *   cooking and the card shows it, so the cook taps again.
 * - The order changed underneath: while something waits, this store follows the entity store. When
 *   an order leaves the status it was tapped in (cancelled, or made ready by another device) its
 *   countdown ends and nothing is sent; the card already shows the real state. A change that keeps
 *   it cooking (a payment confirmed, which bumps the version) does not stop it: like the moves
 *   store, the guard is the status, not `expectedVersion` (see `order-moves-store.ts`). The server
 *   still checks the status under its row lock, and the moves store reconciles a refusal.
 * - The screen goes away (another page, the ticket scrolls off): the countdown lives here, not in
 *   the component, so it still sends when the time is up, as the cook meant when they tapped. Only
 *   an undo stops it.
 * - Sign-out (`reset`) drops every countdown and sends nothing: the session that tapped is gone,
 *   and the move must not go out under the next person's sign-in. The order stays cooking.
 *
 * Timers are plain `setTimeout`, as in the realtime connection; there is no platform seam for them.
 */
import type { OrderDto, OrderStatus } from '@sds/shared';
import { createStore, type ReadableStore } from '../../lib/store.ts';
import type { EntityStore } from '../../realtime/entity-store.ts';
import type { OrderMovesStore } from '../orders/order-moves-store.ts';

/** How long the cook has to take "done" back. */
export const READY_UNDO_SECONDS = 5;
/**
 * The undo button takes the place of "ทำเสร็จ" at once, so the second half of a fast double tap
 * would land on it: an undo this soon after the start is ignored.
 */
export const READY_UNDO_GUARD_MS = 500;
/** A countdown that ends this long before the page runs again is dropped, not sent. */
export const READY_UNDO_LATE_MS = 60_000;

export interface ReadyCountdown {
  /** The status the order was in at the tap; the move is dropped if it is not there any more. */
  from: OrderStatus;
  /** Whole seconds left, 5 down to 1, for the undo button. */
  secondsLeft: number;
}

export interface ReadyUndoState {
  waiting: Readonly<Record<string, ReadyCountdown>>;
}

export interface ReadyUndoDeps {
  moves: Pick<OrderMovesStore, 'transition' | 'getState'>;
  entities: Pick<EntityStore, 'getState' | 'subscribe'>;
}

export interface ReadyUndoStore extends ReadableStore<ReadyUndoState> {
  /**
   * Starts the countdown to "ready". The caller offers it only where the shared order machine
   * allows that move (`kitchenMoves`). False (and nothing starts) when it already counts, a move of
   * it is on its way, or the order is no longer in the status the card showed.
   */
  start(order: Pick<OrderDto, 'id' | 'status'>): boolean;
  /**
   * Takes "done" back: the countdown stops and nothing is sent. Ignored for `READY_UNDO_GUARD_MS`
   * after the start (a double tap), so the countdown goes on.
   */
  undo(orderId: string): void;
  /** Sign-out: drops every countdown, sends nothing. */
  reset(): void;
}

interface Entry {
  from: OrderStatus;
  startedAt: number;
  endsAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const secondsUntil = (endsAt: number, now: number) => Math.max(0, Math.ceil((endsAt - now) / 1000));

export function createReadyUndoStore(deps: ReadyUndoDeps): ReadyUndoStore {
  const store = createStore<ReadyUndoState>({ waiting: {} });
  const entries = new Map<string, Entry>();
  let unfollow: (() => void) | null = null;

  function publish() {
    const now = Date.now();
    const waiting: Record<string, ReadyCountdown> = {};
    for (const [id, entry] of entries) {
      waiting[id] = { from: entry.from, secondsLeft: secondsUntil(entry.endsAt, now) };
    }
    store.setState({ waiting });
  }

  function drop(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entries.delete(id);
    if (entries.size === 0 && unfollow) {
      unfollow();
      unfollow = null;
    }
  }

  /** Ends the countdowns whose order has moved on elsewhere. */
  function onEntities() {
    const orders = deps.entities.getState().orders;
    let changed = false;
    for (const [id, entry] of [...entries]) {
      const current = orders.get(id);
      if (current && current.status !== entry.from) {
        drop(id);
        changed = true;
      }
    }
    if (changed) publish();
  }

  function schedule(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    const remaining = entry.endsAt - Date.now();
    if (remaining < -READY_UNDO_LATE_MS) {
      drop(id);
      publish();
      return;
    }
    if (remaining <= 0) {
      send(id);
      return;
    }
    // Wake on the next whole-second boundary, so the label changes on time.
    entry.timer = setTimeout(
      () => {
        publish();
        schedule(id);
      },
      remaining % 1000 || 1000,
    );
  }

  function send(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    drop(id);
    publish();
    const current = deps.entities.getState().orders.get(id);
    // Moved on elsewhere between the last frame and now: a stale move is never sent.
    if (current && current.status !== entry.from) return;
    void deps.moves.transition({ id, status: entry.from }, 'ready');
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    start(order) {
      if (entries.has(order.id)) return false;
      if (deps.moves.getState().pending.includes(order.id)) return false;
      // The card was drawn from an older view of the order: it is not where the cook saw it.
      const current = deps.entities.getState().orders.get(order.id);
      if (current && current.status !== order.status) return false;
      const now = Date.now();
      entries.set(order.id, {
        from: order.status,
        startedAt: now,
        endsAt: now + READY_UNDO_SECONDS * 1000,
      });
      unfollow ??= deps.entities.subscribe(onEntities);
      schedule(order.id);
      publish();
      return true;
    },
    undo(orderId) {
      const entry = entries.get(orderId);
      if (!entry) return;
      if (Date.now() < entry.startedAt + READY_UNDO_GUARD_MS) return;
      drop(orderId);
      publish();
    },
    reset() {
      for (const id of [...entries.keys()]) drop(id);
      store.setState({ waiting: {} });
    },
  };
}
