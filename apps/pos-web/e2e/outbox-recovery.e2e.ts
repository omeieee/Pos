import { formatBaht } from '@sds/i18n';
import {
  addDish,
  expect,
  netBadge,
  OWNER_LOGIN,
  openAccount,
  openCart,
  openPage,
  paymentPanel,
  realOrders,
  STAFF,
  setMockNetwork,
  signInWithPin,
  tapPin,
  test,
  tr,
} from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');

type Page = import('@playwright/test').Page;

interface MockHooks {
  recoveries(): { action: string; orders: number; payments: number }[];
  attributions(): { requestId: string; original: string | null; creator: string | null }[];
}
const mock = <T>(page: Page, read: (hooks: MockHooks) => T) =>
  page.evaluate((source) => {
    const hooks = (globalThis as unknown as { __sdsMock: MockHooks }).__sdsMock;
    return new Function('hooks', `return (${source})(hooks)`)(hooks);
  }, read.toString()) as Promise<T>;

const counted = (page: Page) =>
  mock(page, (hooks) =>
    hooks.recoveries().map(({ action, orders, payments }) => ({ action, orders, payments })),
  );

/**
 * The cashier rings an order and takes the cash with no internet, then signs out still offline: the
 * entries stay on the device, theirs. Then the internet is back and the owner signs in on the same
 * device (the same page: the dev mock lives in it, so there is no reload).
 */
async function strandedByCashier(page: Page) {
  await signInWithPin(page, 'cashier');
  await expect(netBadge(page, 'online')).toBeVisible();
  await expect(page.locator('button.g-tile').first()).toBeVisible();
  await setMockNetwork(page, false);
  await expect(netBadge(page, 'offline')).toBeVisible();

  await addDish(page, { dish: 'ชาเย็น' });
  const cart = await openCart(page);
  await cart.locator('label.g-chip', { hasText: 'A2' }).click();
  await cart.getByLabel(tr('pos.delivery.name')).fill('คุณออฟไลน์');
  await cart.getByRole('button', { name: tr('pos.orderEntry.placeOffline'), exact: true }).click();
  await expect(page.getByText(tr('outbox.order.notYet'))).toBeVisible();
  const panel = paymentPanel(page);
  await panel.getByRole('button', { name: tr('payment.cash.exact'), exact: true }).click();
  await panel.getByRole('button', { name: tr('outbox.cash.confirm') }).click();
  await expect(panel).toContainText(tr('outbox.cash.waiting'));
  await expect(page.locator('a.qbadge')).toContainText(tr('outbox.badge.waiting', { count: 2 }));

  // Signing out with entries waiting asks first; they stay on the device, the cashier's.
  const account = await openAccount(page);
  await account.getByRole('button', { name: tr('shell.signOut'), exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: tr('shell.signOut.confirm'), exact: true })
    .click();
  await setMockNetwork(page, true);

  // The staff tiles were asked for while the line was down: ask again if they did not load.
  const ownerTile = page.getByRole('button', { name: new RegExp(STAFF.owner.name) });
  const retry = page.getByRole('button', { name: tr('common.retry'), exact: true });
  await expect(ownerTile.or(retry)).toBeVisible();
  if (await retry.isVisible()) await retry.click();
  await ownerTile.click();
  await tapPin(page, STAFF.owner.pin);
  await expect(netBadge(page, 'online')).toBeVisible();
  await openPage(page, '/orders');
}

async function confirmWithStepUp(page: Page, action: 'takeOver' | 'clear') {
  await page.getByRole('button', { name: tr(`outbox.others.${action}`), exact: true }).click();
  const question = page.getByRole('dialog');
  await expect(question).toContainText(tr(`outbox.others.${action}.title`, { count: 2 }));
  await question.getByRole('button', { name: tr(`outbox.others.${action}.confirm`) }).click();
  // The owner proves who they are first; nothing is written to the server before that.
  const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
  await expect(stepUp).toBeVisible();
  expect(await mock(page, (hooks) => hooks.recoveries().length)).toBe(0);
  await stepUp.getByLabel(tr('auth.owner.password'), { exact: true }).fill(OWNER_LOGIN.password);
  await stepUp.getByLabel(tr('auth.owner.code'), { exact: true }).fill(OWNER_LOGIN.codes[0]);
  await stepUp.getByRole('button', { name: tr('auth.stepUp.submit') }).click();
}

test.describe('the owner and the entries a cashier left on the device', () => {
  test('take over: the server is told once, then the order and the cash sync once, naming the cashier', async ({
    page,
  }) => {
    await strandedByCashier(page);
    // Nobody but a count of the cashier's entries is shown to the owner until they take them over.
    await expect(page.getByText(tr('outbox.others', { count: 2 }))).toBeVisible();
    await confirmWithStepUp(page, 'takeOver');

    await expect(page.getByText(tr('outbox.others.done.takeOver', { count: 2 }))).toBeVisible();
    await expect(page.locator('a.qbadge')).toHaveCount(0);

    // Exactly one real order, paid in cash, and nothing waiting on the device any more.
    await page.getByRole('radio', { name: tr('orders.filter.all') }).check({ force: true });
    const links = realOrders(page);
    await expect(links).toHaveCount(1);
    await expect(links).toContainText(baht(2500));
    await expect(links).toContainText(tr('status.payment.paid'));

    // The server heard about it once, with counts only, and both rows name who rang them up.
    expect(await counted(page)).toEqual([{ action: 'take_over', orders: 1, payments: 1 }]);
    const trail = await mock(page, (hooks) => hooks.attributions());
    expect(trail).toHaveLength(2);
    for (const row of trail) {
      expect(row.original).not.toBeNull();
      expect(row.creator).not.toBeNull();
      expect(row.original).not.toBe(row.creator);
    }
    expect(new Set(trail.map((row) => row.original)).size).toBe(1);
  });

  test('clear: the server is told, the cashier’s entries are deleted and nothing reaches the board', async ({
    page,
  }) => {
    await strandedByCashier(page);
    await confirmWithStepUp(page, 'clear');
    await expect(page.getByText(tr('outbox.others.done.clear', { count: 2 }))).toBeVisible();
    expect(await counted(page)).toEqual([{ action: 'clear', orders: 1, payments: 1 }]);
    await page.getByRole('radio', { name: tr('orders.filter.all') }).check({ force: true });
    await expect(realOrders(page)).toHaveCount(0);
    expect(await mock(page, (hooks) => hooks.attributions())).toEqual([]);
  });

  test('cancelling the step-up says why nothing happened and changes nothing', async ({ page }) => {
    await strandedByCashier(page);
    await page.getByRole('button', { name: tr('outbox.others.takeOver'), exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('outbox.others.takeOver.confirm') })
      .click();
    const stepUp = page.getByRole('dialog', { name: tr('auth.stepUp.title') });
    await stepUp.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(stepUp).toHaveCount(0);
    await expect(page.getByText(tr('error.ownerSignInNeeded'))).toBeVisible();
    await expect(page.getByText(tr('outbox.others', { count: 2 }))).toBeVisible();
    expect(await counted(page)).toEqual([]);
  });

  test('the sign-out question opens over the whole page, also from the rail', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await expect(netBadge(page, 'online')).toBeVisible();
    await expect(page.locator('button.g-tile').first()).toBeVisible();
    await setMockNetwork(page, false);
    await expect(netBadge(page, 'offline')).toBeVisible();
    await addDish(page, { dish: 'ชาเย็น' });
    const cart = await openCart(page);
    await cart.locator('label.g-chip', { hasText: 'A2' }).click();
    await cart.getByLabel(tr('pos.delivery.name')).fill('คุณออฟไลน์');
    await cart
      .getByRole('button', { name: tr('pos.orderEntry.placeOffline'), exact: true })
      .click();
    await expect(page.getByText(tr('outbox.order.notYet'))).toBeVisible();
    // The waiting order is in view on any page, not only on the order pages.
    await openPage(page, '/orders');
    // From the account menu of the page frame (the rail on an iPad), not from the Settings row.
    const account = page.locator(
      'nav button[aria-haspopup="true"], aside button[aria-haspopup="true"]',
    );
    if ((await account.count()) > 0) {
      await account.first().click();
      await page.getByRole('button', { name: tr('shell.signOut'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(tr('shell.signOut.queueTitle'));
      const box = await dialog.boundingBox();
      // A real dialog, not a sliver squeezed into the 96px rail.
      expect(box?.width ?? 0).toBeGreaterThan(300);
      await dialog.getByRole('button', { name: tr('shell.signOut.stay') }).click();
      await expect(dialog).toHaveCount(0);
    }
  });
});
