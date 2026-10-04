import type { Page } from '@playwright/test';
import {
  expect,
  openPage,
  paymentPanel,
  ringOrder,
  signInWithPin,
  tapPin,
  test,
  tr,
} from './support.ts';

/** Basic checks only (no axe): touch targets of the main controls and no sideways scroll. */
const MIN_TARGET = 44;

async function expectNoHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll, `${where}: page is wider than the screen`).toBeLessThanOrEqual(
    overflow.client,
  );
}

/** Every visible element matched by `selector` must be at least 44 x 44 CSS px. */
async function expectTapTargets(page: Page, selector: string, where: string) {
  // A selector that matches nothing would pass vacuously: the screen must have such controls.
  await expect(
    page.locator(selector).first(),
    `${where}: nothing matches ${selector}`,
  ).toBeVisible();
  // Measure the settled page: a panel that has just appeared may still be rising into place.
  // (Looping animations such as the breathing dot never finish, so they are left out.)
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
  const small = await page.locator(selector).evaluateAll(
    (elements, min) =>
      elements
        .map((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const hidden =
            box.width === 0 ||
            box.height === 0 ||
            style.visibility === 'hidden' ||
            style.display === 'none';
          return {
            hidden,
            width: Math.round(box.width),
            height: Math.round(box.height),
            label: (element.getAttribute('aria-label') ?? element.textContent ?? '')
              .trim()
              .slice(0, 30),
          };
        })
        .filter((box) => !box.hidden && (box.width < min || box.height < min)),
    MIN_TARGET,
  );
  expect(small, `${where}: controls under ${MIN_TARGET}px`).toEqual([]);
}

test.describe('basic layout checks', () => {
  test('sign-in screen: PIN keys, tiles and the owner link are tap-sized, nothing scrolls sideways', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: tr('auth.pin.title') })).toBeVisible();
    await expectTapTargets(page, '.tile', 'staff tiles');
    await expectNoHorizontalScroll(page, 'staff tiles');
    await page.getByRole('button', { name: /พนักงานตัวอย่าง/ }).click();
    await expect(page.locator('.pinpad .key').first()).toBeVisible();
    await expectTapTargets(page, '.pinpad .key, .pinpad .btn', 'PIN pad');
    await expectNoHorizontalScroll(page, 'PIN pad');
    await tapPin(page, '1234');
    await expect(page.getByRole('navigation', { name: tr('nav.label') })).toBeVisible();
  });

  test('order entry: navigation, dishes, cart controls and the place button', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await expect(page.locator('button.g-tile').first()).toBeVisible();
    await expectTapTargets(page, '.g-nav, .g-tab, .g-side', 'navigation');
    await expectTapTargets(page, 'button.g-tile, nav[aria-label] > .g-chip', 'menu');
    await expectNoHorizontalScroll(page, 'order entry');

    // A dish with options: the sheet's choices and buttons.
    await page
      .locator('button.g-tile', { has: page.getByText('ก๋วยเตี๋ยวต้มยำ', { exact: true }) })
      .click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expectTapTargets(page, '[role=dialog] .g-chip, [role=dialog] .g-btn', 'options sheet');
    await expectNoHorizontalScroll(page, 'options sheet');
    for (const option of ['เส้นเล็ก', 'เผ็ดน้อย']) {
      await sheet.locator('label.g-chip', { hasText: option }).click();
    }
    await sheet.getByRole('button', { name: /^เพิ่ม ·/ }).click();

    // The cart: steppers, buildings, place.
    if ((page.viewportSize()?.width ?? 1000) <= 719) {
      await expectTapTargets(page, '[data-testid=cart-bar]', 'cart bar');
      await page.getByTestId('cart-bar').click();
    }
    await expectTapTargets(
      page,
      // the channel switch is the design's 40px pill inside a 48px track: not measured here
      '[data-testid=cart] .g-btn, [data-testid=cart] .g-chip:not(.g-seg > .g-chip), [role=dialog] .g-btn, [role=dialog] .g-chip:not(.g-seg > .g-chip)',
      'cart',
    );
    await expectNoHorizontalScroll(page, 'cart');
  });

  test('order page: moves, payment methods, cash keypad and PromptPay actions', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await ringOrder(page, { dish: 'ชาเย็น' });
    await expectTapTargets(page, 'main .g-btn, main .g-chip', 'order page');
    const panel = paymentPanel(page);
    await expectTapTargets(page, 'main .g-btn', 'cash keypad');
    await expectNoHorizontalScroll(page, 'order page (cash)');
    await panel.locator('label.g-chip', { hasText: tr('payment.method.promptpay') }).click();
    await panel.getByRole('button', { name: tr('payment.start.promptpay') }).click();
    await expect(
      panel.getByRole('button', { name: tr('payment.promptpay.customerSays') }),
    ).toBeVisible();
    await expectTapTargets(page, 'main .g-btn', 'PromptPay actions');
    await expectNoHorizontalScroll(page, 'order page (PromptPay)');
  });

  test('board, kitchen, settings and menu editor do not scroll sideways', async ({ page }) => {
    await signInWithPin(page, 'manager');
    await ringOrder(page, { dish: 'ชาเย็น' });
    for (const [hash, where] of [
      ['/orders', 'orders board'],
      ['/kitchen', 'kitchen'],
      ['/settings', 'settings hub'],
      ['/settings/menu', 'menu editor'],
    ] as const) {
      await openPage(page, hash);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expectNoHorizontalScroll(page, where);
    }
    await expectTapTargets(page, 'main .g-btn', 'menu editor buttons');
  });
});
