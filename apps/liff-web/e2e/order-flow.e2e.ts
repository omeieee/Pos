import { Buffer } from 'node:buffer';
import {
  addDishAndCheckout,
  BUILDING,
  DISH_NAME,
  expect,
  expectNoSideScroll,
  type FakeApi,
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

async function openPromptPayOrder(page: import('@playwright/test').Page, api: FakeApi) {
  await openMenu(page, api);
  await addDishAndCheckout(page);
  await fillRecipient(page);
  await page.getByRole('radio', { name: new RegExp(tr('payment.method.promptpay')) }).check();
  await page.getByRole('button', { name: tr('liff.checkout.order') }).click();
  await expect(page.getByRole('img', { name: /QR/ })).toBeVisible();
}

test.describe('saving the QR inside the LINE app', () => {
  test.use({ inLine: true });

  test('the save button downloads a real file, stays on the order page and shows a savable picture', async ({
    page,
    api,
    browserName,
  }) => {
    await openPromptPayOrder(page, api);
    const orderUrl = page.url();
    // Playwright's WebKit raises no download event for an attachment link; the request is still seen.
    const fileRequest = page.waitForRequest(
      (r) => r.url().includes('/qr.png?') && r.url().includes('download=1'),
    );
    const download = browserName === 'webkit' ? null : page.waitForEvent('download');
    await page.getByRole('button', { name: tr('liff.qr.save') }).click();
    await fileRequest;
    if (download) expect((await download).suggestedFilename()).toBe('promptpay-qr.png');
    // Still on the order page; the large picture is the real https file, not a page-made blob.
    expect(page.url()).toBe(orderUrl);
    const viewer = page.getByRole('dialog', { name: tr('liff.qr.title') });
    await expect(viewer.getByText(tr('liff.qr.holdToSave'))).toBeVisible();
    const src = await viewer.getByRole('img').getAttribute('src');
    expect(src).not.toMatch(/^blob:/);
    expect(src).toContain('/qr.png?');
    expect(src).not.toContain('download=1');
    await viewer.getByRole('button', { name: tr('liff.close') }).click();
    await expect(viewer).toBeHidden();
    await expectNoSideScroll(page);
  });
});

test.describe('saving the QR in a normal browser', () => {
  test('the picture downloads from the page and no file link is followed', async ({
    page,
    api,
  }) => {
    await openPromptPayOrder(page, api);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tr('liff.qr.save') }).click();
    expect((await download).suggestedFilename()).toBe('promptpay-S-001.png');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
async function reachCheckout(
  page: import('@playwright/test').Page,
  api: FakeApi,
  name = RECIPIENT,
) {
  await openMenu(page, api);
  await addDishAndCheckout(page);
  await page.getByLabel(tr('liff.checkout.name')).fill(name);
  await page.getByLabel(tr('liff.checkout.building')).selectOption(BUILDING);
  await page.getByRole('radio', { name: new RegExp(tr('payment.method.promptpay')) }).check();
  await page.getByRole('button', { name: tr('liff.checkout.order') }).click();
}

const orderTitle = (orderNo: string) => tr('liff.order.title', { orderNo });
const qrAlt = (amount: string) => tr('liff.qr.alt', { amount });

test.describe('an unpaid order is already open at checkout', () => {
  test.use({ fakeOptions: { acknowledged: true } });

  test('ask, then add to the earlier order: one edit, no new order', async ({ page, api }) => {
    const old = api.seedOrder({ no: 'L-001' });
    await reachCheckout(page, api);
    const sheet = page.getByRole('dialog');
    await expect(
      sheet.getByText(tr('liff.openOrder.title', { orderNo: 'L-001', amount: '฿60.00' })),
    ).toBeVisible();
    await expectNoSideScroll(page);
    await sheet.getByRole('button', { name: tr('liff.openOrder.continue') }).click();
    await expect(
      sheet.getByText(tr('liff.openOrder.mergeTitle', { orderNo: 'L-001' })),
    ).toBeVisible();
    await sheet.getByRole('button', { name: tr('liff.openOrder.merge') }).click();

    // The earlier order now holds both dishes at the new total; nothing was placed.
    await expect(page.getByText(orderTitle('L-001'))).toBeVisible();
    await expect(page.getByRole('img', { name: qrAlt('฿110.00') })).toBeVisible();
    expect(api.placed).toHaveLength(0);
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.body.expectedVersion).toBe(1);
    expect(api.edits[0]?.key).toBeTruthy();
    expect(api.edits[0]?.body.items).toEqual([
      { menuItemId: IDS.dish, qty: 1, modifierOptionIds: [IDS.wide] },
      { menuItemId: IDS.dish, qty: 1, modifierOptionIds: [IDS.thin] },
    ]);
    expect(old.lines).toHaveLength(2);
    await expectNoSideScroll(page);
  });

  test('ask, then a separate order: the cart is placed as it is', async ({ page, api }) => {
    api.seedOrder({ no: 'L-001' });
    await reachCheckout(page, api);
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: tr('liff.openOrder.continue') }).click();
    await sheet.getByRole('button', { name: tr('liff.openOrder.separate') }).click();
    await expect(page.getByText(tr('liff.order.placed'))).toBeVisible();
    expect(api.placed).toHaveLength(1);
    expect(api.edits).toHaveLength(0);
    expect(api.orders).toHaveLength(2);
  });

  test('the same dishes get the stronger wording; "view" opens the earlier order', async ({
    page,
    api,
  }) => {
    api.seedOrder({
      no: 'L-001',
      lines: [{ menuItemId: IDS.dish, qty: 1, optionIds: [IDS.thin], note: null }],
    });
    await reachCheckout(page, api);
    const sheet = page.getByRole('dialog');
    await expect(
      sheet.getByText(tr('liff.openOrder.titleDuplicate', { orderNo: 'L-001', amount: '฿50.00' })),
    ).toBeVisible();
    await sheet.getByRole('button', { name: tr('liff.openOrder.viewOld') }).click();
    await expect(page.getByText(orderTitle('L-001'))).toBeVisible();
    expect(api.placed).toHaveLength(0);
  });

  test('another name: no add choice, "order more" places the order', async ({ page, api }) => {
    api.seedOrder({ no: 'L-001', recipient: 'คุณคนอื่น' });
    await reachCheckout(page, api);
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: tr('liff.openOrder.continue') }).click();
    await expect(page.getByText(tr('liff.order.placed'))).toBeVisible();
    expect(api.placed).toHaveLength(1);
    expect(api.edits).toHaveLength(0);
  });
});

test.describe('changing and cancelling an unpaid order', () => {
  test('change the dishes: the cart reopens with the lines and saving replaces them', async ({
    page,
    api,
  }) => {
    await openPromptPayOrder(page, api);
    await page.getByRole('button', { name: tr('liff.edit.button') }).click();
    await expect(page.getByText(tr('liff.edit.title', { orderNo: 'S-001' }))).toBeVisible();
    // The cart holds the order's own line; add a second one with the wide noodles.
    await page.getByRole('button', { name: `${tr('liff.cart.inc')} ${DISH_NAME}` }).click();
    const picker = page.getByRole('dialog');
    await picker.getByRole('radio', { name: /เส้นใหญ่/ }).check();
    await picker.getByRole('button', { name: tr('liff.option.add', { amount: '฿60.00' }) }).click();
    await page.getByRole('button', { name: new RegExp(tr('liff.menu.toPay')) }).click();

    // Only the lines are edited: no recipient or payment form.
    await expect(
      page.getByRole('heading', { name: tr('liff.edit.title', { orderNo: 'S-001' }) }),
    ).toBeVisible();
    await expect(page.getByLabel(tr('liff.checkout.name'))).toHaveCount(0);
    await page.getByRole('button', { name: tr('liff.edit.save') }).click();

    await expect(page.getByRole('img', { name: qrAlt('฿110.00') })).toBeVisible();
    expect(api.placed).toHaveLength(1);
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.body.items).toHaveLength(2);
    expect(api.edits[0]?.key).toBeTruthy();
    await expectNoSideScroll(page);
  });

  test('cancel: asks first, then says the order was cancelled by the customer', async ({
    page,
    api,
  }) => {
    await openPromptPayOrder(page, api);
    await page.getByRole('button', { name: tr('liff.cancel.button') }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(tr('liff.cancel.title', { orderNo: 'S-001' }))).toBeVisible();
    // Keeping the order closes the question and sends nothing.
    await sheet.getByRole('button', { name: tr('liff.cancel.keep') }).click();
    await expect(sheet).toBeHidden();
    expect(api.cancels).toHaveLength(0);

    await page.getByRole('button', { name: tr('liff.cancel.button') }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('liff.cancel.confirm') })
      .click();
    await expect(page.getByText(tr('liff.cancel.reason.customer_cancel'))).toBeVisible();
    expect(api.cancels).toHaveLength(1);
    expect(api.cancels[0]?.body).toEqual({ expectedVersion: 1 });
    expect(api.cancels[0]?.key).toBeTruthy();
    await expect(page.getByRole('button', { name: tr('liff.cancel.button') })).toHaveCount(0);
    await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  });

  test('once a slip is sent the order can be neither changed nor cancelled', async ({
    page,
    api,
  }) => {
    await openPromptPayOrder(page, api);
    await page.locator('input[type="file"]').setInputFiles(SLIP);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('liff.close') })
      .click();
    await expect(page.getByRole('button', { name: tr('liff.edit.button') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: tr('liff.cancel.button') })).toHaveCount(0);
  });
});

test.describe('cancelled orders say why', () => {
  test.use({ fakeOptions: { acknowledged: true } });

  test('the unpaid timeout, in plain words', async ({ page, api }) => {
    const order = api.seedOrder();
    api.cancel('unpaid_timeout', order);
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByText(tr('liff.cancel.reason.unpaid_timeout'))).toBeVisible();
    await expectNoSideScroll(page);
  });

  test('merged into another order, by its number', async ({ page, api }) => {
    const order = api.seedOrder();
    api.cancel('merged', order, 'L-004');
    await page.goto(`/orders/${order.id}`);
    await expect(
      page.getByText(tr('liff.cancel.reason.merged', { orderNo: 'L-004' })),
    ).toBeVisible();
  });
});

test.describe('a slip that matches several orders', () => {
  test.use({ fakeOptions: { acknowledged: true } });

  /** L-001 (60 baht) and L-002 (50 baht); the slip reads 110 baht and is sent on L-002. */
  async function sendCombinedSlip(page: import('@playwright/test').Page, api: FakeApi) {
    api.seedOrder({ no: 'L-001' });
    const second = api.seedOrder({
      no: 'L-002',
      lines: [{ menuItemId: IDS.dish, qty: 1, optionIds: [IDS.thin], note: null }],
    });
    api.slipAmountSatang = 11_000;
    await page.goto(`/orders/${second.id}`);
    await page.locator('input[type="file"]').setInputFiles(SLIP);
    const sheet = page.getByRole('dialog');
    await expect(
      sheet.getByText(tr('liff.combine.title', { amount: '฿110.00', orders: '#L-002 + #L-001' })),
    ).toBeVisible();
    // Asked first: nothing was stored.
    expect(api.slips).toHaveLength(0);
    await expectNoSideScroll(page);
    return { second, sheet };
  }

  test('yes: the orders are combined and the slip goes to the combined order', async ({
    page,
    api,
  }) => {
    const { second, sheet } = await sendCombinedSlip(page, api);
    await sheet.getByRole('button', { name: tr('liff.combine.yes') }).click();
    await expect(page.getByRole('dialog').getByText(tr('liff.slipProgress.title'))).toBeVisible();
    expect(api.slips).toHaveLength(1);
    expect(api.slips[0]?.query).toBe('?combine=1');
    expect(api.merges).toBe(1);
    expect(api.total(second)).toBe(11_000);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('liff.close') })
      .click();
    await expect(page.getByRole('img', { name: qrAlt('฿110.00') })).toBeVisible();

    // The earlier order is gone and points at the one that took it.
    await page.goto(`/orders/${IDS.order}`);
    await expect(
      page.getByText(tr('liff.cancel.reason.merged', { orderNo: 'L-002' })),
    ).toBeVisible();
  });

  test('no: "amount does not match", then send it to the shop to check', async ({ page, api }) => {
    const { sheet } = await sendCombinedSlip(page, api);
    await sheet.getByRole('button', { name: tr('liff.combine.no') }).click();
    const mismatch = page.getByRole('dialog');
    await expect(mismatch.getByText(tr('liff.mismatch.title'))).toBeVisible();
    expect(api.slips).toHaveLength(0);
    await mismatch.getByRole('button', { name: tr('liff.mismatch.review') }).click();
    await expect(page.getByRole('dialog').getByText(tr('liff.slipProgress.title'))).toBeVisible();
    expect(api.slips).toHaveLength(1);
    expect(api.slips[0]?.query).toBe('?review=1');
    expect(api.merges).toBe(0);
  });

  test('no: pick another slip and send it as usual', async ({ page, api }) => {
    const { sheet } = await sendCombinedSlip(page, api);
    await sheet.getByRole('button', { name: tr('liff.combine.no') }).click();
    // The new slip reads as this order's own amount.
    api.slipAmountSatang = 5000;
    await page.getByRole('dialog').locator('input[type="file"]').setInputFiles(SLIP);
    await expect(page.getByRole('dialog').getByText(tr('liff.slipProgress.title'))).toBeVisible();
    expect(api.slips).toHaveLength(1);
    expect(api.slips[0]?.query).toBe('');
  });
});

test.describe('the slip result the customer sees', () => {
  test('paid shows at once, without the 5 second hold', async ({ page, api }) => {
    await openPromptPayOrder(page, api);
    await page.getByRole('button', { name: tr('liff.order.claim'), exact: true }).click();
    await expect(page.getByText(tr('liff.order.claimedTitle'))).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(SLIP);
    const progress = page.getByRole('dialog');
    await expect(progress.getByText(tr('liff.slipProgress.title'))).toBeVisible();
    api.confirmPaid();
    // The next quick poll (2 s) sees it; the old hold would keep "checking" up to 5 s.
    await expect(progress.getByText(tr('liff.paidPopup.title'))).toBeVisible({ timeout: 4400 });
    await expect(progress.getByText('ชำระเงินสำเร็จ')).toBeVisible();
  });

  test('a wrong amount is named; a valid slip waits for the shop and is not "paid"', async ({
    page,
    api,
  }) => {
    await openPromptPayOrder(page, api);
    await page.locator('input[type="file"]').setInputFiles(SLIP);
    const progress = page.getByRole('dialog');
    api.amountMismatch();
    await expect(progress.getByText(tr('liff.slipProgress.mismatchTitle'))).toBeVisible({
      timeout: 20_000,
    });
    await progress.getByRole('button', { name: tr('liff.close') }).click();
    await expect(page.getByText(tr('liff.slipStatus.amountMismatch'))).toBeVisible();

    api.verifiedWaiting();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText(tr('liff.slipStatus.verifiedWaiting'))).toBeVisible();
    await expect(page.getByText(tr('liff.order.paid'))).toHaveCount(0);
    await expectNoSideScroll(page);
  });
});
