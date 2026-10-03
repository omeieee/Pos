import { type Locale, type MessageKey, type MessageParams, t } from '@sds/i18n';
import { createContext, useContext } from 'react';
import type { Api } from '../api/client.ts';
import { ApiFailure } from '../api/client.ts';
import type { Platform } from '../platform/liff.ts';

export interface AppContext {
  api: Api;
  platform: Platform;
  locale: Locale;
  go: (path: string, options?: { replace?: boolean }) => void;
}

export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const value = useContext(Ctx);
  if (!value) throw new Error('outside the app');
  return value;
}

/** Thai by default; English only when the phone says so. */
export function localeFromBrowser(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')
    ? 'en'
    : 'th';
}

export function useT() {
  const { locale } = useApp();
  return (key: MessageKey, params?: MessageParams) => t(locale, key, params);
}

const KNOWN: Record<string, MessageKey> = {
  SHOP_CLOSED: 'liff.error.SHOP_CLOSED',
  UNKNOWN_BUILDING: 'liff.error.UNKNOWN_BUILDING',
  METHOD_UNAVAILABLE: 'liff.error.METHOD_UNAVAILABLE',
  GOV_COPAY_UNAVAILABLE: 'liff.error.GOV_COPAY_UNAVAILABLE',
  PRIVACY_NOT_ACKNOWLEDGED: 'liff.error.PRIVACY_NOT_ACKNOWLEDGED',
  ORDER_INVALID: 'liff.error.ORDER_INVALID',
  RATE_LIMITED: 'liff.error.RATE_LIMITED',
  PAYMENT_NOT_PENDING: 'liff.error.PAYMENT_NOT_PENDING',
  QR_NOT_AVAILABLE: 'liff.error.QR_NOT_AVAILABLE',
  NOT_FOUND: 'liff.error.NOT_FOUND',
  NETWORK: 'liff.error.network',
  LIFF_TOKEN_INVALID: 'liff.error.signin',
  NO_CREDENTIAL: 'liff.error.signin',
};

/** The message key for a failed call: the API's own code when we know it, else a generic one. */
export function errorKey(error: unknown): MessageKey {
  return (error instanceof ApiFailure ? KNOWN[error.code] : undefined) ?? 'liff.error.generic';
}
