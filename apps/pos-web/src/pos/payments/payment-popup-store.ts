/**
 * The payment pop-up of this device (D-42): the on/off choice (remembered per device, on by
 * default) and the queue of pop-ups waiting to be shown. Alerts come only from the live
 * `alert.payment` frame through the entity store's `onAlert`: a catch-up or a saved copy never
 * carries one, so opening the app never fires a pop-up for something that happened earlier.
 *
 * Nothing is queued while the choice is off. Turning it off, or signing out, empties the queue.
 */

import { createStore, type ReadableStore } from '../../lib/store.ts';
import type { PaymentPopupPrefs } from '../../platform/paymentPopupPrefs.ts';
import type { EntityStore } from '../../realtime/entity-store.ts';
import { dismissFirst, enqueue, type PopupEntry } from './payment-popup-model.ts';

export interface PaymentPopupState {
  /** The choice of this device. On until someone turns it off. */
  enabled: boolean;
  /** The remembered choice has been read. */
  loaded: boolean;
  /** The first one is on screen. */
  queue: PopupEntry[];
}

export interface PaymentPopupStore extends ReadableStore<PaymentPopupState> {
  /** Reads the remembered choice. Call once at start-up; a second call does nothing. */
  init(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  /** Closes the pop-up on screen; the next one takes its place. */
  dismiss(): void;
  /** Starts listening for payment alerts. Returns the function that stops it. */
  bind(): () => void;
  /** Sign-out: nothing of the last person stays on screen. The choice is kept. */
  reset(): void;
}

/** How many alert ids are remembered, so a frame delivered twice is one pop-up. */
const SEEN_FRAMES = 50;

export function createPaymentPopupStore(deps: {
  entities: Pick<EntityStore, 'onAlert'>;
  prefs: PaymentPopupPrefs;
}): PaymentPopupStore {
  const store = createStore<PaymentPopupState>({ enabled: true, loaded: false, queue: [] });
  let started = false;
  /** The choice changed before the saved value was read: the person's tap wins. */
  let touched = false;
  const seen: string[] = [];

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    async init() {
      if (started) return;
      started = true;
      const saved = await deps.prefs.load().catch(() => undefined);
      if (!touched) store.setState({ enabled: saved !== false, loaded: true });
      else store.setState({ loaded: true });
    },

    async setEnabled(enabled) {
      touched = true;
      store.setState(enabled ? { enabled } : { enabled, queue: [] });
      await deps.prefs.save(enabled).catch(() => undefined);
    },

    dismiss() {
      store.setState({ queue: dismissFirst(store.getState().queue) });
    },

    bind() {
      return deps.entities.onAlert((frame) => {
        if (frame.type !== 'alert.payment') return;
        if (!store.getState().enabled) return;
        if (seen.includes(frame.id)) return;
        seen.push(frame.id);
        if (seen.length > SEEN_FRAMES) seen.shift();
        const { orderId, orderNo, kind } = frame.data;
        store.setState({ queue: enqueue(store.getState().queue, { orderId, orderNo, kind }) });
      });
    },

    reset() {
      store.setState({ queue: [] });
    },
  };
}
