import {
  expect,
  openPage,
  ringOrder,
  signInWithPin,
  simulateIncomingOrder,
  test,
  tr,
} from './support.ts';

test.describe('kitchen view', () => {
  test('a kitchen role lands on the kitchen and sees only what it may use', async ({ page }) => {
    await signInWithPin(page, 'kitchen');
    await expect(page.getByRole('heading', { level: 1, name: tr('kitchen.title') })).toBeVisible();
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    // No order entry, no settings for the kitchen; the order list stays.
    const nav = page.getByRole('navigation', { name: tr('nav.label') });
    await expect(nav.locator('a[href="#/new"]')).toHaveCount(0);
    await expect(nav.locator('a[href="#/settings"]')).toHaveCount(0);
    await expect(nav.locator('a[href="#/kitchen"]')).toBeVisible();
  });

  test('a new order from another device appears, is started and handed to ready', async ({
    page,
  }) => {
    await signInWithPin(page, 'kitchen');
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    // The mock stands in for a second device sending an order (realtime frame).
    await simulateIncomingOrder(page);
    const ticket = page.getByRole('article', { name: /^[A-Z]+-\d+$/ });
    await expect(ticket).toHaveCount(1);
    await expect(ticket).toContainText(tr('status.order.new'));
    await expect(ticket).toContainText('ก๋วยเตี๋ยวต้มยำ');

    // Start it, then mark it ready: it moves to the "ready, waiting for hand-over" list.
    await ticket.getByRole('button', { name: tr('order.move.preparing'), exact: true }).click();
    await expect(ticket).toContainText(tr('status.order.preparing'));
    await ticket.getByRole('button', { name: tr('order.move.ready'), exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    await page.getByRole('button', { name: tr('kitchen.ready.toggle', { count: 1 }) }).click();
    await expect(page.locator('#kready-list li')).toHaveCount(1);
  });

  test('an order rung at the counter reaches the kitchen view by the same store', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    const orderNo = await ringOrder(page, { dish: 'ชาเย็น' });
    await openPage(page, '/kitchen');
    await expect(page.getByRole('article', { name: orderNo })).toBeVisible();
  });

  test('the sound control turns on after a tap (audio is unlocked by a tap, not on load)', async ({
    page,
  }) => {
    await signInWithPin(page, 'kitchen');
    const sound = page.getByRole('group', { name: tr('kitchen.sound.label') });
    // Some engines (Playwright's WebKit build on Windows) have no Web Audio at all: the control
    // must then say so instead of pretending, and that is what is checked there.
    const hasAudio = await page.evaluate(
      () => 'AudioContext' in window || 'webkitAudioContext' in window,
    );
    if (!hasAudio) {
      await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.unsupported'));
      await expect(sound.getByRole('button', { name: tr('kitchen.sound.turnOn') })).toHaveCount(0);
      return;
    }
    await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.off'));
    await sound.getByRole('button', { name: tr('kitchen.sound.turnOn') }).click();
    await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.on'));
  });
});
