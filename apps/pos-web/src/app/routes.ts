/**
 * The staff app's top-level pages and who may open them. The permission names come from
 * `@sds/shared` and the list of permissions a person has comes from their session, so the
 * role-to-permission table is not copied here. Hiding a page is a convenience: the API checks
 * every call.
 */
import type { MessageKey } from '@sds/i18n';
import type { Permission } from '@sds/shared';

export type IconName = 'list' | 'bowl' | 'gear' | 'door' | 'back' | 'backspace' | 'alert' | 'user';

export type RouteId = 'orders' | 'menu' | 'settings';

export interface RouteDef {
  id: RouteId;
  path: string;
  labelKey: MessageKey;
  icon: IconName;
  /** null: any signed-in person (the kitchen needs the order queue). */
  permission: Permission | null;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'orders', path: '/orders', labelKey: 'nav.orders', icon: 'list', permission: null },
  { id: 'menu', path: '/menu', labelKey: 'nav.menu', icon: 'bowl', permission: 'menu.edit' },
  {
    id: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    icon: 'gear',
    permission: 'settings.edit',
  },
];

export function allowedRoutes(permissions: readonly Permission[]): RouteDef[] {
  return ROUTES.filter((r) => r.permission === null || permissions.includes(r.permission));
}

/** `#/menu` -> `/menu`; anything else -> ''. */
export function pathFromHash(hash: string): string {
  const match = /^#(\/[a-z-]*)/.exec(hash);
  return match?.[1] ?? '';
}

/**
 * The page to show for the address bar's hash: the matching page if this person may open it,
 * otherwise the first page they may open (so a forbidden or unknown address lands somewhere
 * useful). null only if the person may open nothing.
 */
export function resolveRoute(hash: string, allowed: readonly RouteDef[]): RouteDef | null {
  const path = pathFromHash(hash);
  return allowed.find((r) => r.path === path) ?? allowed[0] ?? null;
}
