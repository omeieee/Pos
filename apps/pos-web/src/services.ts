/**
 * Composition root: builds the API client, the auth store, the entity store and the realtime
 * connection and wires them together. The client reads its tokens from the auth store and reports
 * "session or device gone" back to it; the connection reads the same tokens, fills the entity
 * store, and reports a server-ended session (close 4401/4403) the same way.
 */
import { type ApiClient, createApiClient } from './api/client.ts';
import { ApiClientError } from './api/errors.ts';
import { resetRoute } from './app/navigate.ts';
import { type AuthStore, createAuthStore } from './auth/auth-store.ts';
import { type Activity, createActivity } from './lib/activity.ts';
import { createMenuEditorStore, type MenuEditorStore } from './menu-editor/menu-editor-store.ts';
import {
  type AppUpdates,
  createAppUpdates,
  type ServiceWorkerHost,
} from './platform/appUpdates.ts';
import { type TextClipboard, webClipboard } from './platform/clipboard.ts';
import { apiBaseUrl } from './platform/config.ts';
import { type Lifecycle, webLifecycle } from './platform/lifecycle.ts';
import { type LocalStore, openLocalStore } from './platform/localStore.ts';
import { createWebPhotoEngine } from './platform/photo.ts';
import { webServiceWorker } from './platform/serviceWorker.ts';
import { createWebSocket, type SocketFactory, socketUrl } from './platform/socket.ts';
import { createSound, type SoundPlayer } from './platform/sound.ts';
import { createSoundPrefs } from './platform/soundPrefs.ts';
import { createWebTokenStore, type TokenStore } from './platform/tokenStore.ts';
import { createWebWakeLock, type ScreenWakeLock } from './platform/wakeLock.ts';
import { createWebAudioEngine } from './platform/webAudio.ts';
import { type CartStore, createCartStore } from './pos/cart-store.ts';
import { type CatalogueCache, createCatalogueCache } from './pos/catalogue-cache.ts';
import { createNewOrderAlarm } from './pos/new-order-alarm.ts';
import { createOrderMovesStore, type OrderMovesStore } from './pos/order-moves-store.ts';
import { createOutboxStore, type OutboxStore } from './pos/outbox-store.ts';
import { createPaymentStore, type PaymentStore } from './pos/payment-store.ts';
import { createPromptpayCache, type PromptpayCache } from './pos/promptpay-cache.ts';
import { createRecipientStore, type RecipientStore } from './pos/recipient-store.ts';
import { bindRealtime } from './realtime/bind.ts';
import { type Connection, createConnection } from './realtime/connection.ts';
import { createEntityStore, type EntityStore } from './realtime/entity-store.ts';
import { type AdminStore, createAdminStore } from './settings/admin-store.ts';
import { createSettingsStore, type SettingsStore } from './settings/settings-store.ts';

export interface Services {
  api: ApiClient;
  auth: AuthStore;
  entities: EntityStore;
  connection: Connection;
  /** Work a page reload would lose; the app applies a waiting update only while it is idle. */
  activity: Activity;
  /** The order being rung up at the counter. */
  cart: CartStore;
  /** The Grab / LINE MAN order being keyed in by hand (its own cart: no recipient, a channel). */
  platformCart: CartStore;
  /** Orders and cash that could not reach the server: kept on the device, replayed when it can. */
  outbox: OutboxStore;
  /**
   * The saved copy of the menu and settings: read at sign-in so a reload with no connection still
   * has a menu, kept up to date after each change.
   */
  catalogue: CatalogueCache;
  /**
   * The shop's PromptPay ID saved on this device for the offline QR (D-20): its own record, kept
   * fresh after sign-in, on reconnect and on a change notice. Only `qr()` hands the ID out.
   */
  promptpay: PromptpayCache;
  /** The remembered recipients of the order screen, and the list of buildings. */
  recipients: RecipientStore;
  /** The payment calls of the order page: guarded, idempotent, kept across pages. */
  payments: PaymentStore;
  /**
   * The menu editor (Settings): online only, reads archived rows and, for `report.view`, the costs,
   * which live in this store's memory and nowhere else.
   */
  menuEditor: MenuEditorStore;
  /**
   * The settings screens (Settings): online only, versioned writes, a sensitive one asks for a
   * step-up first.
   */
  settingsEditor: SettingsStore;
  /** The devices and staff screens (owner only): every call needs a step-up, a PIN is never kept. */
  adminEditor: AdminStore;
  /** The status moves of an order (order page and kitchen view): guarded, reconciled, epoch-safe. */
  orderMoves: OrderMovesStore;
  /** The chime for a new order and its remembered on/off choice (a platform seam). */
  sound: SoundPlayer;
  /** Keeps the screen awake while a display needs it (a platform seam). */
  wakeLock: ScreenWakeLock;
  /** Copies text to the clipboard (a platform seam): the invite link, the recovery codes. */
  clipboard: TextClipboard;
  /** The service worker's update state. `updates.start()` registers it (production builds only). */
  updates: AppUpdates;
  /** Is the app in front, is the device online; the web one wraps the browser events. */
  lifecycle: Lifecycle;
  /**
   * Runs the connection while someone is signed in, and the new-order sound. Call once at start-up;
   * returns the unbinder.
   */
  bindRealtime(): () => void;
}

/** Runs `make` the first time and hands every caller the same answer. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= make();
    return promise;
  };
}

export function createServices(
  options: {
    fetch?: typeof fetch;
    tokens?: TokenStore;
    baseUrl?: string;
    createSocket?: SocketFactory;
    lifecycle?: Lifecycle;
    serviceWorker?: ServiceWorkerHost;
    /** Tests give the sound, the wake lock and the local store their own doubles. */
    sound?: SoundPlayer;
    wakeLock?: ScreenWakeLock;
    clipboard?: TextClipboard;
    localStore?: () => Promise<LocalStore>;
    /** Tests shorten the wait before the saved menu is written. */
    catalogueDebounceMs?: number;
  } = {},
): Services {
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  let auth!: AuthStore;
  const api = createApiClient({
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    getSessionToken: () => auth.sessionToken(),
    getDeviceToken: () => auth.deviceToken(),
    onAuthFailure: (error) => auth.handleAuthFailure(error),
  });
  auth = createAuthStore({ api, tokens: options.tokens ?? createWebTokenStore() });

  const entities = createEntityStore();
  const connection = createConnection({
    entities,
    fetchSync: (query) => api.sync.changes(query),
    credentials: () => {
      const sessionToken = auth.sessionToken();
      return sessionToken ? { sessionToken, deviceToken: auth.deviceToken() } : null;
    },
    createSocket: options.createSocket ?? createWebSocket,
    lifecycle: options.lifecycle ?? webLifecycle,
    url: socketUrl(baseUrl, typeof location === 'undefined' ? undefined : location),
    // The server ended the session: the same sign-out as an expired session on a REST call.
    onAuthLost: (kind) =>
      auth.handleAuthFailure(
        new ApiClientError(kind === 'forbidden' ? 'DEVICE_MISMATCH' : 'UNAUTHENTICATED', {
          status: 401,
        }),
      ),
  });

  const lifecycle = options.lifecycle ?? webLifecycle;
  const activity = createActivity();
  // One opening of the local store, shared by the outbox and the sound preference.
  const openStore = once(options.localStore ?? (() => openLocalStore()));
  const outbox = createOutboxStore({
    api,
    entities,
    auth,
    lifecycle,
    connection,
    localStore: openStore,
  });
  const catalogue = createCatalogueCache({
    entities,
    auth,
    connection,
    localStore: openStore,
    lifecycle,
    ...(options.catalogueDebounceMs === undefined
      ? {}
      : { debounceMs: options.catalogueDebounceMs }),
  });
  const promptpay = createPromptpayCache({
    api,
    entities,
    auth,
    connection,
    lifecycle,
    localStore: openStore,
  });
  const cart = createCartStore({ api, entities, activity, outbox });
  const platformCart = createCartStore({ api, entities, activity, outbox, mode: 'platform' });
  const recipients = createRecipientStore({ api, entities });
  const payments = createPaymentStore({ api, entities, activity, auth });
  const orderMoves = createOrderMovesStore({ api, entities });
  const menuEditor = createMenuEditorStore({
    api,
    entities,
    lifecycle,
    canSeeCosts: () => auth.getState().session?.permissions.includes('report.view') ?? false,
    photoEngine: createWebPhotoEngine(),
  });
  const settingsEditor = createSettingsStore({ api, lifecycle, auth });
  const adminEditor = createAdminStore({ api, lifecycle, auth });
  const updates = createAppUpdates({
    host: options.serviceWorker ?? webServiceWorker,
    lifecycle: options.lifecycle ?? webLifecycle,
    isBusy: activity.isBusy,
  });

  const sound =
    options.sound ??
    createSound({
      engine: createWebAudioEngine(),
      prefs: createSoundPrefs(openStore),
      lifecycle,
    });
  const wakeLock = options.wakeLock ?? createWebWakeLock({ lifecycle });
  const alarm = createNewOrderAlarm({
    entities,
    sound,
    deviceId: () => auth.getState().device?.id ?? null,
  });

  return {
    api,
    auth,
    entities,
    connection,
    activity,
    cart,
    platformCart,
    outbox,
    catalogue,
    promptpay,
    recipients,
    payments,
    orderMoves,
    menuEditor,
    settingsEditor,
    adminEditor,
    sound,
    wakeLock,
    clipboard: options.clipboard ?? webClipboard,
    lifecycle,
    updates,
    bindRealtime() {
      const unbind = bindRealtime({
        auth,
        connection,
        entities,
        // What belongs to the person who left, including requests still on their way.
        onSignedOut: () => {
          cart.reset();
          platformCart.reset();
          recipients.reset();
          payments.reset();
          orderMoves.reset();
          menuEditor.reset();
          settingsEditor.reset();
          adminEditor.reset();
          // The next person lands on their own first page, not on the one the last person left.
          resetRoute();
        },
      });
      // After the line above: its sign-in reset empties the entity store, then this puts the saved
      // menu back (before the network has answered).
      const unbindCatalogue = catalogue.bind();
      const unbindPromptpay = promptpay.bind();
      void sound.init();
      const stopAlarm = alarm.start();
      // Replays the outbox while someone is signed in; sign-out keeps what is waiting.
      const unbindOutbox = outbox.bind();
      return () => {
        unbind();
        unbindCatalogue();
        unbindPromptpay();
        stopAlarm();
        unbindOutbox();
      };
    },
  };
}
