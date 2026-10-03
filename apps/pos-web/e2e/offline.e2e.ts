import { formatBaht } from '@sds/i18n';
import {
  addDish,
  expect,
  netBadge,
  openCart,
  openPage,
  setMockNetwork,
  signInWithPin,
  test,
  tr,
} from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');

type Page = import('@playwright/test').Page;

/** Saves an order on this device while offline; returns the temporary label shown on its page. */
async function ringOfflineOrder(page: Page, dishName: string, recipient: string) {
  await addDish(page, { dish: dishName });
  const cart = await openCart(page);
  await cart.locator('label.bld__item', { hasText: 'A2' }).click();
  await cart.getByLabel(tr('pos.delivery.name')).fill(recipient);
  await cart.getByRole('button', { name: tr('pos.orderEntry.placeOffline'), exact: true }).click();
  const heading = page.getByRole('heading', { level: 1, name: /^ออเดอร์ / });
  await expect(page.getByText(tr('outbox.order.notYet'))).toBeVisible();
  return ((await heading.textContent()) ?? '').trim();
}

const waitingBadge = (page: Page) => page.locator('a.qbadge');

test.describe('offline outbox (exit criterion 5)', () => {
  test('orders and payments taken offline sync once, with no duplicates, after reconnecting', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await expect(netBadge(page, 'online')).toBeVisible();
    // The menu has to have been loaded once before the line goes.
    await expect(page.locator('.dishes')).toBeVisible();

    // The internet goes. (The mock answers inside the page, so its own switch is the one that
    // behaves like a lost connection; the browser's offline mode would not reach it.)
    await setMockNetwork(page, false);
    await expect(netBadge(page, 'offline')).toBeVisible();

    // Order 1, saved here, paid in cash. The cash is the ESTIMATE's, waiting for the server.
    const first = await ringOfflineOrder(page, 'ชาเย็น', 'คุณออฟไลน์หนึ่ง');
    await expect(waitingBadge(page)).toContainText(tr('outbox.badge.waiting', { count: 1 }));
    await expect(page.locator('.odetail__total')).toContainText(baht(2500));
    const panel = page.getByRole('region', { name: tr('payment.title'), exact: true });
    await panel.getByRole('button', { name: tr('payment.cash.exact'), exact: true }).click();
    await panel.getByRole('button', { name: tr('outbox.cash.confirm') }).click();
    await expect(panel).toContainText(tr('outbox.cash.waiting'));
    await expect(waitingBadge(page)).toContainText(tr('outbox.badge.waiting', { count: 2 }));
    // Nothing is shown as paid until the server says so.
    await expect(panel.getByText(tr('payment.paid.title'))).toHaveCount(0);

    // Order 2, paid with the PromptPay QR drawn on this device from the saved ID.
    await openPage(page, '/new');
    const second = await ringOfflineOrder(page, 'น้ำเก๊กฮวย', 'คุณออฟไลน์สอง');
    expect(second).not.toBe(first);
    const panel2 = page.getByRole('region', { name: tr('payment.title'), exact: true });
    await panel2.locator('label.method', { hasText: tr('payment.method.promptpay') }).click();
    await expect(
      panel2.getByRole('img', { name: tr('payment.offlineQr.alt', { amount: baht(2000) }) }),
    ).toBeVisible();
    await panel2.getByRole('button', { name: tr('payment.offlineQr.confirm') }).click();
    await expect(waitingBadge(page)).toContainText(tr('outbox.badge.waiting', { count: 4 }));

    // The orders list shows both waiting entries (and nothing is on the board yet).
    await openPage(page, '/orders');
    await expect(page.getByText(tr('outbox.section.title'))).toBeVisible();

    // The internet is back: everything is sent and the badge clears.
    await setMockNetwork(page, true);
    await expect(netBadge(page, 'online')).toBeVisible();
    await expect(waitingBadge(page)).toHaveCount(0);

    // Exactly one real order per saved order, each paid.
    await page.getByRole('radio', { name: tr('orders.filter.all') }).check({ force: true });
    const board = page.locator('main');
    const links = board.getByRole('link', { name: /^หน้าร้าน S-\d+/ });
    await expect(links).toHaveCount(2);
    await expect(links.filter({ hasText: baht(2500) })).toHaveCount(1);
    await expect(links.filter({ hasText: baht(2000) })).toHaveCount(1);
    await expect(links.filter({ hasText: tr('status.payment.paid') })).toHaveCount(2);

    // The connection drops and returns again: still two orders, nothing sent twice.
    await setMockNetwork(page, false);
    await expect(netBadge(page, 'offline')).toBeVisible();
    await setMockNetwork(page, true);
    await expect(netBadge(page, 'online')).toBeVisible();
    await expect(waitingBadge(page)).toHaveCount(0);
    await expect(links).toHaveCount(2);
  });

  test('offline shows a clear connection state, and the menu stays usable', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    // The menu has to have been loaded once before the line goes (a never-loaded menu says so).
    await expect(page.locator('.dishes')).toBeVisible();
    await setMockNetwork(page, false);
    await expect(netBadge(page, 'offline')).toBeVisible();
    // The saved menu is still there to order from, and the cart says where the order goes.
    await addDish(page, { dish: 'ชาเย็น' });
    const cart = await openCart(page);
    await expect(cart.getByText(tr('pos.orderEntry.offlineHint'))).toBeVisible();
    await setMockNetwork(page, true);
    await expect(netBadge(page, 'online')).toBeVisible();
  });
});
