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

/** An order of the list: a row of the table on an iPad or laptop, a card on an iPhone. */
const entry = (page: Page, orderNo: string) =>
  isPhone(page)
    ? page.getByRole('link', { name: new RegExp(orderNo) })
    : page.getByRole('row').filter({ hasText: orderNo });

/** Opens the order page of that order: the detail's main button, or the whole card on a phone. */
async function openOrder(page: Page, orderNo: string) {
  if (isPhone(page)) {
    await entry(page, orderNo).click();
    return;
  }
  await page.getByRole('button', { name: tr('orders.select', { orderNo }) }).click();
  await page
    .getByRole('complementary', { name: tr('orders.detail.label') })
    .getByRole('link', {
      name: new RegExp(
        `^(${tr('orders.cta.charge')}|${tr('orders.cta.open')}|${tr('orders.cta.review')})`,
      ),
    })
    .click();
}

test.describe('order board and status moves', () => {
  test('an order moves from preparing to ready to handed over, and the board follows', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    const orderNo = await ringOrder(page, { dish: 'ชาเย็น' });
    const badges = page.getByTestId('order-badges');
    await expect(badges).toContainText(tr('status.order.preparing'));

    // The board shows it with the server's number, total and status, and opens its page.
    await openPage(page, '/orders');
    await expect(entry(page, orderNo)).toContainText(tr('status.order.preparing'));
    await expect(entry(page, orderNo)).toContainText(baht(2500));
    await openOrder(page, orderNo);

    // Ready: the screen changes only after the server answered.
    await page.getByRole('button', { name: tr('order.move.ready'), exact: true }).click();
    await expect(badges).toContainText(tr('status.order.ready'));
    await openPage(page, '/orders');
    await expect(entry(page, orderNo)).toContainText(tr('status.order.ready'));

    // Handed over: the list still has it (the first filter is all of today), now as finished.
    await openOrder(page, orderNo);
    await page.getByRole('button', { name: tr('order.move.completed'), exact: true }).click();
    await expect(badges).toContainText(tr('status.order.completed'));
    await openPage(page, '/orders');
    await expect(entry(page, orderNo)).toContainText(tr('status.order.completed'));
  });

  test('the filters and the search narrow the list', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    const first = await ringOrder(page, { dish: 'ชาเย็น' });
    await openPage(page, '/orders');
    await expect(entry(page, first)).toBeVisible();
    // Unpaid, so it is in "to pay" / "not yet paid" and not in "paid".
    const unpaid = isPhone(page) ? tr('orders.filter.pay') : tr('status.payment.unpaid');
    await page.getByRole('radio', { name: new RegExp(`^${unpaid}`) }).check({ force: true });
    await expect(entry(page, first)).toBeVisible();
    if (!isPhone(page)) {
      await page
        .getByRole('radio', { name: new RegExp(`^${tr('status.payment.paid')}`) })
        .check({ force: true });
      await expect(entry(page, first)).toHaveCount(0);
      await page
        .getByRole('radio', { name: new RegExp(`^${tr('orders.filter.all')}`) })
        .check({ force: true });
    } else {
      await page
        .getByRole('radio', { name: new RegExp(`^${tr('orders.filter.all')}`) })
        .check({ force: true });
      await page.getByRole('button', { name: tr('common.search') }).click();
    }
    const search = page.getByRole('searchbox', { name: tr('common.search') });
    await search.fill('zzz');
    await expect(page.getByText(tr('orders.noMatch'))).toBeVisible();
    await search.fill(first.toLowerCase());
    await expect(entry(page, first)).toBeVisible();
  });

  test('a cashier cannot cancel an order that is already being made', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' });
    await expect(
      page.getByRole('button', { name: tr('order.move.ready'), exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: tr('order.move.cancelled'), exact: true }),
    ).toHaveCount(0);
  });

  test('a manager cancelling needs a reason and ends the order', async ({ page }) => {
    await signInWithPin(page, 'manager');
    const orderNo = await ringOrder(page, { dish: 'ชาเย็น' });
    await page.getByRole('button', { name: tr('order.move.cancelled'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: tr('order.cancel.confirm') });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(tr('order.cancel.reason')).fill('ลูกค้าเปลี่ยนใจ');
    await confirm.click();
    await expect(page.getByTestId('order-badges')).toContainText(tr('status.order.cancelled'));
    await expect(
      page.getByText(tr('order.cancel.reasonShown', { reason: 'ลูกค้าเปลี่ยนใจ' })),
    ).toBeVisible();
    // A cancelled order takes no payment.
    await expect(paymentPanel(page).getByText(tr('payment.closed'))).toBeVisible();
    expect(orderNo).toMatch(/^S-\d+$/);
  });

  test('an order with a confirmed payment cannot be cancelled from the order page', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await panel.getByRole('button', { name: tr('payment.cash.exact'), exact: true }).click();
    await panel
      .getByRole('button', { name: tr('payment.confirmAmount', { amount: baht(2500) }) })
      .click();
    await expect(panel.getByText(tr('payment.paid.title'))).toBeVisible();
    await page.getByRole('button', { name: tr('order.move.cancelled'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(tr('order.cancel.reason')).fill('ลูกค้าเปลี่ยนใจ');
    await dialog.getByRole('button', { name: tr('order.cancel.confirm') }).click();
    await expect(dialog.getByRole('alert')).toContainText(tr('order.cancel.hasPayment'));
  });
});
