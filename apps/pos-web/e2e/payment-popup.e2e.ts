import type { Page } from '@playwright/test';
import { expect, mainNav, openPage, signInWithPin, test, tr } from './support.ts';

/**
 * The payment pop-up (D-42). The dev mock plays the server: `__sdsMock.paymentAlert(kind)` sends the
 * live `alert.payment` frame (with a new LINE order for it to show). The mock lives in the page, so
 * a reload is a new mock: that is how "a restart shows nothing" is tried.
 */

type Kind = 'paid' | 'slip_review';

async function alertPayment(page: Page, kind: Kind): Promise<string> {
  return page.evaluate(
    (k) =>
      (
        globalThis as unknown as { __sdsMock: { paymentAlert(kind: Kind): string } }
      ).__sdsMock.paymentAlert(k),
    kind,
  );
}

const popup = (page: Page, kind: Kind) =>
  page.getByRole('dialog', { name: tr(`payPopup.title.${kind}`) });
const anyPopup = (page: Page) => page.getByTestId('payment-popup');

test.describe('payment pop-up (D-42)', () => {
  test('a live paid alert opens a large pop-up that fits the screen, and OK closes it', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await openPage(page, '/orders');
    await expect(anyPopup(page)).toHaveCount(0);

    const orderId = await alertPayment(page, 'paid');
    const dialog = popup(page, 'paid');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(tr('payPopup.hint.paid'));
    // The LINE name, the name given in the order, the building and the total are read at a glance.
    await expect(dialog).toContainText('(LINE)');
    await expect(dialog).toContainText(tr('payPopup.building', { building: 'D1' }));
    await expect(dialog).toContainText('฿');
    await expect(dialog.getByRole('link', { name: tr('payPopup.viewOrder') })).toHaveAttribute(
      'href',
      `#/orders/${orderId}`,
    );

    // It fits the screen, the buttons are in reach and nothing scrolls sideways.
    const view = page.viewportSize();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= (view?.height ?? 0)).toBe(
      true,
    );
    const ok = dialog.getByRole('button', { name: tr('payPopup.ok') });
    const okBox = await ok.boundingBox();
    expect(okBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await ok.click();
    await expect(anyPopup(page)).toHaveCount(0);
  });

  test('"view order" opens the order and closes the pop-up', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    const orderId = await alertPayment(page, 'paid');
    await popup(page, 'paid')
      .getByRole('link', { name: tr('payPopup.viewOrder') })
      .click();
    await expect(anyPopup(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/orders/${orderId}$`));
  });

  test('a slip to check is amber, says so in words, and opens the order', async ({ page }) => {
    await signInWithPin(page, 'manager');
    const orderId = await alertPayment(page, 'slip_review');
    const dialog = popup(page, 'slip_review');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(tr('payPopup.hint.slip_review'));
    await dialog.getByRole('link', { name: tr('payPopup.checkSlip') }).click();
    await expect(anyPopup(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/orders/${orderId}$`));
  });

  test('two alerts queue: the second shows after the first is closed', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await alertPayment(page, 'paid');
    await alertPayment(page, 'slip_review');
    const first = popup(page, 'paid');
    await expect(first).toBeVisible();
    await expect(first).toContainText(tr('payPopup.more', { count: 1 }));
    await first.getByRole('button', { name: tr('payPopup.ok') }).click();
    const second = popup(page, 'slip_review');
    await expect(second).toBeVisible();
    await second.getByRole('button', { name: tr('payPopup.ok') }).click();
    await expect(anyPopup(page)).toHaveCount(0);
  });

  test('a reload shows nothing: only a live alert opens it', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await alertPayment(page, 'paid');
    await expect(popup(page, 'paid')).toBeVisible();
    await page.reload();
    // The session survives a reload (the tab keeps it); the mock server and its socket start over.
    await expect(mainNav(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(anyPopup(page)).toHaveCount(0);
  });

  test('the switch of this device turns the pop-up off, and the choice survives a reload', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await openPage(page, '/settings');
    await page.locator('main a[href="#/alerts"]').click();
    const toggle = page.getByRole('checkbox', { name: tr('payPopup.switch') });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(tr('payPopup.state.off'))).toBeVisible();

    await alertPayment(page, 'paid');
    await page.waitForTimeout(300);
    await expect(anyPopup(page)).toHaveCount(0);

    await page.reload();
    // The session survives a reload (the tab keeps it); the mock server and its socket start over.
    await expect(mainNav(page)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: tr('payPopup.switch') })).not.toBeChecked();
    await alertPayment(page, 'paid');
    await page.waitForTimeout(300);
    await expect(anyPopup(page)).toHaveCount(0);
  });
});
