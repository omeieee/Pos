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
  /** The service worker's update state. `updates.start()` registers it (production builds only). */
  updates: AppUpdates;
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

  const activity = createActivity();
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
    updates,
    bindRealtime: () => bindRealtime({ auth, connection, entities }),
  };
}
