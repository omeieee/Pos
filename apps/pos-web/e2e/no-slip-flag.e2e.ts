import type { Page } from '@playwright/test';
import { formatBaht } from '@sds/i18n';
import {
  expect,
  isPhone,
  openPage,
  paymentPanel,
  ringOrder,
  signInWithPin,
  test,
  tr,
} from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');
const flagText = tr('orders.flag.noSlip');

/** An order of the board: a row of the table on an iPad or laptop, a card (link) on an iPhone. */
const entry = (page: Page, orderNo: string) =>
  isPhone(page)
    ? page.getByRole('link', { name: new RegExp(orderNo) })
    : page.getByRole('row').filter({ hasText: orderNo });

test.describe('"says paid, no slip yet" flag (PromptPay claim)', () => {
  test('the board flags a claimed PromptPay order, staff confirm it, and the flag goes', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');

    // Order A: PromptPay, the customer says they paid. The mock takes no slip, so it is a no-slip claim.
    const flagged = await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await panel.locator('label.g-chip', { hasText: tr('payment.method.promptpay') }).click();
    await panel.getByRole('button', { name: tr('payment.start.promptpay') }).click();
    await panel.getByRole('button', { name: tr('payment.promptpay.customerSays') }).click();
    await expect(panel.getByRole('status')).toContainText(tr('payment.claimed'));
    await expect(page.getByTestId('order-badges')).toContainText(flagText);

    // Order B: a normal order that is still unpaid.
    await openPage(page, '/new');
    const normal = await ringOrder(page, { dish: 'ชาเย็น' });
    expect(normal).not.toBe(flagged);
    await expect(page.getByTestId('order-badges')).not.toContainText(flagText);

    // The board: A carries the flag, B has none, and the flag stays inside its row / card.
    await openPage(page, '/orders');
    await expect(entry(page, normal)).toBeVisible();
    await expect(entry(page, flagged).getByText(flagText)).toBeVisible();
    await expect(entry(page, normal).getByText(flagText)).toHaveCount(0);
    const fit = await entry(page, flagged).evaluate((el, text) => {
      const badge = [...el.querySelectorAll('.g-badge')].find((b) => b.textContent?.includes(text));
      const box = el.getBoundingClientRect();
      const badgeBox = badge?.getBoundingClientRect();
      return {
        found: badge !== undefined,
        scrolls: el.scrollWidth > el.clientWidth,
        badgeInside:
          badgeBox !== undefined &&
          badgeBox.left >= box.left - 1 &&
          badgeBox.right <= box.right + 1,
      };
    }, flagText);
    expect(fit).toEqual({ found: true, scrolls: false, badgeInside: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Open A: the order page shows the flag; staff check the bank app and confirm.
    if (isPhone(page)) {
      await entry(page, flagged).click();
    } else {
      await page.getByRole('button', { name: tr('orders.select', { orderNo: flagged }) }).click();
      await page
        .getByRole('complementary', { name: tr('orders.detail.label') })
        .getByRole('link', { name: new RegExp(`^${tr('orders.cta.review')}`) })
        .click();
    }
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(flagged) })).toBeVisible();
    await expect(page.getByTestId('order-badges')).toContainText(flagText);
    const confirm = paymentPanel(page).getByRole('button', {
      name: tr('payment.confirmAmount', { amount: baht(2500) }),
    });
    await confirm.click();

    // Paid comes from the server's answer; the flag is gone on the order page and on the board.
    await expect(paymentPanel(page).getByText(tr('payment.paid.title'))).toBeVisible();
    await expect(page.getByTestId('order-badges')).toContainText(tr('status.payment.paid'));
    await expect(page.getByTestId('order-badges')).not.toContainText(flagText);
    await openPage(page, '/orders');
    await expect(entry(page, flagged)).toContainText(tr('status.payment.paid'));
    await expect(page.getByText(flagText)).toHaveCount(0);
  });
});
