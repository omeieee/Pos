/**
 * App updates (D-05 item 4): the service worker keeps the app SHELL (HTML, JS, CSS, icons) so an
 * iPad that reloads with no network still opens the app. Nothing from `/v1` and no image from the
 * API is ever cached; the data comes from the entity store and the outbox, not from the worker.
 *
 * A new version must never strand an old shell, and must never reload the page under someone who
 * is ringing up an order. So:
 * - the worker is registered in "prompt" mode: a new version waits, and `needRefresh` goes true;
 * - the app asks the worker whether there is a new version every hour and when it comes back to
 *   the front (a Home Screen app is hardly ever closed, so it would otherwise never look);
 * - when `needRefresh` is true the shell shows an "update now" button, and the update is applied
 *   by itself when the app goes to the background and nothing is in progress (`isBusy`: a cart
 *   with lines, an order being sent; later payment screens register too). Applying reloads the page.
 * - a waiting version also takes over when the app is next opened from nothing.
 *
 * Browser pieces come through the platform seam: `ServiceWorkerHost` (the web one wraps
 * `virtual:pwa-register`; service workers do not run in an Electron `file://` window and are often
 * missing in Capacitor, so those shells simply provide no host) and `Lifecycle`.
 */
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { Lifecycle } from './lifecycle.ts';

export interface RegistrationLike {
  update(): Promise<unknown>;
}

export interface ServiceWorkerHost {
  /**
   * Registers the worker. `onNeedRefresh` fires when a new version is waiting; `onRegistered`
   * hands over the registration for periodic checks. Returns the function that activates the
   * waiting version (and reloads the page when asked).
   */
  register(handlers: {
    onNeedRefresh(): void;
    onRegistered(registration: RegistrationLike | undefined): void;
  }): (reload: boolean) => Promise<void>;
}

export interface UpdateState {
  needRefresh: boolean;
}

export interface AppUpdates extends ReadableStore<UpdateState> {
  start(): void;
  apply(): Promise<void>;
}

const HOUR_MS = 60 * 60 * 1000;

export function createAppUpdates(deps: {
  host: ServiceWorkerHost;
  lifecycle: Lifecycle;
  /** True while a reload would lose work. */
  isBusy: () => boolean;
  checkEveryMs?: number;
}): AppUpdates {
  const state = createStore<UpdateState>({ needRefresh: false });
  let started = false;
  let activate: ((reload: boolean) => Promise<void>) | null = null;
  let registration: RegistrationLike | undefined;
  let applying: Promise<void> | null = null;

  function check() {
    // Offline or a transient failure: the next check tries again.
    registration?.update().catch(() => undefined);
  }

  function apply(): Promise<void> {
    if (!activate) return Promise.resolve();
    applying ??= activate(true).catch(() => {
      applying = null;
    });
    return applying;
  }

  return {
    getState: state.getState,
    subscribe: state.subscribe,
    apply,
    start() {
      if (started) return;
      started = true;
      activate = deps.host.register({
        onNeedRefresh: () => state.setState({ needRefresh: true }),
        onRegistered(found) {
          registration = found;
        },
      });
      setInterval(check, deps.checkEveryMs ?? HOUR_MS);
      deps.lifecycle.subscribe({
        visible: check,
        hidden() {
          if (state.getState().needRefresh && !deps.isBusy()) void apply();
        },
      });
    },
  };
}
