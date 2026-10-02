/**
 * Composition root: builds the API client, the auth store, the entity store and the realtime
 * connection and wires them together. The client reads its tokens from the auth store and reports
 * "session or device gone" back to it; the connection reads the same tokens, fills the entity
 * store, and reports a server-ended session (close 4401/4403) the same way.
 */
import { type ApiClient, createApiClient } from './api/client.ts';
import { ApiClientError } from './api/errors.ts';
import { type AuthStore, createAuthStore } from './auth/auth-store.ts';
import { type Activity, createActivity } from './lib/activity.ts';
import {
  type AppUpdates,
  createAppUpdates,
  type ServiceWorkerHost,
} from './platform/appUpdates.ts';
import { apiBaseUrl } from './platform/config.ts';
import { type Lifecycle, webLifecycle } from './platform/lifecycle.ts';
import { webServiceWorker } from './platform/serviceWorker.ts';
import { createWebSocket, type SocketFactory, socketUrl } from './platform/socket.ts';
import { createWebTokenStore, type TokenStore } from './platform/tokenStore.ts';
import { type CartStore, createCartStore } from './pos/cart-store.ts';
import { createOrderMovesStore, type OrderMovesStore } from './pos/order-moves-store.ts';
import { createPaymentStore, type PaymentStore } from './pos/payment-store.ts';
import { bindRealtime } from './realtime/bind.ts';
import { type Connection, createConnection } from './realtime/connection.ts';
import { createEntityStore, type EntityStore } from './realtime/entity-store.ts';

export interface Services {
  api: ApiClient;
  auth: AuthStore;
  entities: EntityStore;
  connection: Connection;
  /** Work a page reload would lose; the app applies a waiting update only while it is idle. */
  activity: Activity;
  /** The order being rung up at the counter. */
  cart: CartStore;
  /** The payment calls of the order page: guarded, idempotent, kept across pages. */
  payments: PaymentStore;
  /** The status moves of an order (order page and kitchen view): guarded, reconciled, epoch-safe. */
  orderMoves: OrderMovesStore;
  /** The service worker's update state. `updates.start()` registers it (production builds only). */
  updates: AppUpdates;
  /** Is the app in front, is the device online; the web one wraps the browser events. */
  lifecycle: Lifecycle;
  /** Runs the connection while someone is signed in. Call once at start-up; returns the unbinder. */
  bindRealtime(): () => void;
}

export function createServices(
  options: {
    fetch?: typeof fetch;
    tokens?: TokenStore;
    baseUrl?: string;
    createSocket?: SocketFactory;
    lifecycle?: Lifecycle;
    serviceWorker?: ServiceWorkerHost;
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
  const cart = createCartStore({ api, entities, activity });
  const payments = createPaymentStore({ api, entities, activity, auth });
  const orderMoves = createOrderMovesStore({ api, entities });
  const updates = createAppUpdates({
    host: options.serviceWorker ?? webServiceWorker,
    lifecycle: options.lifecycle ?? webLifecycle,
    isBusy: activity.isBusy,
  });

  return {
    api,
    auth,
    entities,
    connection,
    activity,
    cart,
    payments,
    orderMoves,
    lifecycle,
    updates,
    bindRealtime: () =>
      bindRealtime({
        auth,
        connection,
        entities,
        // What belongs to the person who left, including requests still on their way.
        onSignedOut: () => {
          cart.reset();
          payments.reset();
          orderMoves.reset();
        },
      }),
  };
}
