/**
 * Composition root: builds the API client and the auth store and wires them together. The
 * client reads its tokens from the store and reports "session or device gone" back to it.
 */
import { type ApiClient, createApiClient } from './api/client.ts';
import { type AuthStore, createAuthStore } from './auth/auth-store.ts';
import { apiBaseUrl } from './platform/config.ts';
import { createWebTokenStore, type TokenStore } from './platform/tokenStore.ts';

export interface Services {
  api: ApiClient;
  auth: AuthStore;
}

export function createServices(
  options: { fetch?: typeof fetch; tokens?: TokenStore; baseUrl?: string } = {},
): Services {
  let auth!: AuthStore;
  const api = createApiClient({
    baseUrl: options.baseUrl ?? apiBaseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    getSessionToken: () => auth.sessionToken(),
    getDeviceToken: () => auth.deviceToken(),
    onAuthFailure: (error) => auth.handleAuthFailure(error),
  });
  auth = createAuthStore({ api, tokens: options.tokens ?? createWebTokenStore() });
  return { api, auth };
}
