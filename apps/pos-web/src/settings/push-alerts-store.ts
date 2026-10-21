/**
 * Phone alerts of THIS device (P8, Web Push): the state of the on/off switch and the rules behind
 * it, outside React so they run (and are tested) without a DOM.
 *
 * - The server holds one subscription per device and the browser holds its own; they can drift
 *   (the browser dropped it, the server pruned a dead one, the server key changed). `load()` makes
 *   them agree when the page opens. The SERVER is the record of what the person chose: a browser
 *   subscription the server does not know is dropped, and a server one the browser lost is made
 *   again only when the permission is already granted (no prompt), otherwise it shows as off.
 * - The switch is never optimistic: it shows "on" only after the server saved the subscription, and
 *   "off" only after the server removed it. A subscription made in the browser whose save failed is
 *   dropped again, so no orphan is left.
 * - `enable()` calls the browser permission and subscribe step in the same tick as the tap, before
 *   anything is awaited (iOS counts an awaited call as outside the tap). The server key is read
 *   when the page opens for that reason, never on the tap.
 * - The setting belongs to the device, not to the person: `reset()` (sign-out) forgets what is on
 *   screen and makes answers still on their way harmless, but never unsubscribes.
 */
import type { ApiClient } from '../api/client.ts';
import { isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { type PushPlatform, PushPlatformError, sameKey } from '../platform/push.ts';

export type PushAlertsStatus =
  /** Nothing read yet (also after sign-out). */
  | 'idle'
  | 'loading'
  /** The server could not be asked; `load()` again. */
  | 'error'
  /** The server has no push keys: the owner has to set it up. */
  | 'not-configured'
  | 'unsupported'
  /** An iPhone or iPad in a Safari tab: add the app to the Home Screen. */
  | 'needs-install'
  /** The browser blocks notifications for this app. */
  | 'denied'
  /** The signed-in session has no registered device to subscribe. */
  | 'no-device'
  | 'off'
  | 'on';

/** What went wrong on the last tap, shown beside the switch; the status stays as it was. */
export type PushAlertsProblem = 'dismissed' | 'enable' | 'disable';

export interface PushAlertsState {
  status: PushAlertsStatus;
  /** The page is being read or a tap is being worked out: the switch is not available. */
  busy: boolean;
  problem: PushAlertsProblem | null;
}

export interface PushAlertsDeps {
  api: { push: Pick<ApiClient['push'], 'config' | 'subscribed' | 'subscribe' | 'unsubscribe'> };
  push: PushPlatform;
}

export interface PushAlertsStore extends ReadableStore<PushAlertsState> {
  /** Reads the server and the browser and makes them agree (a read already on its way is shared). */
  load(): Promise<void>;
  /** Turn alerts on. Call it synchronously from the tap of the switch. */
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Sign-out: forgets what was read and makes every answer still on its way harmless. */
  reset(): void;
}

const quietly = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  );

/** The status a server refusal means by itself, or null when it is just a failure. */
function statusOfRefusal(error: unknown): 'not-configured' | 'no-device' | null {
  if (!isApiClientError(error)) return null;
  if (error.code === 'PUSH_NOT_CONFIGURED') return 'not-configured';
  if (error.code === 'DEVICE_REQUIRED') return 'no-device';
  return null;
}

export function createPushAlertsStore(deps: PushAlertsDeps): PushAlertsStore {
  const store = createStore<PushAlertsState>({ status: 'idle', busy: false, problem: null });
  let generation = 0;
  let publicKey: string | null = null;
  let reading: Promise<void> | null = null;

  const set = (patch: Partial<PushAlertsState>) => store.setState(patch);

  /** Makes the browser and the server agree. Returns the status to show. */
  async function reconcile(key: string, server: boolean): Promise<'on' | 'off'> {
    const local = await deps.push.getSubscription();
    const keyMatches =
      local !== null &&
      (local.applicationServerKey === null || sameKey(local.applicationServerKey, key));

    if (local && keyMatches) {
      if (!server) {
        // The person turned it off (or the server pruned it): the choice is the server's.
        await quietly(deps.push.unsubscribe());
        return 'off';
      }
      // The browser may have rotated its endpoint: saving it again is harmless and keeps it current.
      await quietly(deps.api.push.subscribe(local));
      return 'on';
    }

    // No usable browser subscription: none, or one made for another key (Chrome refuses a new one
    // until it is dropped).
    if (local) await quietly(deps.push.unsubscribe());
    if (server && deps.push.permission() === 'granted') {
      try {
        const made = await deps.push.subscribe(key);
        await deps.api.push.subscribe(made);
        return 'on';
      } catch {
        // Safari may refuse outside a tap even with the permission: quietly off, not an error.
        await quietly(deps.push.unsubscribe());
      }
    }
    if (server) await quietly(deps.api.push.unsubscribe());
    return 'off';
  }

  async function read(): Promise<void> {
    const started = ++generation;
    const current = () => generation === started;
    set({ status: 'loading', busy: true, problem: null });
    const finish = (status: PushAlertsStatus) => {
      if (current()) set({ status, busy: false });
    };
    try {
      const config = await deps.api.push.config();
      if (!current()) return;
      if (!config.enabled || config.publicKey === null) return finish('not-configured');
      publicKey = config.publicKey;
      if (deps.push.needsInstall()) return finish('needs-install');
      if (!deps.push.isSupported()) return finish('unsupported');
      if (deps.push.permission() === 'denied') return finish('denied');
      const { subscribed } = await deps.api.push.subscribed();
      if (!current()) return;
      finish(await reconcile(config.publicKey, subscribed));
    } catch (caught) {
      finish(statusOfRefusal(caught) ?? 'error');
    }
  }

  function load(): Promise<void> {
    if (reading) return reading;
    // A tap is being worked out: its own answer settles the state.
    if (store.getState().busy) return Promise.resolve();
    reading = read().finally(() => {
      reading = null;
    });
    return reading;
  }

  function enable(): Promise<void> {
    const { status, busy } = store.getState();
    const key = publicKey;
    if (busy || status !== 'off' || key === null) return Promise.resolve();
    const started = ++generation;
    set({ busy: true, problem: null });
    // In this tick, before any await: the permission prompt and the browser subscribe.
    const subscribing = deps.push.subscribe(key);
    return (async () => {
      const current = () => generation === started;
      let subscription: Awaited<typeof subscribing>;
      try {
        subscription = await subscribing;
      } catch (caught) {
        if (!current()) return;
        const code = caught instanceof PushPlatformError ? caught.code : 'failed';
        if (code === 'denied') set({ status: 'denied', busy: false });
        else if (code === 'unsupported') set({ status: 'unsupported', busy: false });
        else set({ busy: false, problem: code === 'dismissed' ? 'dismissed' : 'enable' });
        return;
      }
      try {
        await deps.api.push.subscribe(subscription);
      } catch (caught) {
        await quietly(deps.push.unsubscribe());
        if (!current()) return;
        const refused = statusOfRefusal(caught);
        if (refused) set({ status: refused, busy: false });
        else set({ busy: false, problem: 'enable' });
        return;
      }
      if (current()) set({ status: 'on', busy: false });
    })();
  }

  async function disable(): Promise<void> {
    const { status, busy } = store.getState();
    if (busy || status !== 'on') return;
    const started = ++generation;
    const current = () => generation === started;
    set({ busy: true, problem: null });
    try {
      // The server first: if it cannot be reached nothing has changed and the switch stays on.
      await deps.api.push.unsubscribe();
    } catch (caught) {
      const refused = statusOfRefusal(caught);
      if (refused === 'not-configured') await quietly(deps.push.unsubscribe());
      if (!current()) return;
      if (refused) set({ status: refused, busy: false });
      else set({ busy: false, problem: 'disable' });
      return;
    }
    // A browser subscription left behind is dropped by the next `load()`.
    await quietly(deps.push.unsubscribe());
    if (current()) set({ status: 'off', busy: false });
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    load,
    enable,
    disable,
    reset() {
      generation += 1;
      reading = null;
      publicKey = null;
      store.setState({ status: 'idle', busy: false, problem: null });
    },
  };
}
