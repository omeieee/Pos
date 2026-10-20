// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore } from '../lib/store.ts';
import type { Services } from '../services.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { Shell } from './Shell.tsx';

const th = catalogs.th;

beforeEach(() => {
  // A laptop: the back-office sidebar is the navigation.
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  window.location.hash = '#/settings';
});
afterEach(cleanup);

async function open(role: StaffRole) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({ auth });
  // The shell shows the app-update banner, which reads the service-worker store.
  const updates = { ...createStore({ needRefresh: false }), apply: vi.fn() };
  renderScreen(<Shell />, { ...env.services, updates } as unknown as Services);
  return env;
}

const sidebarLinks = () =>
  screen
    .getAllByRole('link')
    .map((a) => (a as HTMLAnchorElement).getAttribute('href'))
    .filter((href) => href !== null);

describe('the sidebar entries of the money pages', () => {
  test('the owner has expenses, cost and profit, and tax, as links and no longer as "not ready" rows', async () => {
    await open('owner');
    expect(sidebarLinks()).toEqual(
      expect.arrayContaining(['#/expenses', '#/pnl', '#/tax', '#/cash']),
    );
    expect(screen.getByRole('link', { name: th['nav.expenses'] })).toBeTruthy();
    expect(screen.getByRole('link', { name: th['nav.costProfit'] })).toBeTruthy();
    expect(screen.getByRole('link', { name: th['nav.tax'] })).toBeTruthy();
    expect(screen.getByRole('link', { name: th['nav.cash'] })).toBeTruthy();
  });

  test('a manager has expenses only: no profit, no tax', async () => {
    await open('manager');
    expect(sidebarLinks()).toContain('#/expenses');
    expect(sidebarLinks()).not.toContain('#/pnl');
    expect(sidebarLinks()).not.toContain('#/tax');
    expect(sidebarLinks()).not.toContain('#/cash');
    expect(screen.queryByRole('link', { name: th['nav.costProfit'] })).toBeNull();
  });

  test('a cashier has none of them', async () => {
    await open('cashier');
    for (const href of ['#/expenses', '#/pnl', '#/tax', '#/cash']) {
      expect(sidebarLinks()).not.toContain(href);
    }
  });
});
