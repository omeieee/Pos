import type { Page } from '@playwright/test';
import { formatBaht } from '@sds/i18n';
import { expect, MOCK_PROMPTPAY, ringOrder, signInWithPin, test, tr } from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');

/** The payment column. Its name follows the stage (choose / done), so it is found by its heading id. */
const paymentPanel = (page: Page) => page.locator('section[aria-labelledby="pay-title"]');
/** A method of the switcher (a radio chip), by its visible name. */
const method = (panel: ReturnType<typeof paymentPanel>, name: string) =>
  panel.locator('label.g-chip', { hasText: name });

test.describe('payments (P1, P2)', () => {
  test('cash: change comes from the shared calculation, and paid shows only after the server says so', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' }); // ฿25
    const panel = paymentPanel(page);
    await expect(page.getByTestId('order-total')).toHaveText(baht(2500));
    const key = (digit: string) =>
      panel.getByRole('group', { name: tr('payment.cash.keypad') }).getByRole('button', {
        name: digit,
        exact: true,
      });
    const confirm = panel.getByRole('button', { name: /^ยืนยันรับเงิน/ });

    // Nothing typed: nothing to confirm.
    await expect(confirm).toBeDisabled();
    // ฿20 is short by ฿5: the confirm stays off and the shortfall is shown.
    await key('2').click();
    await key('0').click();
    await expect(panel.getByTestId('cash-change')).toContainText(
      tr('payment.cash.short', { amount: baht(500) }),
    );
    await expect(confirm).toBeDisabled();
    // ฿50 gives ฿25 back.
    await panel.getByRole('button', { name: tr('payment.cash.clear') }).click();
    await key('5').click();
    await key('0').click();
    await expect(panel.getByTestId('cash-tender')).toHaveText(baht(5000));
    await expect(panel.getByTestId('cash-change')).toContainText(baht(2500));
    await expect(confirm).toHaveText(
      tr('payment.cash.confirmWithChange', { amount: baht(2500), change: baht(2500) }),
    );
    await expect(panel.getByText(tr('payment.paid.title'))).toHaveCount(0);
    await confirm.click();

    // Paid is shown from the server's answer.
    await expect(panel.getByText(tr('payment.paid.title'))).toBeVisible();
    await expect(panel.getByTestId('paid-card')).toContainText(tr('payment.method.cash'));
    await expect(panel.getByRole('region', { name: tr('payment.cash.title') })).toHaveCount(0);
    await expect(panel.getByRole('region', { name: tr('payment.history.title') })).toContainText(
      tr('payment.history.cash', { tendered: baht(5000), change: baht(2500) }),
    );
  });

  test('cash: the exact chip takes the total with no change', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await panel.getByRole('button', { name: tr('payment.cash.exact'), exact: true }).click();
    await expect(panel.getByTestId('cash-change')).toContainText(baht(0));
    await panel
      .getByRole('button', { name: tr('payment.confirmAmount', { amount: baht(2500) }) })
      .click();
    await expect(panel.getByText(tr('payment.paid.title'))).toBeVisible();
  });

  test('PromptPay: QR for the order total with the masked target, claimed, then confirmed by staff', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await method(panel, tr('payment.method.promptpay')).click();
    // Choosing the method creates nothing: the payment starts with the button.
    await expect(panel.getByRole('region', { name: tr('payment.history.title') })).toHaveCount(0);
    await panel.getByRole('button', { name: tr('payment.start.promptpay') }).click();

    const qr = panel.getByRole('img', {
      name: tr('payment.promptpay.qrAlt', { amount: baht(2500) }),
    });
    await expect(qr).toBeVisible();
    const src = await qr.getAttribute('src');
    expect(src).toMatch(/\/v1\/payments\/[^/]+\/qr\.png/);
    // The picture really loads (the dev server answers with a labelled sample picture).
    const picture = await page.request.get(src ?? '');
    expect(picture.status()).toBe(200);
    // Only the masked target is on the page; the full mock ID never is.
    await expect(panel).toContainText(
      tr('payment.promptpay.target', { target: MOCK_PROMPTPAY.masked }),
    );
    expect(await page.locator('body').innerText()).not.toContain(MOCK_PROMPTPAY.id);
    expect(await page.content()).not.toContain(MOCK_PROMPTPAY.id);

    // The customer says they paid: that is a claim, not a payment.
    await panel.getByRole('button', { name: tr('payment.promptpay.customerSays') }).click();
    await expect(panel.getByRole('status')).toContainText(tr('payment.claimed'));
    await expect(panel.getByText(tr('payment.paid.title'))).toHaveCount(0);
    await expect(page.getByTestId('order-badges')).toContainText(tr('payment.status.claimed'));

    // Staff check the bank app and confirm.
    await panel
      .getByRole('button', { name: tr('payment.confirmAmount', { amount: baht(2500) }) })
      .click();
    await expect(panel.getByText(tr('payment.paid.title'))).toBeVisible();
    await expect(panel.getByTestId('paid-card')).toContainText(tr('payment.method.promptpay'));
  });

  test('ไทยช่วยไทย: the full total to type into ถุงเงิน, the split only as a labelled estimate, no QR from this app', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    // ฿45, delivered at the entrance (the only kind of order the shop takes at the counter).
    await ringOrder(page, { dish: 'ก๋วยเตี๋ยวน้ำใส', options: ['เส้นเล็ก', 'เผ็ดน้อย'] });
    const panel = paymentPanel(page);
    await method(panel, tr('payment.method.gov_copay')).click();
    const steps = panel.getByTestId('copay');
    await expect(steps.locator('[data-amount="typed"]')).toHaveText(baht(4500));
    await expect(steps).toContainText(tr('payment.govCopay.estimateLabel'));
    await expect(steps).toContainText(tr('payment.govCopay.govShare'));
    await expect(steps).toContainText(tr('payment.govCopay.customerShare'));
    await expect(steps).toContainText(tr('payment.govCopay.noQr'));
    // This app never draws a QR for the scheme.
    await expect(panel.getByRole('img')).toHaveCount(0);

    // Starting it makes a pending payment; staff confirm once the money is seen in ถุงเงิน.
    await panel.getByRole('button', { name: tr('payment.start.gov_copay') }).click();
    await expect(
      panel.getByRole('button', { name: tr('payment.confirmAmount', { amount: baht(4500) }) }),
    ).toBeVisible();
    await expect(panel.getByText(tr('payment.paid.title'))).toHaveCount(0);
    await panel
      .getByRole('button', { name: tr('payment.confirmAmount', { amount: baht(4500) }) })
      .click();
    await expect(panel.getByText(tr('payment.paid.title'))).toBeVisible();
    await expect(panel.getByTestId('paid-card')).toContainText(tr('payment.method.gov_copay'));
  });

  test('PromptPay: "money not found" cancels the claimed payment and offers the methods again', async ({
    page,
  }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const panel = paymentPanel(page);
    await method(panel, tr('payment.method.promptpay')).click();
    await panel.getByRole('button', { name: tr('payment.start.promptpay') }).click();
    await panel.getByRole('button', { name: tr('payment.promptpay.customerSays') }).click();
    await expect(panel.getByRole('status')).toContainText(tr('payment.claimed'));
    await panel.getByRole('button', { name: tr('payment.promptpay.notFound') }).click();
    // Cancelling a claim asks for a reason.
    const dialog = page.getByRole('dialog');
    const cancel = dialog.getByRole('button', { name: tr('payment.notFound.confirm') });
    await expect(cancel).toBeDisabled();
    await dialog.getByLabel(tr('payment.notFound.reason')).fill('ตรวจแล้วไม่มียอดเข้าบัญชี');
    await cancel.click();
    await expect(panel.getByRole('group', { name: tr('payment.methodsLabel') })).toBeVisible();
    await expect(page.getByTestId('order-badges')).not.toContainText(tr('payment.status.claimed'));
    await expect(panel.getByRole('region', { name: tr('payment.history.title') })).toContainText(
      tr('payment.status.cancelled'),
    );
  });
});
