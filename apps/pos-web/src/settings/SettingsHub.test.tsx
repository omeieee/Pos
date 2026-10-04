// @vitest-environment jsdom
import { th, translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { SettingsHub } from './SettingsHub.tsx';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

async function open(role: StaffRole, ui: 'hub' | { section: string }) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({ auth });
  renderScreen(
    ui === 'hub' ? <SettingsHub /> : <SettingsSectionScreen section={ui.section} />,
    env.services,
  );
  return env;
}

const links = () =>
  screen.getAllByRole('link').map((a) => (a as HTMLAnchorElement).getAttribute('href'));

describe('the hub', () => {
  test('the owner sees the menu editor and every section, each linking to its own page', async () => {
    await open('owner', 'hub');
    expect(links()).toEqual([
      '#/settings/menu',
      '#/settings/shop',
      '#/settings/hours',
      '#/settings/numbering',
      '#/settings/delivery',
      '#/settings/payments',
      '#/settings/promptpay',
      '#/settings/gov-copay',
      '#/settings/devices',
      '#/settings/staff',
    ]);
    // Devices and staff say they ask to confirm first.
    expect(screen.getAllByText(th['settings.hub.needsConfirm']).length).toBe(2);
  });

  test('a manager has the menu and the shop settings, with PromptPay and the co-pay scheme marked view-only, and no devices or staff', async () => {
    await open('manager', 'hub');
    expect(links()).toEqual([
      '#/settings/menu',
      '#/settings/shop',
      '#/settings/hours',
      '#/settings/numbering',
      '#/settings/delivery',
      '#/settings/payments',
      '#/settings/promptpay',
      '#/settings/gov-copay',
    ]);
    const card = screen.getByText(th['settings.promptpay.title']).closest('a') as HTMLElement;
    expect(within(card).getByText(th['settings.hub.readOnly'])).toBeTruthy();
    const shop = screen.getByText(th['settings.shop.title']).closest('a') as HTMLElement;
    expect(within(shop).queryByText(th['settings.hub.readOnly'])).toBeNull();
  });

  test('a cashier sees the read-only sections and no menu link', async () => {
    await open('cashier', 'hub');
    expect(links()).not.toContain('#/settings/menu');
    expect(links()).not.toContain('#/settings/devices');
    expect(screen.getAllByText(th['settings.hub.readOnly']).length).toBe(7);
  });
});

describe('a section page', () => {
  test('a section the person may open shows its title and a way back to the hub', async () => {
    await open('manager', { section: 'shop' });
    expect(screen.getByRole('heading', { name: tr('settings.shop.title') })).toBeTruthy();
    expect(
      (screen.getByRole('link', { name: tr('settings.back') }) as HTMLAnchorElement).getAttribute(
        'href',
      ),
    ).toBe('#/settings');
  });

  test('a section the role may not open says not found and shows nothing of it', async () => {
    await open('manager', { section: 'staff' });
    expect(screen.getByText(tr('settings.notFound'))).toBeTruthy();
    expect(screen.queryByText(tr('settings.staff.desc'))).toBeNull();
  });

  test('"menu" is not a section: a role that cannot open the menu editor gets not found, never the editor', async () => {
    await open('cashier', { section: 'menu' });
    expect(screen.getByText(tr('settings.notFound'))).toBeTruthy();
    expect(screen.queryByText(tr('menuEditor.title'))).toBeNull();
  });

  test('an unknown name says not found', async () => {
    await open('owner', { section: 'nope' });
    expect(screen.getByText(tr('settings.notFound'))).toBeTruthy();
  });
});
