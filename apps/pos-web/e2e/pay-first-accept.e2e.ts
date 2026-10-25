import { expect, openPage, signInWithPin, simulateIncomingOrder, test, tr } from './support.ts';

const button = (
  page: import('@playwright/test').Page,
  key: 'order.move.preparing' | 'order.move.startUnpaid',
) => page.getByRole('button', { name: tr(key), exact: true });

test.describe('accepting an unpaid PromptPay order from LINE (D-38)', () => {
  test('a cashier cannot start it and is told it waits for the payment', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    const id = await simulateIncomingOrder(page, { payFirst: true });
    await openPage(page, `/orders/${id}`);
    await expect(page.getByText(tr('order.startUnpaid.wait'))).toBeVisible();
    await expect(button(page, 'order.move.preparing')).toHaveCount(0);
    await expect(button(page, 'order.move.startUnpaid')).toHaveCount(0);
  });

  test('a manager starts it with a reason, and it moves on', async ({ page }) => {
    await signInWithPin(page, 'manager');
    const id = await simulateIncomingOrder(page, { payFirst: true });
    await openPage(page, `/orders/${id}`);
    await expect(button(page, 'order.move.preparing')).toHaveCount(0);
    await button(page, 'order.move.startUnpaid').click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: tr('order.startUnpaid.confirm') });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(tr('order.startUnpaid.reason')).fill('ลูกค้าประจำ');
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: tr('order.move.ready'), exact: true }),
    ).toBeVisible();
  });

  test('a LINE order that is not pay-first keeps the plain accept', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    const id = await simulateIncomingOrder(page);
    await openPage(page, `/orders/${id}`);
    await expect(button(page, 'order.move.preparing')).toBeVisible();
  });
});
