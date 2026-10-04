import { type Locale, type MessageKey, t } from '@sds/i18n';
import type { CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Api, createApi } from './api/client.ts';
import type { Cart } from './model/cart.ts';
import { apiBaseUrl } from './platform/config.ts';
import { type Platform, startPlatform } from './platform/liff.ts';
import {
  Ctx,
  errorKey,
  LocaleCtx,
  localeFromBrowser,
  readStoredLocale,
  storeLocale,
  useApp,
  useT,
} from './ui/app-context.tsx';
import { CheckoutScreen, PrivacyGate } from './ui/CartScreen.tsx';
import { Body, Frame, Header, Notice } from './ui/Chrome.tsx';
import { MenuScreen } from './ui/MenuScreen.tsx';
import { OrderScreen, OrdersScreen } from './ui/OrderScreen.tsx';

/** The page the address names. Plain paths, so `https://liff.line.me/<id>/orders/<id>` lands here. */
function usePath(): [string, (path: string, options?: { replace?: boolean }) => void] {
  const [path, setPath] = useState(() => `${location.pathname}${location.search}`);
  useEffect(() => {
    const onPop = () => setPath(`${location.pathname}${location.search}`);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: string, options?: { replace?: boolean }) => {
    if (options?.replace) history.replaceState(null, '', next);
    else history.pushState(null, '', next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);
  return [path, go];
}

type Boot =
  | { state: 'loading' }
  | { state: 'ready'; platform: Platform; api: Api }
  | { state: 'error'; error: unknown };

const tr = (locale: 'th' | 'en', key: MessageKey) => t(locale, key);

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [path, go] = usePath();
  const [locale, setLocaleState] = useState<Locale>(
    () => readStoredLocale() ?? localeFromBrowser(),
  );
  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocaleState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const localeValue = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  useEffect(() => {
    startPlatform(import.meta.env.VITE_LIFF_ID)
      .then((platform) =>
        setBoot({
          state: 'ready',
          platform,
          api: createApi({ baseUrl: apiBaseUrl, credential: () => platform.credential() }),
        }),
      )
      .catch((error: unknown) => setBoot({ state: 'error', error }));
  }, []);

  if (boot.state !== 'ready') {
    return (
      <LocaleCtx.Provider value={localeValue}>
        <Frame>
          <Header title={tr(locale, 'liff.app.name')} />
          <Body>
            {boot.state === 'error' ? (
              <Notice tone="bad" icon="warn" alert>
                {tr(locale, 'liff.error.signin')}
              </Notice>
            ) : (
              <Notice icon="clock">{tr(locale, 'liff.loading')}</Notice>
            )}
          </Body>
        </Frame>
      </LocaleCtx.Provider>
    );
  }
  return (
    <LocaleCtx.Provider value={localeValue}>
      <Ctx.Provider value={{ api: boot.api, platform: boot.platform, locale, go }}>
        <Frame>
          <Screens path={path} />
        </Frame>
      </Ctx.Provider>
    </LocaleCtx.Provider>
  );
}

function Screens({ path }: { path: string }) {
  const tr = useT();
  const { api } = useApp();
  const [menu, setMenu] = useState<PublicMenuResponse | null>(null);
  const [info, setInfo] = useState<CheckoutInfo | null>(null);
  const [cart, setCart] = useState<Cart>([]);
  const [failure, setFailure] = useState<unknown>(null);

  const refreshInfo = useCallback(async () => {
    setInfo(await api.checkout());
  }, [api]);

  const load = useCallback(() => {
    setFailure(null);
    api.menu().then(setMenu).catch(setFailure);
    refreshInfo().catch(setFailure);
  }, [api, refreshInfo]);
  useEffect(load, [load]);

  const [pathname, query] = path.split('?') as [string, string | undefined];
  const flag = new URLSearchParams(query ?? '').get('placed')
    ? 'placed'
    : new URLSearchParams(query ?? '').get('payment');
  const orderId = /^\/orders\/([0-9a-f-]{36})$/i.exec(pathname)?.[1];

  if (failure !== null && (!menu || !info)) {
    return (
      <>
        <Header title={tr('liff.app.name')} />
        <Body>
          <Notice tone="bad" icon="warn" alert>
            {tr(errorKey(failure))}
          </Notice>
          <button
            type="button"
            className="g-btn g-btn-p g-btn-block"
            style={{ marginTop: 14 }}
            onClick={load}
          >
            {tr('liff.retry')}
          </button>
        </Body>
      </>
    );
  }
  if (info && !info.privacyAcknowledged) {
    // First use (or a new notice version): the notice comes before anything else.
    return <PrivacyGate refreshInfo={refreshInfo} />;
  }
  if (orderId) return <OrderScreen id={orderId} flag={flag} />;
  if (pathname === '/orders') return <OrdersScreen />;
  if (!menu) {
    return (
      <>
        <Header title={tr('liff.app.name')} />
        <Body>
          <Notice icon="clock">{tr('liff.loading')}</Notice>
        </Body>
      </>
    );
  }
  // The cart and the checkout are one screen (`/cart` is the old address of it).
  if ((pathname === '/checkout' || pathname === '/cart') && info) {
    return (
      <CheckoutScreen
        menu={menu}
        info={info}
        cart={cart}
        setCart={setCart}
        clearCart={() => setCart([])}
        refreshInfo={refreshInfo}
      />
    );
  }
  return <MenuScreen menu={menu} info={info} cart={cart} setCart={setCart} />;
}
