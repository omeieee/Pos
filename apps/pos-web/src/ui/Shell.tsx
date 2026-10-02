import { formatDate } from '@sds/i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { allowedRoutes, pathFromHash, resolveRoute } from '../app/routes.ts';
import { KitchenScreen } from '../pos/KitchenScreen.tsx';
import { OrderDetailScreen } from '../pos/OrderDetailScreen.tsx';
import { OrderEntryScreen } from '../pos/OrderEntryScreen.tsx';
import { OrdersScreen } from '../pos/OrdersScreen.tsx';
import { OutboxBadge } from '../pos/OutboxBadge.tsx';
import { SignOutGuard } from '../pos/SignOutGuard.tsx';
import { Brand } from './Brand.tsx';
import { ConnectionBadge } from './ConnectionBadge.tsx';
import {
  useAuthState,
  useAuthStore,
  useHash,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from './hooks.ts';
import { Icon } from './Icon.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';

// Only managers and the owner open it, so its screens load on first use, not with the till.
const MenuEditorScreen = lazy(async () => ({
  default: (await import('../menu-editor/MenuEditorScreen.tsx')).MenuEditorScreen,
}));

const SettingsHub = lazy(async () => ({
  default: (await import('../settings/SettingsHub.tsx')).SettingsHub,
}));
const SettingsSectionScreen = lazy(async () => ({
  default: (await import('../settings/SettingsSectionScreen.tsx')).SettingsSectionScreen,
}));

/**
 * The signed-in frame: top bar (shop, device, person, role, sign out), navigation limited to
 * what the role may open, and the page. Every page is a friendly placeholder for now.
 */
export function Shell() {
  const auth = useAuthStore();
  const state = useAuthState();
  const tr = useT();
  const locale = useLocale();
  const now = useNow(60_000);
  const hash = useHash();
  const session = state.session;
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const waiting = useStoreState(useServices().outbox).items.length;
  const routes = allowedRoutes(session?.permissions ?? []);
  const resolved = resolveRoute(hash, routes);
  const route = resolved?.route ?? null;
  // The order screens fill the page; the others are still placeholders.
  const full =
    resolved?.page === 'new' ||
    resolved?.page === 'platform' ||
    resolved?.page === 'order' ||
    resolved?.page === 'orders' ||
    resolved?.page === 'kitchen' ||
    resolved?.page === 'menu' ||
    resolved?.page === 'settings' ||
    resolved?.page === 'settingsSection';

  // A page this role may not open (or an unknown address) is replaced by the first allowed one.
  // A page with a parameter keeps its own address, so it is compared as a whole.
  const target = resolved?.path ?? null;
  useEffect(() => {
    if (target !== null && pathFromHash(hash) !== target) window.location.replace(`#${target}`);
  }, [hash, target]);

  if (!session) return null;
  const signOutLabel = tr('shell.signOut');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <Brand />
        </div>
        <div className="topbar__meta">
          {state.device ? (
            <span className="chip">{tr('shell.device', { name: state.device.name })}</span>
          ) : null}
          <ConnectionBadge />
          <OutboxBadge />
          <span className="chip chip--person">
            <Icon name="user" />
            <span>{session.staff.displayName}</span>
            <span className="chip__role">{tr(`role.${session.staff.role}`)}</span>
          </span>
          <time className="topbar__date" dateTime={new Date(now).toISOString()}>
            {formatDate(now, locale, 'date')}
          </time>
        </div>
        <button
          type="button"
          className="btn btn-soft topbar__signout"
          aria-label={signOutLabel}
          onClick={() => (waiting > 0 ? setConfirmingSignOut(true) : void auth.signOut())}
        >
          <Icon name="door" />
          <span className="topbar__signout-label">{signOutLabel}</span>
        </button>
      </header>

      <UpdateBanner />

      {confirmingSignOut ? (
        <SignOutGuard
          count={waiting}
          onCancel={() => setConfirmingSignOut(false)}
          onSignOut={() => void auth.signOut()}
        />
      ) : null}

      <nav className="nav" aria-label={tr('nav.label')}>
        {routes.map((item) => (
          <a
            key={item.id}
            className="nav__item"
            href={`#${item.path}`}
            aria-current={route?.id === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            <span>{tr(item.labelKey)}</span>
          </a>
        ))}
      </nav>

      <main className={full ? 'page page--full' : 'page'}>
        {resolved?.page === 'new' ? <OrderEntryScreen /> : null}
        {resolved?.page === 'platform' ? <OrderEntryScreen mode="platform" /> : null}
        {resolved?.page === 'orders' ? <OrdersScreen /> : null}
        {resolved?.page === 'kitchen' ? <KitchenScreen /> : null}
        {resolved?.page === 'menu' ? (
          <Suspense
            fallback={
              <p className="muted" role="status">
                {tr('menuEditor.loading')}
              </p>
            }
          >
            <MenuEditorScreen />
          </Suspense>
        ) : null}
        {resolved?.page === 'settings' || resolved?.page === 'settingsSection' ? (
          <Suspense
            fallback={
              <p className="muted" role="status">
                {tr('common.loading')}
              </p>
            }
          >
            {resolved.page === 'settings' ? (
              <SettingsHub />
            ) : (
              <SettingsSectionScreen section={resolved.params.section ?? ''} />
            )}
          </Suspense>
        ) : null}
        {resolved?.page === 'order' ? <OrderDetailScreen id={resolved.params.id ?? ''} /> : null}
        {route && resolved && !full ? (
          <section className="coming-soon">
            <span className="coming-soon__art" aria-hidden="true">
              <span className="i i-bowl" />
            </span>
            <h1>{tr('comingSoon.title')}</h1>
            <p className="muted">{tr('comingSoon.body', { page: tr(route.labelKey) })}</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
