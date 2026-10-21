import type { Page } from '@playwright/test';
import { expect, openPage, STAFF, signInWithPin, test, tr } from './support.ts';

/**
 * Phone alerts (P8, Web Push): the on/off switch of this device. The browser's push is the dev
 * mock's fake (src/dev/fake-push.ts) and the server's routes are the mock's: nothing is ever
 * delivered here. Real delivery, and the iPhone/iPad Home Screen rules, need a real device.
 */

interface PushSetup {
  availability?: 'available' | 'needs-install' | 'unsupported';
  permission?: 'default' | 'granted' | 'denied';
  prompt?: 'default' | 'granted' | 'denied';
  configured?: boolean;
}

/** What the fake browser and the mock server are like on the next load (kept for this tab). */
const setUp = (page: Page, setup: PushSetup) =>
  page.addInitScript(
    (value) => sessionStorage.setItem('sds-mock-push', JSON.stringify(value)),
    setup,
  );

const alertsLink = (page: Page) => page.locator('main a[href="#/alerts"]');
const heading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: tr('push.title'), exact: true });
const noSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function openFromSettings(page: Page) {
  await openPage(page, '/settings');
  await alertsLink(page).click();
  await expect(heading(page)).toBeVisible();
}

test.describe('phone alerts (P8)', () => {
  test('a cashier turns alerts on from Settings, then off, and nothing scrolls sideways', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    const switchBox = page.getByRole('checkbox', { name: tr('push.switch') });
    await expect(switchBox).not.toBeChecked();
    await expect(page.getByText(tr('push.state.off'))).toBeVisible();
    expect(await noSideways(page)).toBe(true);

    // The permission prompt comes from this tap, not from opening the page.
    await switchBox.click();
    await expect(page.getByText(tr('push.state.on'))).toBeVisible();
    await expect(switchBox).toBeChecked();
    expect(await noSideways(page)).toBe(true);

    await switchBox.click();
    await expect(page.getByText(tr('push.state.off'))).toBeVisible();
    await expect(switchBox).not.toBeChecked();
  });

  test('the choice is read back from the server when the page is opened again', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await openFromSettings(page);
    await page.getByRole('checkbox', { name: tr('push.switch') }).click();
    await expect(page.getByText(tr('push.state.on'))).toBeVisible();
    // Away and back (no reload: the mock lives in the page).
    await openPage(page, '/orders');
    await openPage(page, '/settings');
    await alertsLink(page).click();
    await expect(page.getByRole('checkbox', { name: tr('push.switch') })).toBeChecked();
  });

  test('the kitchen role has no Settings but reaches the page from its account menu', async ({
    page,
  }) => {
    await signInWithPin(page, 'kitchen');
    const person = STAFF.kitchen;
    await page.getByRole('button', { name: `${person.name} · ${tr('role.kitchen')}` }).click();
    await page.getByRole('link', { name: tr('push.title') }).click();
    await expect(heading(page)).toBeVisible();
    // The way back is the orders page, as there is no Settings for this role.
    await expect(page.getByRole('link', { name: tr('push.back') })).toHaveAttribute(
      'href',
      '#/orders',
    );
    await page.getByRole('checkbox', { name: tr('push.switch') }).click();
    await expect(page.getByText(tr('push.state.on'))).toBeVisible();
  });

  test('the server is not set up: plain words and no switch', async ({ page }) => {
    await setUp(page, { configured: false });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await expect(page.getByText(tr('push.notConfigured'))).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  test('an iPhone or iPad in a Safari tab is told how to add the app to the Home Screen', async ({
    page,
  }) => {
    await setUp(page, { availability: 'needs-install' });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await expect(page.getByText(tr('push.needsInstall.title'))).toBeVisible();
    await expect(page.getByText(tr('push.needsInstall.step3'))).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });

  test('a browser without push says so', async ({ page }) => {
    await setUp(page, { availability: 'unsupported' });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await expect(page.getByText(tr('push.unsupported'))).toBeVisible();
  });

  test('a blocked permission explains how to allow it', async ({ page }) => {
    await setUp(page, { permission: 'denied' });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await expect(page.getByText(tr('push.denied.title'))).toBeVisible();
    await expect(page.getByText(tr('push.denied.body'))).toBeVisible();
    await expect(page.getByRole('button', { name: tr('push.denied.recheck') })).toBeVisible();
  });

  test('closing the permission prompt leaves it off, with a hint to try again', async ({
    page,
  }) => {
    await setUp(page, { prompt: 'default' });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await page.getByRole('checkbox', { name: tr('push.switch') }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: tr('push.error.dismissed') }),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: tr('push.switch') })).not.toBeChecked();
  });

  test('blocking the prompt switches to the blocked explanation', async ({ page }) => {
    await setUp(page, { prompt: 'denied' });
    await signInWithPin(page, 'cashier');
    await openFromSettings(page);
    await page.getByRole('checkbox', { name: tr('push.switch') }).click();
    await expect(page.getByText(tr('push.denied.title'))).toBeVisible();
  });
});
