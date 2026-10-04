import type { Locator, Page } from '@playwright/test';
import { expect, OWNER_LOGIN, openPage, signInWithPin, test, tr } from './support.ts';

/** The dev mock's invite (made up): `pnpm dev` with `VITE_MOCK_API=1` starts with it open. */
const DEMO_TOKEN = 'mock-invite-demo';
/** The one authenticator code the mock's invite accept takes. */
const MOCK_CODE = '123456';
const PASSWORD = 'a long enough made-up password';

const sectionLink = (page: Page, id: string) => page.locator(`main a[href="#/settings/${id}"]`);

/** A role card: the radio inside is visually hidden, so the card is what a finger taps. */
const chip = (scope: Locator, key: 'role.owner' | 'role.manager' | 'role.kitchen') =>
  scope
    .locator('label.gset-role')
    .filter({ has: scope.page().getByText(tr(key), { exact: true }) });

/** The owner opens the staff screen and answers the step-up it asks for. */
async function openStaff(page: Page) {
  await signInWithPin(page, 'owner');
  await openPage(page, '/settings');
  await sectionLink(page, 'staff').click();
  const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(tr('auth.owner.password'), { exact: true }).fill(OWNER_LOGIN.password);
  await stepUp.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
  await stepUp.getByRole('button', { name: tr('auth.stepUp.submit') }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: tr('settings.staff.invite') })).toBeVisible();
}

test.describe('inviting people and changing roles (D-23)', () => {
  test('the owner invites by e-mail, copies the link once, sees and cancels the open invite', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await openStaff(page);
    await page.getByRole('button', { name: tr('settings.staff.invite') }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel(tr('settings.staff.inviteEmail'), { exact: true })
      .fill('nok@example.test');
    await chip(dialog, 'role.owner').click();
    // The owner role is clearly warned about; the explanation follows the chosen role.
    await expect(dialog).toContainText(tr('settings.staff.ownerWarn'));
    await chip(dialog, 'role.manager').click();
    await expect(dialog).toContainText(tr('settings.staff.roleDesc.manager'));
    await dialog.getByRole('button', { name: tr('settings.staff.inviteCreate') }).click();

    // The link is shown once, with the token in the fragment and the 72-hour note.
    const link = dialog.getByTestId('invite-link');
    await expect(link).toHaveText(/\/invite#mock-invite-/);
    await expect(dialog).toContainText(tr('settings.staff.linkNote'));
    const value = (await link.textContent()) ?? '';
    await dialog.getByRole('button', { name: tr('settings.staff.linkCopy') }).click();
    await expect(
      dialog
        .getByText(tr('settings.staff.linkCopied'))
        .or(dialog.getByText(tr('settings.staff.linkCopyFailed'))),
    ).toBeVisible();
    await dialog.getByRole('button', { name: tr('settings.staff.linkDone') }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Gone from the page for good; the list shows the invite with its expiry and a way to cancel.
    const token = value.split('#')[1] ?? '';
    expect(await page.content()).not.toContain(token);
    const row = page.locator('li', { hasText: 'nok@example.test' });
    await expect(row).toContainText(tr('role.manager'));
    await row
      .getByRole('button', {
        name: tr('settings.staff.invites.revokeLabel', { email: 'nok@example.test' }),
      })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('settings.staff.invites.revoke') })
      .click();
    await expect(page.locator('li', { hasText: 'nok@example.test' })).toHaveCount(0);
  });

  test('a role change asks for a PIN only when the new role needs one; your own row is locked', async ({
    page,
  }) => {
    await openStaff(page);
    // Your own account cannot be changed here, and the page says why.
    await expect(page.getByText(tr('settings.staff.selfNote'))).toBeVisible();
    const cashier = 'พนักงานตัวอย่าง';
    await page
      .getByRole('button', { name: tr('settings.staff.changeRoleLabel', { name: cashier }) })
      .click();
    const dialog = page.getByRole('dialog');
    await chip(dialog, 'role.kitchen').click();
    await expect(dialog.getByLabel(tr('settings.staff.changeRolePin'))).toHaveCount(0);
    await chip(dialog, 'role.manager').click();
    await dialog.getByLabel(tr('settings.staff.changeRolePin'), { exact: true }).fill('246810');
    await dialog.getByLabel(tr('settings.staff.pin2'), { exact: true }).fill('246810');
    await dialog.getByRole('button', { name: tr('common.save') }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(tr('settings.staff.changeRoleDone'))).toBeVisible();
    await expect(page.locator('li', { hasText: cashier })).toContainText(tr('role.manager'));
  });
});

test.describe('the invite page (no session)', () => {
  test('opens from the link, takes the token out of the address bar, and sets the account up', async ({
    page,
  }) => {
    const writes: string[] = [];
    await page.exposeFunction('noteWrite', (what: string) => writes.push(what));
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        (window as unknown as { noteWrite: (s: string) => void }).noteWrite(`${key}=${value}`);
        return original.call(this, key, value);
      };
    });
    await page.goto(`/invite#${DEMO_TOKEN}`);
    await expect(page.getByLabel(tr('invite.password'), { exact: true })).toBeVisible();
    // The token left the address bar at once, and the page has no way to ask for it again.
    expect(page.url()).not.toContain(DEMO_TOKEN);
    expect(new URL(page.url()).hash).toBe('');
    expect(new URL(page.url()).pathname).toBe('/invite');

    await expect(page.getByText(tr('invite.youAre', { role: tr('role.manager') }))).toBeVisible();
    await expect(page.getByLabel(tr('invite.email'), { exact: true })).toHaveValue(
      'invited@example.test',
    );
    // The QR is drawn on the page and the key is there as text for manual entry.
    await expect(page.getByRole('img', { name: tr('invite.totp.qrLabel') })).toBeVisible();
    await expect(page.getByTestId('totp-secret')).toHaveText(/^[A-Z2-7]{16}$/);

    await page.getByLabel(tr('invite.name'), { exact: true }).fill('น้องนก');
    await page.getByLabel(tr('invite.password'), { exact: true }).fill(PASSWORD);
    // A manager needs all 6 digits.
    await expect(page.getByText(tr('invite.pinHint.6'))).toBeVisible();
    await page.getByLabel(tr('invite.pin'), { exact: true }).fill('246810');
    await page.getByLabel(tr('invite.pin2'), { exact: true }).fill('246810');
    await page.getByLabel(tr('invite.code'), { exact: true }).fill('000000');
    await page.getByRole('button', { name: tr('invite.submit') }).click();
    // A wrong code keeps the form and says so; only the code is cleared.
    await expect(page.getByText(tr('error.inviteCodeInvalid'))).toBeVisible();
    await expect(page.getByLabel(tr('invite.code'), { exact: true })).toHaveValue('');
    await expect(page.getByLabel(tr('invite.name'), { exact: true })).toHaveValue('น้องนก');

    await page.getByLabel(tr('invite.code'), { exact: true }).fill(MOCK_CODE);
    await page.getByRole('button', { name: tr('invite.submit') }).click();
    await expect(page.getByRole('heading', { name: tr('invite.done.title') })).toBeVisible();
    await expect(
      page.getByRole('list', { name: tr('invite.done.codesTitle') }).getByRole('listitem'),
    ).toHaveCount(8);
    await expect(page.getByText(tr('invite.done.firstSignIn'))).toBeVisible();
    // The way on opens once the person says the codes are saved.
    await expect(page.getByRole('button', { name: tr('invite.done.signIn') })).toBeDisabled();
    await page.getByLabel(tr('invite.done.saved')).check();
    await expect(page.getByRole('link', { name: tr('invite.done.signIn') })).toHaveAttribute(
      'href',
      '/',
    );

    // Nothing of the invite was written to storage (the device key is the test's own).
    expect(writes.filter((w) => w.includes(DEMO_TOKEN) || w.includes(PASSWORD))).toEqual([]);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(DEMO_TOKEN);
    expect(await page.content()).not.toContain(DEMO_TOKEN);
  });

  test('a link that is wrong, used or reopened after the token was removed shows one generic message', async ({
    page,
  }) => {
    await page.goto('/invite#not-a-real-token');
    await expect(page.getByText(tr('error.inviteInvalid'))).toBeVisible();
    await expect(page.getByLabel(tr('invite.password'), { exact: true })).toHaveCount(0);
    expect(page.url()).not.toContain('not-a-real-token');
    // A reload has no token any more: the same generic message, not an error.
    await page.reload();
    await expect(page.getByText(tr('error.inviteInvalid'))).toBeVisible();
    await expect(page.getByText(tr('invite.invalidHelp'))).toBeVisible();
  });
});
