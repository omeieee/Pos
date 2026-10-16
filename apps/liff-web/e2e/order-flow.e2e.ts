import { Buffer } from 'node:buffer';
import {
  addDishAndCheckout,
  BUILDING,
  expect,
  expectNoSideScroll,
  IDS,
  MOCK_PROMPTPAY_ID,
  openMenu,
  RECIPIENT,
  sentTo,
  THIN_NAME,
  test,
  tr,
} from './support.ts';

/** A tiny valid PNG, as the customer's transfer slip. */
const SLIP = {
  name: 'slip.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDKgAwAAUgYEAdMKdXYAAAAASUVORK5CYII=',
    'base64',
  ),
};

async function fillRecipient(page: import('@playwright/test').Page) {
  await page.getByLabel(tr('liff.checkout.name')).fill(RECIPIENT);
  await page.getByLabel(tr('liff.checkout.building')).selectOption(BUILDING);
}

test.describe('ordering with PromptPay', () => {
  test('menu, options, checkout, QR, "โอนแล้ว", slip, neutral checking status', async ({
    page,
    api,
  }) => {
    await openMenu(page, api);
    await expectNoSideScroll(page);
    await addDishAndCheckout(page);
    await expect(page.getByRole('heading', { name: tr('liff.checkout.title') })).toBeVisible();
    await expect(page.getByText(THIN_NAME)).toBeVisible();
    await expectNoSideScroll(page);

    await fillRecipient(page);
    await page.getByRole('radio', { name: new RegExp(tr('payment.method.promptpay')) }).check();
    await page.getByRole('button', { name: tr('liff.checkout.order') }).click();

    // The order page: placed, with the exact-amount QR and the shop's PromptPay text.
    await expect(page.getByText(tr('liff.order.placed'))).toBeVisible();
    expect(api.placed).toHaveLength(1);
    expect(api.placed[0]).toMatchObject({
      deliveryBuilding: BUILDING,
      recipientName: RECIPIENT,
      paymentMethod: 'promptpay',
      items: [{ menuItemId: IDS.dish, qty: 1, modifierOptionIds: [IDS.thin] }],
    });
    await expect(
      page.getByRole('img', { name: tr('liff.qr.alt', { amount: '฿50.00' }) }),
    ).toBeVisible();
    await expect(page.getByText(tr('liff.qr.id', { id: MOCK_PROMPTPAY_ID }))).toBeVisible();
    await expectNoSideScroll(page);

    // "โอนแล้ว" without a slip is only a claim: the page says so and asks for the slip.
    await page.getByRole('button', { name: tr('liff.order.claim'), exact: true }).click();
    await expect(page.getByText(tr('liff.order.claimedTitle'))).toBeVisible();
    await expect(page.getByText(tr('liff.slipStatus.none'))).toBeVisible();
    expect(api.claims).toBe(1);
    await expect(page.getByText(tr('liff.order.paid'))).toHaveCount(0);

    // The slip goes up as the raw picture; the progress pop-up is neutral, never "paid".
    await page.locator('input[type="file"]').setInputFiles(SLIP);
    const progress = page.getByRole('dialog');
    await expect(progress.getByText(tr('liff.slipProgress.title'))).toBeVisible();
    expect(api.slips).toHaveLength(1);
    expect(api.slips[0]?.contentType).toBe('image/png');
    // The page sent the picture itself as the body, whole (measured in the page, any browser).
    expect(await sentTo(page, `/v1/app/orders/${IDS.order}/slip`)).toEqual([
      { url: expect.any(String), method: 'POST', bytes: SLIP.buffer.length },
    ]);
    await expect(progress.getByText(tr('liff.paidPopup.title'))).toHaveCount(0);

    // The bank check ended and staff are to look: the same neutral words, whatever the result was.
    api.staffReview();
    await expect(progress.getByText(tr('liff.slipProgress.staffTitle'))).toBeVisible({
      timeout: 20_000,
    });
    await progress.getByRole('button', { name: tr('liff.close') }).click();
    await expect(progress).toBeHidden();
    await expect(page.getByText(tr('liff.slipStatus.staffReview'))).toBeVisible();
    await expect(page.getByText(tr('liff.paidPopup.title'))).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test('staff confirm the money by hand: the paid pop-up appears once and the QR goes away', async ({
    page,
    api,
  }) => {
    await openMenu(page, api);
    await addDishAndCheckout(page);
    await fillRecipient(page);
    await page.getByRole('radio', { name: new RegExp(tr('payment.method.promptpay')) }).check();
    await page.getByRole('button', { name: tr('liff.checkout.order') }).click();
    await expect(page.getByText(tr('liff.order.placed'))).toBeVisible();
    await page.getByRole('button', { name: tr('liff.order.claim'), exact: true }).click();
    await expect(page.getByText(tr('liff.order.claimedTitle'))).toBeVisible();

    api.confirmPaid();
    // Coming back to the app asks the server at once (the page also polls every few seconds).
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const popup = page.getByRole('dialog');
    await expect(popup.getByText(tr('liff.paidPopup.title'))).toBeVisible();
    await popup.getByRole('button', { name: tr('liff.close') }).click();
    await expect(popup).toBeHidden();
    await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoSideScroll(page);
  });
});

test.describe('checkout rules', () => {
  test('a missing name or building is refused before anything is sent', async ({ page, api }) => {
    await openMenu(page, api);
    await addDishAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(tr('payment.method.promptpay')) }).check();
    await page.getByRole('button', { name: tr('liff.checkout.order') }).click();
    await expect(page.getByText(tr('liff.checkout.required'))).toBeVisible();
    expect(api.placed).toHaveLength(0);
    await expectNoSideScroll(page);
  });

  test('cash: the order is placed and the page says to pay at the building entrance', async ({
    page,
    api,
  }) => {
    await openMenu(page, api);
    await addDishAndCheckout(page);
    await fillRecipient(page);
    await page.getByRole('radio', { name: new RegExp(tr('payment.method.cash')) }).check();
    await page.getByRole('button', { name: tr('liff.checkout.order') }).click();
    await expect(page.getByText(tr('liff.order.cashNote'))).toBeVisible();
    expect(api.placed[0]).toMatchObject({ paymentMethod: 'cash' });
    // Cash has no QR and no "โอนแล้ว".
    await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: tr('liff.order.claim'), exact: true }),
    ).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test.describe('when the shop is not delivering', () => {
    test.use({ fakeOptions: { closed: true, acknowledged: true } });

    test('the menu says so and the order button is off', async ({ page, api }) => {
      await openMenu(page, api);
      await expect(page.getByText(tr('liff.menu.closedBadge'))).toBeVisible();
      await addDishAndCheckout(page);
      await expect(page.getByText(tr('liff.error.SHOP_CLOSED'))).toBeVisible();
      await expect(page.getByRole('button', { name: tr('liff.checkout.order') })).toBeDisabled();
      expect(api.placed).toHaveLength(0);
      await expectNoSideScroll(page);
    });
  });
});
