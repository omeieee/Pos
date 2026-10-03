import { formatBaht } from '@sds/i18n';
import { expect, openPage, paymentPanel, ringOrder, signInWithPin, test, tr } from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');

const column = (page: import('@playwright/test').Page, status: 'new' | 'preparing' | 'ready') =>
  page.getByRole('region', { name: new RegExp(`^${tr(`status.order.${status}`)} \\d+$`) });

test.describe('order board and status moves', () => {
  test('an order moves from preparing to ready to handed over, and the board follows', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    const orderNo = await ringOrder(page, { dish: 'ชาเย็น' });
    const badges = page.locator('.odetail__badges');
    await expect(badges).toContainText(tr('status.order.preparing'));

    // The board shows it in "preparing" with the server's number and total.
    await openPage(page, '/orders');
    const open = page.getByRole('link', { name: new RegExp(orderNo) });
    await expect(column(page, 'preparing')).toContainText(orderNo);
    await expect(column(page, 'preparing')).toContainText(baht(2500));
    await open.click();

    // Ready: the screen changes only after the server answered.
    await page.getByRole('button', { name: tr('order.move.ready'), exact: true }).click();
    await expect(badges).toContainText(tr('status.order.ready'));
    await openPage(page, '/orders');
    await expect(column(page, 'ready')).toContainText(orderNo);
    await expect(column(page, 'preparing')).not.toContainText(orderNo);

    // Handed over: it leaves the open board and stays in "all today".
    await open.click();
    await page.getByRole('button', { name: tr('order.move.completed'), exact: true }).click();
    await expect(badges).toContainText(tr('status.order.completed'));
    await openPage(page, '/orders');
    await expect(page.getByRole('link', { name: new RegExp(orderNo) })).toHaveCount(0);
    await page.getByRole('radio', { name: tr('orders.filter.all') }).check({ force: true });
    await expect(page.getByRole('link', { name: new RegExp(orderNo) })).toBeVisible();
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
    await expect(page.locator('.odetail__badges')).toContainText(tr('status.order.cancelled'));
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
