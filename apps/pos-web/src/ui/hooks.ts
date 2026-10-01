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
import type { ReadableStore } from '../lib/store.ts';
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

/** The current time in epoch ms, refreshed every `intervalMs`. Pass null to stop the timer. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const COARSE = '(pointer: coarse)';

function readViewport(): ViewportInfo {
  if (typeof window === 'undefined') return { width: 1180, coarsePointer: true };
  return { width: window.innerWidth, coarsePointer: window.matchMedia(COARSE).matches };
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
    const pointer = window.matchMedia(COARSE);
    window.addEventListener('resize', update);
    pointer.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      pointer.removeEventListener('change', update);
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
