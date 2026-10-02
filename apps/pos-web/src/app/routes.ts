/**
 * The staff app's top-level pages and who may open them. The permission names come from
 * `@sds/shared` and the list of permissions a person has comes from their session, so the
 * role-to-permission table is not copied here. Hiding a page is a convenience: the API checks
 * every call.
 */
import type { MessageKey } from '@sds/i18n';
import type { Permission } from '@sds/shared';

export type IconName =
  | 'list'
  | 'bowl'
  | 'gear'
  | 'door'
  | 'back'
  | 'backspace'
  | 'alert'
  | 'user'
  | 'grid'
  | 'search'
  | 'plus'
  | 'minus'
  | 'x'
  | 'check'
  | 'cart'
  | 'note'
  | 'wifi-off'
  | 'sync'
  | 'circle'
  | 'clock'
  | 'check-circle'
  | 'info'
  | 'cash'
  | 'qr'
  | 'hands'
  | 'store'
  | 'flame'
  | 'volume'
  | 'volume-off';

/** The entries of the navigation: one per top-level page. */
export type RouteId = 'new' | 'platform' | 'kitchen' | 'orders' | 'menu' | 'settings';

/** Everything the address bar can show; `order` is a page inside `orders`. */
export type PageId = RouteId | 'order';

export interface RouteDef {
  id: RouteId;
  path: string;
  labelKey: MessageKey;
  icon: IconName;
  /** null: any signed-in person (the kitchen needs the order queue). */
  permission: Permission | null;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'new', path: '/new', labelKey: 'nav.new', icon: 'grid', permission: 'order.create' },
  // Grab and LINE MAN orders keyed in by hand: the same permission as taking an order.
  {
    id: 'platform',
    path: '/platform',
    labelKey: 'nav.platform',
    icon: 'store',
    permission: 'order.create',
  },
  // The kitchen view is for whoever moves orders along; a kitchen-only role has no other first page.
  {
    id: 'kitchen',
    path: '/kitchen',
    labelKey: 'nav.kitchen',
    icon: 'flame',
    permission: 'order.advance',
  },
  { id: 'orders', path: '/orders', labelKey: 'nav.orders', icon: 'list', permission: null },
  // The menu editor lives under Settings in the address, but is gated by its own permission: a
  // role that may edit the menu need not be able to open the other settings.
  {
    id: 'menu',
    path: '/settings/menu',
    labelKey: 'nav.menu',
    icon: 'bowl',
    permission: 'menu.edit',
  },
  {
    id: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    icon: 'gear',
    permission: 'settings.edit',
  },
];

/** Pages with a parameter in the address. They open when their parent page is allowed. */
interface ParamRouteDef {
  page: PageId;
  pattern: string;
  parent: RouteId;
}

const PARAM_ROUTES: readonly ParamRouteDef[] = [
  { page: 'order', pattern: '/orders/:id', parent: 'orders' },
];

/** The navigation entries a person may open. */
export function allowedRoutes(permissions: readonly Permission[]): RouteDef[] {
  return ROUTES.filter((r) => r.permission === null || permissions.includes(r.permission));
}

/**
 * `/orders/:id` against `/orders/abc` -> `{id: 'abc'}`; null when the path does not match. A
 * `:name` segment matches exactly one non-empty segment.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    const actual = have[index] ?? '';
    if (part.startsWith(':')) {
      if (actual === '') return null;
      params[part.slice(1)] = actual;
    } else if (part !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * `#/settings/menu` -> `/settings/menu`, `#/orders/abc?x=1` -> `/orders/abc`; anything else -> ''. Segments are
 * plain URL-safe characters, so an odd address (`%00`, spaces) never reaches a page.
 */
export function pathFromHash(hash: string): string {
  const match = /^#((?:\/[A-Za-z0-9._~-]+)+)\/?(?:[?#]|$)/.exec(hash);
  return match?.[1] ?? '';
}

export interface ResolvedRoute {
  page: PageId;
  /** The navigation entry to highlight. */
  route: RouteDef;
  params: Record<string, string>;
  /** The concrete address of this page; the shell rewrites the hash to it when it differs. */
  path: string;
}

/**
 * The page to show for the address bar's hash: the matching page if this person may open it,
 * otherwise the first page they may open (so a forbidden or unknown address lands somewhere
 * useful). null only if the person may open nothing. A parameter is not checked here: a page
 * with a malformed one shows its own "not found".
 */
export function resolveRoute(hash: string, allowed: readonly RouteDef[]): ResolvedRoute | null {
  const path = pathFromHash(hash);
  const own = allowed.find((r) => r.path === path);
  if (own) return { page: own.id, route: own, params: {}, path: own.path };
  for (const candidate of PARAM_ROUTES) {
    const params = matchPath(candidate.pattern, path);
    const parent = allowed.find((r) => r.id === candidate.parent);
    if (params && parent) return { page: candidate.page, route: parent, params, path };
  }
  const first = allowed[0];
  return first ? { page: first.id, route: first, params: {}, path: first.path } : null;
}
