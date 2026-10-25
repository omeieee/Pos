import type { LocalStore } from './localStore.ts';

export const PAYMENT_POPUP_KEY = 'payment_popup.enabled';

/** The remembered choice: load it (undefined when never chosen), save it. */
export interface PaymentPopupPrefs {
  load(): Promise<boolean | undefined>;
  save(enabled: boolean): Promise<void>;
}

/**
 * The remembered "payment pop-up on" choice, per device, in the local store (the key-value area
 * that survives a reload). Like the sound choice it is NOT in the token store: a sign-out must not
 * forget how a counter screen is set up. Nothing saved means "on" (the caller's default, D-42).
 * `open` is called on first use, so the store (and Dexie behind it) loads only when it is first
 * looked at.
 */
export function createPaymentPopupPrefs(open: () => Promise<LocalStore>): PaymentPopupPrefs {
  let store: Promise<LocalStore> | null = null;
  const get = () => {
    store ??= open();
    return store;
  };
  return {
    async load() {
      const value = await (await get()).kv.get<unknown>(PAYMENT_POPUP_KEY);
      return typeof value === 'boolean' ? value : undefined;
    },
    async save(enabled) {
      await (await get()).kv.set(PAYMENT_POPUP_KEY, enabled);
    },
  };
}
