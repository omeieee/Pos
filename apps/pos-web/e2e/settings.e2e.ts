import {
  expect,
  MOCK_PROMPTPAY,
  OWNER_LOGIN,
  openPage,
  paymentPanel,
  ringOrder,
  STAFF,
  signInWithPin,
  tapPin,
  test,
  tr,
} from './support.ts';

const NEW_PROMPTPAY = '0899990000'; // made up, like the mock's own
const NEW_MASKED = '******0000';

const sectionLink = (page: import('@playwright/test').Page, id: string) =>
  page.locator(`main a[href="#/settings/${id}"]`);

/** Everything a person could read or copy off the page: text, inputs and the markup. */
async function pageShows(page: import('@playwright/test').Page, digits: string) {
  const text = await page.locator('body').innerText();
  const inputs = await page
    .locator('input, textarea')
    .evaluateAll((all) => all.map((element) => (element as HTMLInputElement).value));
  const html = await page.content();
  return (
    text.includes(digits) || inputs.some((value) => value.includes(digits)) || html.includes(digits)
  );
}

test.describe('settings hub and permissions (R, P3)', () => {
  test('a cashier reads settings but cannot change anything or open the owner-only sections', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await openPage(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: tr('settings.title') })).toBeVisible();
    // Read-only sections are marked as such.
    for (const id of [
      'shop',
      'hours',
      'numbering',
      'payments',
      'delivery',
      'promptpay',
      'gov-copay',
    ]) {
      await expect(sectionLink(page, id)).toContainText(tr('settings.hub.readOnly'));
    }
    // Staff, devices and the menu editor are not offered at all.
    for (const id of ['staff', 'devices', 'menu']) {
      await expect(sectionLink(page, id)).toHaveCount(0);
    }
    // A section opens read-only: no save, no inputs to change.
    await sectionLink(page, 'shop').click();
    await expect(
      page.getByRole('heading', { level: 1, name: tr('settings.shop.title') }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: tr('common.save'), exact: true })).toHaveCount(0);
    // The PromptPay section shows the masked account and no change button.
    await openPage(page, '/settings');
    await sectionLink(page, 'promptpay').click();
    await expect(page.locator('main')).toContainText(MOCK_PROMPTPAY.masked);
    await expect(page.getByRole('button', { name: tr('settings.promptpay.change') })).toHaveCount(
      0,
    );
    expect(await pageShows(page, MOCK_PROMPTPAY.id)).toBe(false);
  });

  test('a manager can edit shop settings but not the PromptPay account', async ({ page }) => {
    await signInWithPin(page, 'manager');
    await openPage(page, '/settings');
    await expect(sectionLink(page, 'shop')).not.toContainText(tr('settings.hub.readOnly'));
    await expect(sectionLink(page, 'promptpay')).toContainText(tr('settings.hub.readOnly'));
    await expect(sectionLink(page, 'staff')).toHaveCount(0);
    await sectionLink(page, 'promptpay').click();
    await expect(page.getByRole('button', { name: tr('settings.promptpay.change') })).toHaveCount(
      0,
    );
  });

  test('a kitchen role has no settings at all', async ({ page }) => {
    // The kitchen role lands on the dark kitchen page, which has no navigation at all, so it is
    // enough that the settings address shows nothing of settings to it.
    await page.goto('/');
    await page.getByRole('button', { name: new RegExp(STAFF.kitchen.name) }).click();
    await tapPin(page, STAFF.kitchen.pin);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await expect(page.getByRole('heading', { level: 1, name: tr('settings.title') })).toHaveCount(
      0,
    );
    await expect(page.locator('main a[href="#/settings/shop"]')).toHaveCount(0);
  });
});

test.describe('changing the PromptPay ID (rule 3)', () => {
  test('the owner changes it with step-up; only the masked value is ever shown, and the QR follows', async ({
    page,
  }) => {
    await signInWithPin(page, 'owner');
    await openPage(page, '/settings');
    await sectionLink(page, 'promptpay').click();
    await expect(page.locator('main')).toContainText(MOCK_PROMPTPAY.masked);

    await page.getByRole('button', { name: tr('settings.promptpay.change') }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel(tr('settings.promptpay.dialog.value'), { exact: true })
      .fill(NEW_PROMPTPAY);
    await dialog.getByRole('button', { name: tr('settings.promptpay.dialog.review') }).click();

    // Review step: old and new accounts masked, and the typed number is gone from the page.
    await expect(dialog).toContainText(
      tr('settings.promptpay.dialog.newAccount', { masked: NEW_MASKED }),
    );
    await expect(dialog).toContainText(
      tr('settings.promptpay.dialog.oldAccount', { masked: MOCK_PROMPTPAY.masked }),
    );
    expect(await pageShows(page, NEW_PROMPTPAY)).toBe(false);

    // Confirming asks the owner to prove who they are again; a wrong password changes nothing.
    await dialog.getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }).click();
    const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
    await expect(stepUp).toBeVisible();
    await stepUp.getByLabel(tr('auth.owner.password'), { exact: true }).fill('not-the-password');
    await stepUp.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
    await stepUp.getByRole('button', { name: tr('auth.stepUp.submit') }).click();
    await expect(stepUp.getByRole('alert')).not.toBeEmpty();
    await expect(stepUp).toBeVisible();

    // The right password and a fresh code.
    await stepUp.getByLabel(tr('auth.owner.password'), { exact: true }).fill(OWNER_LOGIN.password);
    await stepUp.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[1]);
    await stepUp.getByRole('button', { name: tr('auth.stepUp.submit') }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Only the masked account is shown, nowhere the full number.
    await expect(page.locator('main')).toContainText(NEW_MASKED);
    await expect(page.locator('main')).not.toContainText(MOCK_PROMPTPAY.masked);
    expect(await pageShows(page, NEW_PROMPTPAY)).toBe(false);
    expect(await pageShows(page, MOCK_PROMPTPAY.id)).toBe(false);

    // The next PromptPay QR pays the new account (masked target on the screen).
    await openPage(page, '/new');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await panel.locator('label.g-chip', { hasText: tr('payment.method.promptpay') }).click();
    await panel.getByRole('button', { name: tr('payment.start.promptpay') }).click();
    await expect(panel).toContainText(tr('payment.promptpay.target', { target: NEW_MASKED }));
    expect(await pageShows(page, NEW_PROMPTPAY)).toBe(false);
  });

  test('cancelling the step-up leaves the account as it was', async ({ page }) => {
    await signInWithPin(page, 'owner');
    await openPage(page, '/settings');
    await sectionLink(page, 'promptpay').click();
    await page.getByRole('button', { name: tr('settings.promptpay.change') }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel(tr('settings.promptpay.dialog.value'), { exact: true })
      .fill(NEW_PROMPTPAY);
    await dialog.getByRole('button', { name: tr('settings.promptpay.dialog.review') }).click();
    await dialog.getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }).click();
    const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
    await stepUp.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(stepUp).toHaveCount(0);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('common.close') })
      .click();
    await expect(page.locator('main')).toContainText(MOCK_PROMPTPAY.masked);
    await expect(page.locator('main')).not.toContainText(NEW_MASKED);
  });
});
