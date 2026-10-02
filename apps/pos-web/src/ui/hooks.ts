import { type Locale, type MessageKey, type MessageParams, translator } from '@sds/i18n';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AuthState, AuthStore } from '../auth/auth-store.ts';
import { subscribeTicks } from '../lib/clock.ts';
import type { ReadableStore } from '../lib/store.ts';
import type { ConnectionState } from '../realtime/connection.ts';
import type { EntityState } from '../realtime/entity-store.ts';
import type { Services } from '../services.ts';
import type { ViewportInfo } from '../theme/device.ts';

export function useStoreState<S>(store: ReadableStore<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// ---------- Auth ----------

export const AuthContext = createContext<AuthStore | null>(null);

export function useAuthStore(): AuthStore {
  const store = useContext(AuthContext);
  if (!store) throw new Error('AuthContext is missing');
  return store;
}

export function useAuthState(): AuthState {
  return useStoreState(useAuthStore());
}

// ---------- Services (API, entity store, realtime connection) ----------

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesContext is missing');
  return services;
}

/**
 * Marks the app busy (no waiting update may reload the page) while `active` is true: a payment
 * that is open, a tender being typed, a dialog that asks for a reason or a step-up.
 */
export function useActivityHold(active: boolean): void {
  const { activity } = useServices();
  useEffect(() => {
    if (!active) return;
    return activity.begin();
  }, [active, activity]);
}

/** The synced rows (orders, payments, menu, settings), re-rendering when any of them change. */
export function useEntities(): EntityState {
  return useStoreState(useServices().entities);
}

export function useConnection(): ConnectionState {
  return useStoreState(useServices().connection);
}

// ---------- Language ----------

export const LocaleContext = createContext<Locale>('th');

export const useLocale = (): Locale => useContext(LocaleContext);

export type Tr = (key: MessageKey, params?: MessageParams) => string;

/** The translator for the current locale (Thai by default). */
export function useT(): Tr {
  const locale = useLocale();
  return useMemo(() => translator(locale), [locale]);
}

// ---------- Time and screen ----------

/**
 * The current time in epoch ms, read fresh on every render. `intervalMs` re-renders the
 * component that often; null stops the timer. Nothing is stored, so the value can never freeze
 * at an old time when the timer stops (for example when a lock has just expired).
 */
export function useNow(intervalMs: number | null): number {
  const [, wake] = useState(0);
  useEffect(() => {
    if (intervalMs === null) return;
    return subscribeTicks(intervalMs, () => wake((n) => n + 1));
  }, [intervalMs]);
  return Date.now();
}

const COARSE = '(pointer: coarse)';

function readViewport(): ViewportInfo {
  if (typeof window === 'undefined') return { width: 1180, coarsePointer: true };
  return {
    width: window.innerWidth,
    // jsdom and very old browsers have no matchMedia: no touch assumed.
    coarsePointer: typeof window.matchMedia === 'function' && window.matchMedia(COARSE).matches,
  };
}

export function useViewport(): ViewportInfo {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const update = () =>
      setViewport((previous) => {
        const next = readViewport();
        return next.width === previous.width && next.coarsePointer === previous.coarsePointer
          ? previous
          : next;
      });
    const pointer = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE) : null;
    window.addEventListener('resize', update);
    pointer?.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      pointer?.removeEventListener('change', update);
    };
  }, []);
  return viewport;
}

/** The address bar's `#...` part, as an external store. */
export function useHash(): string {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('hashchange', notify);
      return () => window.removeEventListener('hashchange', notify);
    },
    () => window.location.hash,
    () => '',
  );
}
