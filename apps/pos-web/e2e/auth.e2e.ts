import type { Page } from '@playwright/test';
import {
  expect,
  mainNav,
  OWNER_LOGIN,
  openAccount,
  STAFF,
  signInWithPin,
  tapPin,
  test,
  tr,
} from './support.ts';

async function expectSignedInAs(page: Page, role: 'owner' | 'manager' | 'cashier') {
  await expect(await openAccount(page)).toContainText(tr(`role.${role}`));
}

async function signOut(page: Page) {
  const menu = await openAccount(page);
  await menu.getByRole('button', { name: tr('shell.signOut') }).click();
}

test.describe('sign in', () => {
  test.describe('first run on an unregistered device', () => {
    test.use({ registered: false });

    test('the owner signs in, names the device and proves who they are again', async ({ page }) => {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { level: 1, name: tr('auth.register.title') }),
      ).toBeVisible();

      // Step 1: the owner's password and a code from the authenticator app.
      await page.getByLabel(tr('auth.owner.email'), { exact: true }).fill(OWNER_LOGIN.email);
      await page.getByLabel(tr('auth.owner.password'), { exact: true }).fill(OWNER_LOGIN.password);
      await page.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
      await page.getByRole('button', { name: tr('auth.owner.submit'), exact: true }).click();

      // Step 2: name the device. Registering is sensitive, so the step-up dialog follows.
      await expect(
        page.getByText(tr('auth.register.signedInAs', { name: STAFF.owner.name })),
      ).toBeVisible();
      await page
        .getByLabel(tr('auth.register.nameLabel'), { exact: true })
        .fill('iPad เคาน์เตอร์ (ทดสอบ)');
      await page.getByRole('button', { name: tr('auth.register.submit') }).click();
      const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
      await expect(stepUp).toBeVisible();
      await stepUp
        .getByLabel(tr('auth.owner.password'), { exact: true })
        .fill(OWNER_LOGIN.password);
      await stepUp.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[1]);
      await stepUp.getByRole('button', { name: tr('auth.stepUp.submit') }).click();

      // The device is registered and the owner is in, on a device with its name.
      await expect(mainNav(page)).toBeVisible();
      await expectSignedInAs(page, 'owner');
      await expect(
        page.getByText(tr('shell.device', { name: 'iPad เคาน์เตอร์ (ทดสอบ)' })),
      ).toBeVisible();

      // From now on the device shows the staff tiles for PIN sign-in.
      await signOut(page);
      await expect(
        page.getByRole('heading', { level: 1, name: tr('auth.pin.title') }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: new RegExp(STAFF.cashier.name) }),
      ).toBeVisible();
    });

    test('a wrong password says so without saying which part was wrong', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel(tr('auth.owner.email'), { exact: true }).fill(OWNER_LOGIN.email);
      await page.getByLabel(tr('auth.owner.password'), { exact: true }).fill('wrong-password');
      await page.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
      await page.getByRole('button', { name: tr('auth.owner.submit'), exact: true }).click();
      await expect(page.getByRole('alert')).toContainText(tr('auth.owner.failed'));
    });
  });

  test('staff sign in with a PIN: a 6-digit PIN by itself, a 4-digit PIN with OK', async ({
    page,
  }) => {
    await page.goto('/');
    // Manager: 6 digits, no button needed.
    await page.getByRole('button', { name: new RegExp(STAFF.manager.name) }).click();
    await tapPin(page, STAFF.manager.pin);
    await expect(mainNav(page)).toBeVisible();
    await expectSignedInAs(page, 'manager');
    await expect(await openAccount(page)).toContainText(STAFF.manager.name);

    // Sign out returns to the tiles; the cashier's 4-digit PIN needs OK.
    await signOut(page);
    await page.getByRole('button', { name: new RegExp(STAFF.cashier.name) }).click();
    await tapPin(page, STAFF.cashier.pin);
    await expect(mainNav(page)).toBeVisible();
    await expectSignedInAs(page, 'cashier');
  });

  test('a wrong PIN is refused and the pad clears', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: new RegExp(STAFF.cashier.name) }).click();
    await tapPin(page, '9999');
    await expect(page.getByRole('alert')).toContainText(tr('auth.pin.wrong'));
    await expect(mainNav(page)).toHaveCount(0);
    await expect(
      page.getByRole('img', { name: tr('auth.pin.progress', { count: 0 }) }),
    ).toBeVisible();
  });

  test('the owner can sign in with the password on a registered device', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: tr('auth.pin.ownerLink') }).click();
    await page.getByLabel(tr('auth.owner.email'), { exact: true }).fill(OWNER_LOGIN.email);
    await page.getByLabel(tr('auth.owner.password'), { exact: true }).fill(OWNER_LOGIN.password);
    await page.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
    await page.getByRole('button', { name: tr('auth.owner.submit'), exact: true }).click();
    await expect(mainNav(page)).toBeVisible();
    await expectSignedInAs(page, 'owner');
  });

  test('a signed-out device shows no orders and no navigation', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await signOut(page);
    await expect(page.getByRole('heading', { level: 1, name: tr('auth.pin.title') })).toBeVisible();
    await expect(mainNav(page)).toHaveCount(0);
    await expect(page.locator('button.g-tile')).toHaveCount(0);
  });
});
