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

const LOCALE_KEY = 'sds.locale';

/** The language the customer picked last time, if this browser lets us remember it. */
export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v === 'th' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // Private mode or blocked storage: the choice just lasts until the app closes.
  }
}

/** The language switch lives outside `Ctx` so the loading and error screens can use it too. */
export const LocaleCtx = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({
  locale: 'th',
  setLocale: () => {},
});

export function useLocale() {
  return useContext(LocaleCtx);
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
  TOO_MANY_OPEN_ORDERS: 'liff.error.TOO_MANY_OPEN_ORDERS',
  ORDER_TOO_LARGE: 'liff.error.ORDER_TOO_LARGE',
  SLIP_TOO_LARGE: 'liff.error.SLIP_TOO_LARGE',
  FST_ERR_CTP_BODY_TOO_LARGE: 'liff.error.SLIP_TOO_LARGE',
  SLIP_TYPE_UNSUPPORTED: 'liff.error.SLIP_TYPE_UNSUPPORTED',
  NO_PAYMENT_TO_CLAIM: 'liff.error.PAYMENT_NOT_PENDING',
  NETWORK: 'liff.error.network',
  LIFF_TOKEN_INVALID: 'liff.error.signin',
  NO_CREDENTIAL: 'liff.error.signin',
};

/** The message key for a failed call: the API's own code when we know it, else a generic one. */
export function errorKey(error: unknown): MessageKey {
  return (error instanceof ApiFailure ? KNOWN[error.code] : undefined) ?? 'liff.error.generic';
}
