import { defaultBrand } from '@sds/ui';
import { lazy, Suspense, useEffect } from 'react';
import { allowedRoutes, pathFromHash, type RouteDef, resolveRoute } from '../app/routes.ts';
import { Gi, type GiName } from '../design/icons.tsx';
import { useLayout } from '../design/layout.ts';
import { s } from '../design/style.ts';
import { DashboardScreen } from '../pos/DashboardScreen.tsx';
import { KitchenScreen } from '../pos/KitchenScreen.tsx';
import { kitchenQueue } from '../pos/kitchen-model.ts';
import { OrderDetailScreen } from '../pos/OrderDetailScreen.tsx';
import { OrderEntryScreen } from '../pos/OrderEntryScreen.tsx';
import { OrdersScreen } from '../pos/OrdersScreen.tsx';
import { AccountMenu } from './AccountMenu.tsx';
import { useAuthState, useEntities, useHash, useT } from './hooks.ts';
import { OutboxStrip } from './SyncPill.tsx';
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

/** The design's icon for each page of the navigation. */
const NAV_ICON: Record<RouteDef['id'], GiName> = {
  new: 'grid',
  platform: 'shop',
  kitchen: 'flame',
  orders: 'receipt',
  menu: 'bowl',
  settings: 'sliders',
  dashboard: 'dashboard',
};

/** Not in the rail or the tab bar: Grab / LINE MAN is reached from the cart, the overview is a laptop page. */
const RAIL_HIDDEN = new Set<RouteDef['id']>(['platform', 'dashboard']);
const TAB_ITEMS = new Set<RouteDef['id']>(['new', 'kitchen', 'orders', 'settings']);

const initial = (name: string) => Array.from(name.trim())[0] ?? '';

/**
 * The signed-in frame, in the three shapes of the design: a floating tab bar on a phone, the glass
 * navigation rail on a tablet, and the back-office sidebar on a laptop. There is no top bar any
 * more; who is signed in, the device and the sign-out live behind the avatar (AccountMenu), and
 * each page carries its own header with the sync state. The kitchen is the exception: a dark,
 * full-screen board with its own back button.
 */
export function Shell() {
  const state = useAuthState();
  const tr = useT();
  const hash = useHash();
  const layout = useLayout();
  const entities = useEntities();
  const session = state.session;
  const routes = allowedRoutes(session?.permissions ?? []);
  const resolved = resolveRoute(hash, routes);
  const route = resolved?.route ?? null;
  const kitchen = resolved?.page === 'kitchen';
  // The kitchen board and the payment page are full-screen, each with its own back button (design).
  const bare = kitchen || resolved?.page === 'order';

  // A page this role may not open (or an unknown address) is replaced by the first allowed one.
  // A page with a parameter keeps its own address, so it is compared as a whole.
  const target = resolved?.path ?? null;
  useEffect(() => {
    if (target !== null && pathFromHash(hash) !== target) window.location.replace(`#${target}`);
  }, [hash, target]);

  if (!session) return null;

  const toMake = kitchenQueue(entities.orders.values()).toMake.length;
  const awaiting = [...entities.orders.values()].filter(
    (o) => o.paymentStatus === 'awaiting_confirmation',
  ).length;
  const avatar = initial(session.staff.displayName);
  const who = `${session.staff.displayName} · ${tr(`role.${session.staff.role}`)}`;

  const page = (
    <>
      <UpdateBanner />
      <PageSwitch resolved={resolved} route={route} />
    </>
  );

  const dark = kitchen ? 'g-bgd g-dk' : 'g-bg';
  const frame = s(
    layout === 'phone'
      ? 'height:100dvh;display:flex;flex-direction:column'
      : `height:100dvh;display:flex;gap:${layout === 'side' ? 16 : 18}px;padding:${layout === 'side' ? 16 : 18}px`,
  );

  return (
    <div className={`g-root g-shell ${dark}`} style={frame}>
      {bare ? null : layout === 'rail' ? (
        <RailNav
          routes={routes}
          current={route?.id}
          toMake={toMake}
          avatar={avatar}
          who={who}
          label={tr('nav.label')}
        />
      ) : layout === 'side' ? (
        <SideNav
          routes={routes}
          current={route?.id}
          awaiting={awaiting}
          avatar={avatar}
          name={session.staff.displayName}
          role={tr(`role.${session.staff.role}`)}
          label={tr('nav.label')}
        />
      ) : null}

      <main
        className="g-page"
        style={s(
          `flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:16px;${
            layout === 'phone' && !bare ? 'padding-bottom:104px;' : ''
          }`,
        )}
      >
        {route?.id === 'settings' || route?.id === 'menu' || route?.id === 'dashboard' ? (
          <OutboxStrip />
        ) : null}
        {page}
      </main>

      {bare || layout !== 'phone' ? null : (
        <TabBar routes={routes} current={route?.id} label={tr('nav.label')} />
      )}
    </div>
  );
}

function KitchenBadge({ count, style }: { count: number; style: string }) {
  const tr = useT();
  if (count <= 0) return null;
  return (
    <span
      className="g-badge g-b-bad"
      style={s(style)}
      role="status"
      aria-label={tr('kitchen.toMakeCount', { count })}
    >
      {count}
    </span>
  );
}

function RailNav({
  routes,
  current,
  toMake,
  avatar,
  who,
  label,
}: {
  routes: readonly RouteDef[];
  current: RouteDef['id'] | undefined;
  toMake: number;
  avatar: string;
  who: string;
  label: string;
}) {
  const tr = useT();
  return (
    <nav
      className="g-glass"
      aria-label={label}
      style={s(
        'position:relative;z-index:6;width:96px;flex:none;display:flex;flex-direction:column;align-items:center;gap:8px;padding:18px 0;border-radius:32px',
      )}
    >
      <img
        src="/mark.svg"
        alt={defaultBrand.name}
        style={s(
          'width:52px;height:52px;border-radius:17px;box-shadow:0 8px 18px rgba(198,40,40,.3);margin-bottom:14px',
        )}
      />
      {routes
        .filter((r) => !RAIL_HIDDEN.has(r.id))
        .map((item) => (
          <a
            key={item.id}
            className={`g-nav${current === item.id || (item.id === 'new' && current === 'platform') ? ' g-on' : ''}`}
            href={`#${item.path}`}
            aria-current={current === item.id ? 'page' : undefined}
          >
            <Gi n={NAV_ICON[item.id]} size="lg" />
            {tr(item.labelKey)}
            {item.id === 'kitchen' ? (
              <KitchenBadge
                count={toMake}
                style="position:absolute;top:4px;right:2px;height:22px;padding:0 7px;font-size:12px"
              />
            ) : null}
          </a>
        ))}
      <div style={s('flex-grow:1')} />
      <AccountMenu
        placement="right"
        label={who}
        className="g-avatar"
        style={s('border:0;cursor:pointer;font:inherit')}
      >
        {avatar}
      </AccountMenu>
    </nav>
  );
}

function TabBar({
  routes,
  current,
  label,
}: {
  routes: readonly RouteDef[];
  current: RouteDef['id'] | undefined;
  label: string;
}) {
  const tr = useT();
  return (
    <nav
      className="g-glass2"
      aria-label={label}
      style={s(
        'position:fixed;left:16px;right:16px;bottom:22px;height:72px;border-radius:36px;display:flex;align-items:center;padding:0 8px;gap:2px;z-index:5',
      )}
    >
      {routes
        .filter((r) => TAB_ITEMS.has(r.id))
        .map((item) => (
          <a
            key={item.id}
            className={`g-tab${current === item.id || (item.id === 'new' && current === 'platform') ? ' g-on' : ''}`}
            href={`#${item.path}`}
            style={s('flex:1')}
            aria-current={current === item.id ? 'page' : undefined}
          >
            <Gi n={NAV_ICON[item.id]} />
            {tr(item.labelKey)}
          </a>
        ))}
    </nav>
  );
}

function SideNav({
  routes,
  current,
  awaiting,
  avatar,
  name,
  role,
  label,
}: {
  routes: readonly RouteDef[];
  current: RouteDef['id'] | undefined;
  awaiting: number;
  avatar: string;
  name: string;
  role: string;
  label: string;
}) {
  const tr = useT();
  const has = (id: RouteDef['id']) => routes.find((r) => r.id === id);
  const link = (id: RouteDef['id'], text: string, icon: GiName, badge?: React.ReactNode) => {
    const item = has(id);
    if (!item) return null;
    return (
      <a
        key={id}
        className={`g-side${current === id || (id === 'new' && current === 'platform') ? ' g-on' : ''}`}
        href={`#${item.path}`}
        aria-current={current === id ? 'page' : undefined}
      >
        <Gi n={icon} />
        {text}
        {badge}
      </a>
    );
  };
  // In the design but with nothing behind them yet: shown, never clickable.
  const later = (text: string, icon: GiName) => (
    <span
      key={text}
      className="g-side"
      aria-disabled="true"
      title={tr('nav.notReady')}
      style={s('opacity:.5;cursor:not-allowed')}
    >
      <Gi n={icon} />
      {text}
    </span>
  );
  const kitchenItem = has('kitchen');
  return (
    <aside
      className="g-glass"
      style={s(
        'position:relative;z-index:6;flex:0 0 248px;border-radius:30px;padding:20px 14px;display:flex;flex-direction:column;gap:6px;min-height:0;overflow-y:auto',
      )}
    >
      <div style={s('display:flex;align-items:center;gap:12px;padding:2px 8px 18px')}>
        <img
          src="/mark.svg"
          alt=""
          style={s(
            'width:44px;height:44px;border-radius:14px;box-shadow:0 8px 18px rgba(198,40,40,.3)',
          )}
        />
        <div style={s('line-height:1.3')}>
          <div className="g-t-3">{defaultBrand.name}</div>
          <div className="g-t-c">{tr('nav.backOffice')}</div>
        </div>
      </div>
      <nav aria-label={label} style={s('flex:1;display:flex;flex-direction:column;gap:6px')}>
        {link('dashboard', tr('nav.dashboard'), 'dashboard')}
        {link('new', tr('nav.new'), 'grid')}
        {kitchenItem ? link('kitchen', tr('nav.kitchen'), 'flame') : null}
        {later(tr('nav.sales'), 'bars')}
        {link(
          'orders',
          tr('nav.ordersPayments'),
          'receipt',
          awaiting > 0 ? (
            <span
              className="g-badge g-b-info"
              style={s('margin-left:auto;height:22px;padding:0 8px;font-size:12px')}
            >
              {awaiting}
            </span>
          ) : null,
        )}
        {link('menu', tr('nav.menuPrices'), 'bowl')}
        {later(tr('nav.customers'), 'people')}
        {later(tr('nav.costProfit'), 'dollar')}
        {later(tr('nav.tax'), 'doc')}
        <div style={s('flex-grow:1')} />
        {link('settings', tr('nav.settings'), 'sliders')}
      </nav>
      <AccountMenu
        placement="top"
        label={`${name} · ${role}`}
        className="g-sunk"
        style={s(
          'width:100%;display:flex;align-items:center;gap:10px;padding:10px 12px;margin-top:6px;border:0;cursor:pointer;font:inherit;color:inherit;text-align:left',
        )}
      >
        <span className="g-avatar" style={s('width:38px;height:38px;font-size:15px')}>
          {avatar}
        </span>
        <span style={s('line-height:1.3;flex-grow:1;min-width:0')}>
          <span className="g-t-3" style={s('font-size:14px;display:block')}>
            {name}
          </span>
          <span className="g-t-c" style={s('display:block')}>
            {role}
          </span>
        </span>
        <span className="g-dot" />
      </AccountMenu>
    </aside>
  );
}

function PageSwitch({
  resolved,
  route,
}: {
  resolved: ReturnType<typeof resolveRoute>;
  route: RouteDef | null;
}) {
  const tr = useT();
  if (!resolved || !route) return null;
  switch (resolved.page) {
    case 'new':
      return <OrderEntryScreen />;
    case 'platform':
      return <OrderEntryScreen mode="platform" />;
    case 'orders':
      return <OrdersScreen />;
    case 'order':
      return <OrderDetailScreen id={resolved.params.id ?? ''} />;
    case 'kitchen':
      return <KitchenScreen />;
    case 'dashboard':
      return <DashboardScreen />;
    case 'menu':
      return (
        <Suspense
          fallback={
            <p className="muted" role="status">
              {tr('menuEditor.loading')}
            </p>
          }
        >
          <MenuEditorScreen />
        </Suspense>
      );
    case 'settings':
    case 'settingsSection':
      return (
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
      );
    default:
      return null;
  }
}
