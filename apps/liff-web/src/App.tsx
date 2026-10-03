import type { CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Api, createApi } from './api/client.ts';
import type { Cart } from './model/cart.ts';
import { apiBaseUrl } from './platform/config.ts';
import { type Platform, startPlatform } from './platform/liff.ts';
import { Ctx, errorKey, localeFromBrowser, useApp, useT } from './ui/app-context.tsx';
import { CartScreen, CheckoutScreen } from './ui/CartScreen.tsx';
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

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [path, go] = usePath();
  const locale = useMemo(localeFromBrowser, []);

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
      <main className="page">
        <p className={boot.state === 'error' ? 'error' : 'muted'} role="status">
          {boot.state === 'error' ? tr(locale, 'liff.error.signin') : tr(locale, 'liff.loading')}
        </p>
      </main>
    );
  }
  return (
    <Ctx.Provider value={{ api: boot.api, platform: boot.platform, locale, go }}>
      <Shell path={path} />
    </Ctx.Provider>
  );
}

import { type MessageKey, t } from '@sds/i18n';

const tr = (locale: 'th' | 'en', key: MessageKey) => t(locale, key);

function Shell({ path }: { path: string }) {
  const tr = useT();
  const { api, go } = useApp();
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

  let screen: React.ReactNode;
  if (failure !== null && (!menu || !info)) {
    screen = (
      <div>
        <p className="error" role="alert">
          {tr(errorKey(failure))}
        </p>
        <button type="button" className="btn" onClick={load}>
          {tr('liff.retry')}
        </button>
      </div>
    );
  } else if (orderId) {
    screen = <OrderScreen id={orderId} flag={flag} />;
  } else if (pathname === '/orders') {
    screen = <OrdersScreen />;
  } else if (!menu) {
    screen = <p className="muted">{tr('liff.loading')}</p>;
  } else if (pathname === '/cart') {
    screen = <CartScreen menu={menu} cart={cart} setCart={setCart} />;
  } else if (pathname === '/checkout' && info) {
    screen = (
      <CheckoutScreen
        menu={menu}
        info={info}
        cart={cart}
        clearCart={() => setCart([])}
        refreshInfo={refreshInfo}
      />
    );
  } else {
    screen = <MenuScreen menu={menu} info={info} cart={cart} setCart={setCart} />;
  }

  return (
    <>
      <header className="bar">
        <button
          type="button"
          className="tab"
          onClick={() => go('/menu')}
          aria-current={pathname === '/menu' || pathname === '/' ? 'page' : undefined}
        >
          {tr('liff.nav.menu')}
        </button>
        <button
          type="button"
          className="tab"
          onClick={() => go('/orders')}
          aria-current={pathname.startsWith('/orders') ? 'page' : undefined}
        >
          {tr('liff.nav.orders')}
        </button>
      </header>
      <main className="page">{screen}</main>
    </>
  );
}
