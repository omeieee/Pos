import { hasPermission, PERMISSIONS } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { allowedRoutes, matchPath, pathFromHash, ROUTES, resolveRoute } from './routes.ts';

const permissionsOf = (role: Parameters<typeof hasPermission>[0]) =>
  PERMISSIONS.filter((p) => hasPermission(role, p));

const ids = (role: Parameters<typeof hasPermission>[0]) =>
  allowedRoutes(permissionsOf(role)).map((r) => r.id);

describe('who may open what (from the shared role permissions)', () => {
  test('owner and manager see everything', () => {
    expect(ids('owner')).toEqual(['new', 'platform', 'kitchen', 'orders', 'menu', 'settings']);
    expect(ids('manager')).toEqual(['new', 'platform', 'kitchen', 'orders', 'menu', 'settings']);
  });

  test('the cashier takes orders, sees the queue and may look at settings; the kitchen sees the kitchen view and the queue only', () => {
    expect(ids('cashier')).toEqual(['new', 'platform', 'kitchen', 'orders', 'settings']);
    expect(ids('kitchen')).toEqual(['kitchen', 'orders']);
  });

  test('the kitchen view is for whoever may move an order along (order.advance), nobody else', () => {
    const route = ROUTES.find((r) => r.id === 'kitchen');
    expect(route?.permission).toBe('order.advance');
    expect(allowedRoutes([]).map((r) => r.id)).toEqual(['orders']);
  });

  test('every page has a path, a label key and an icon', () => {
    for (const route of ROUTES) {
      // The menu editor sits under Settings in the address.
      expect(route.path).toBe(route.id === 'menu' ? '/settings/menu' : `/${route.id}`);
      expect(route.labelKey.startsWith('nav.')).toBe(true);
    }
  });
});

describe('resolving the address', () => {
  const owner = allowedRoutes(permissionsOf('owner'));
  const cashier = allowedRoutes(permissionsOf('cashier'));
  const kitchen = allowedRoutes(permissionsOf('kitchen'));

  test('reads the hash path', () => {
    expect(pathFromHash('#/settings/menu')).toBe('/settings/menu');
    expect(pathFromHash('#/settings/menu?x=1')).toBe('/settings/menu');
    expect(pathFromHash('')).toBe('');
    expect(pathFromHash('#nothing')).toBe('');
  });

  test('opens the matching page when it is allowed', () => {
    expect(resolveRoute('#/settings', owner)?.page).toBe('settings');
    expect(resolveRoute('#/settings/menu', owner)?.page).toBe('menu');
    expect(resolveRoute('#/new', cashier)?.page).toBe('new');
  });

  test('a page the role may not open lands on the first allowed page', () => {
    expect(resolveRoute('#/settings', kitchen)?.page).toBe('kitchen');
    expect(resolveRoute('#/settings/shop', kitchen)?.page).toBe('kitchen');
    expect(resolveRoute('#/new', kitchen)?.page).toBe('kitchen');
  });

  test('a settings section opens inside the settings page, with its name as a parameter', () => {
    const resolved = resolveRoute('#/settings/shop', cashier);
    expect(resolved).toMatchObject({
      page: 'settingsSection',
      params: { section: 'shop' },
      path: '/settings/shop',
    });
    expect(resolved?.route.id).toBe('settings');
  });

  test('/settings/menu is the menu editor only for a role that may edit the menu; others get the settings section page, which says "not found" and never renders the editor', () => {
    expect(resolveRoute('#/settings/menu', owner)?.page).toBe('menu');
    const cashierMenu = resolveRoute('#/settings/menu', cashier);
    expect(cashierMenu?.page).toBe('settingsSection');
    expect(cashierMenu?.params.section).toBe('menu');
  });

  test('the kitchen role lands on the kitchen view, and the cashier on the new order page', () => {
    expect(resolveRoute('', kitchen)?.path).toBe('/kitchen');
    expect(resolveRoute('#/settings', kitchen)?.path).toBe('/kitchen');
    expect(resolveRoute('', cashier)?.path).toBe('/new');
  });
  test('an address the role may open is kept, so a deep link or a reload stays where it was', () => {
    expect(resolveRoute('#/orders', kitchen)?.page).toBe('orders');
    expect(resolveRoute('#/kitchen', cashier)?.page).toBe('kitchen');
  });

  test('an unknown or empty address lands on the first allowed page', () => {
    expect(resolveRoute('', owner)?.page).toBe('new');
    expect(resolveRoute('#/nope', owner)?.page).toBe('new');
    expect(resolveRoute('#/nope', kitchen)?.path).toBe('/kitchen');
  });

  test('nothing allowed means nothing to show', () => {
    expect(resolveRoute('#/orders', [])).toBeNull();
  });
});

const ORDER_ID = '9e8d7c6b-5a49-4837-a625-140312ffeedd';

describe('parameterised addresses', () => {
  const cashier = allowedRoutes(permissionsOf('cashier'));
  const kitchen = allowedRoutes(permissionsOf('kitchen'));

  test('matchPath binds :name segments and nothing else', () => {
    expect(matchPath('/orders/:id', '/orders/abc-1')).toEqual({ id: 'abc-1' });
    expect(matchPath('/orders/:id', '/orders')).toBeNull();
    expect(matchPath('/orders/:id', '/orders/abc/extra')).toBeNull();
    expect(matchPath('/orders/:id', '/menu/abc')).toBeNull();
    expect(matchPath('/menu', '/menu')).toEqual({});
  });

  test('reads a multi-segment hash path and drops the query', () => {
    expect(pathFromHash(`#/orders/${ORDER_ID}`)).toBe(`/orders/${ORDER_ID}`);
    expect(pathFromHash(`#/orders/${ORDER_ID}?x=1`)).toBe(`/orders/${ORDER_ID}`);
    expect(pathFromHash('#/orders/')).toBe('/orders');
  });

  test('#/orders/:id resolves to the order page with its id and keeps its own address', () => {
    for (const allowed of [cashier, kitchen]) {
      const resolved = resolveRoute(`#/orders/${ORDER_ID}`, allowed);
      expect(resolved).toMatchObject({
        page: 'order',
        params: { id: ORDER_ID },
        path: `/orders/${ORDER_ID}`,
      });
      // The orders entry stays highlighted in the navigation.
      expect(resolved?.route.id).toBe('orders');
    }
  });

  test('an order address needs the orders page to be allowed', () => {
    expect(resolveRoute(`#/orders/${ORDER_ID}`, [])).toBeNull();
  });

  test('a malformed id still resolves to the order page: that screen shows "not found"', () => {
    expect(resolveRoute('#/orders/not-a-uuid', cashier)?.page).toBe('order');
  });

  test('a deeper or odd address falls back to the first allowed page', () => {
    expect(resolveRoute(`#/orders/${ORDER_ID}/extra`, cashier)?.page).toBe('new');
    expect(resolveRoute('#/orders/%00', cashier)?.page).toBe('new');
  });
});
