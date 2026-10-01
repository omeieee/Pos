import { hasPermission, PERMISSIONS } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { allowedRoutes, pathFromHash, ROUTES, resolveRoute } from './routes.ts';

const permissionsOf = (role: Parameters<typeof hasPermission>[0]) =>
  PERMISSIONS.filter((p) => hasPermission(role, p));

const ids = (role: Parameters<typeof hasPermission>[0]) =>
  allowedRoutes(permissionsOf(role)).map((r) => r.id);

describe('who may open what (from the shared role permissions)', () => {
  test('owner and manager see everything', () => {
    expect(ids('owner')).toEqual(['orders', 'menu', 'settings']);
    expect(ids('manager')).toEqual(['orders', 'menu', 'settings']);
  });

  test('cashier and kitchen see the order pages only', () => {
    expect(ids('cashier')).toEqual(['orders']);
    expect(ids('kitchen')).toEqual(['orders']);
  });

  test('every page has a path, a label key and an icon', () => {
    for (const route of ROUTES) {
      expect(route.path).toBe(`/${route.id}`);
      expect(route.labelKey.startsWith('nav.')).toBe(true);
    }
  });
});

describe('resolving the address', () => {
  const owner = allowedRoutes(permissionsOf('owner'));
  const cashier = allowedRoutes(permissionsOf('cashier'));

  test('reads the hash path', () => {
    expect(pathFromHash('#/menu')).toBe('/menu');
    expect(pathFromHash('#/menu?x=1')).toBe('/menu');
    expect(pathFromHash('')).toBe('');
    expect(pathFromHash('#nothing')).toBe('');
  });

  test('opens the matching page when it is allowed', () => {
    expect(resolveRoute('#/settings', owner)?.id).toBe('settings');
    expect(resolveRoute('#/menu', owner)?.id).toBe('menu');
  });

  test('a page the role may not open lands on the first allowed page', () => {
    expect(resolveRoute('#/settings', cashier)?.id).toBe('orders');
    expect(resolveRoute('#/menu', cashier)?.id).toBe('orders');
  });

  test('an unknown or empty address lands on the first allowed page', () => {
    expect(resolveRoute('', owner)?.id).toBe('orders');
    expect(resolveRoute('#/nope', owner)?.id).toBe('orders');
  });

  test('nothing allowed means nothing to show', () => {
    expect(resolveRoute('#/orders', [])).toBeNull();
  });
});
