import type { Page } from '@playwright/test';
import {
  expect,
  openPage,
  ringOrder,
  STAFF,
  signInWithPin,
  simulateIncomingOrder,
  tapPin,
  test,
  tr,
} from './support.ts';

/**
 * The kitchen role lands on the kitchen board, which draws no navigation of its own, so the
 * shared sign-in (which waits for the navigation) does not fit: wait for the board instead.
 */
async function signInAsKitchen(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(STAFF.kitchen.name) }).click();
  await tapPin(page, STAFF.kitchen.pin);
  await expect(page.getByRole('heading', { level: 1, name: tr('kitchen.title') })).toBeVisible();
}

const column = (page: Page, id: 'new' | 'cooking' | 'ready') =>
  page.getByRole('region', { name: tr(`kitchen.col.${id}`), exact: true });

test.describe('kitchen view', () => {
  test('a kitchen role lands on the dark board, with a way back and no navigation', async ({
    page,
  }) => {
    await signInAsKitchen(page);
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    // The three columns of the design, and the 8-minute rule in words.
    for (const id of ['new', 'cooking', 'ready'] as const) {
      await expect(column(page, id)).toBeVisible();
    }
    await expect(page.getByText(tr('kitchen.subtitle', { minutes: 8 }))).toBeVisible();
    // No navigation on this page; the way back is the button in the header, to the order list.
    await expect(page.getByRole('navigation', { name: tr('nav.label') })).toHaveCount(0);
    await expect(page.getByRole('link', { name: tr('common.back') })).toHaveAttribute(
      'href',
      '#/orders',
    );
  });

  test('the kitchen board has a way to sign out, from its own header', async ({ page }) => {
    await signInAsKitchen(page);
    await page.getByRole('button', { name: new RegExp(STAFF.kitchen.name) }).click();
    const menu = page.getByRole('button', { name: tr('shell.signOut'), exact: true });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByRole('button', { name: new RegExp(STAFF.kitchen.name) })).toBeVisible();
  });

  test('a new order from another device appears, is started and handed to ready', async ({
    page,
  }) => {
    await signInAsKitchen(page);
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    // The mock stands in for a second device sending an order (realtime frame).
    await simulateIncomingOrder(page);
    const ticket = page.getByRole('article', { name: /^[A-Z]+-\d+$/ });
    await expect(ticket).toHaveCount(1);
    await expect(column(page, 'new').getByRole('article')).toHaveCount(1);
    await expect(ticket).toContainText('ก๋วยเตี๋ยวต้มยำ');

    // Start it: it moves to the cooking column. Mark it done: it moves to the ready column.
    await ticket.getByRole('button', { name: tr('order.move.preparing'), exact: true }).click();
    await expect(column(page, 'cooking').getByRole('article')).toHaveCount(1);
    await ticket.getByRole('button', { name: tr('kitchen.move.ready'), exact: true }).click();
    await expect(column(page, 'ready').getByRole('article')).toHaveCount(1);
    await expect(column(page, 'cooking').getByRole('article')).toHaveCount(0);
    await expect(page.getByText(tr('kitchen.empty'))).toBeVisible();
    // Nothing more to tap on a ticket that waits for hand-over.
    await expect(column(page, 'ready').getByRole('button')).toHaveCount(0);
  });

  test('an order rung at the counter reaches the kitchen board by the same store', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    const orderNo = await ringOrder(page, { dish: 'ชาเย็น' });
    await openPage(page, '/kitchen');
    await expect(page.getByRole('article', { name: orderNo })).toBeVisible();
  });

  test('the sound switch turns on after a tap (audio is unlocked by a tap, not on load)', async ({
    page,
  }) => {
    await signInAsKitchen(page);
    const sound = page.getByRole('group', { name: tr('kitchen.sound.label') });
    const toggle = sound.getByRole('switch', { name: tr('kitchen.sound.short') });
    // Some engines (Playwright's WebKit build on Windows) have no Web Audio at all: the control
    // must then say so instead of pretending, and that is what is checked there.
    const hasAudio = await page.evaluate(
      () => 'AudioContext' in window || 'webkitAudioContext' in window,
    );
    if (!hasAudio) {
      await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.unsupported'));
      await expect(toggle).toBeDisabled();
      return;
    }
    await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.off'));
    await toggle.click();
    await expect(sound.getByRole('status')).toHaveText(tr('kitchen.sound.state.on'));
    await expect(toggle).toBeChecked();
  });

  test('on a phone the columns slide sideways and the chips jump to one', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1000) > 719, 'the phone layout only');
    await signInAsKitchen(page);
    const chips = page.getByRole('navigation', { name: tr('kitchen.columns') });
    await expect(chips.getByRole('button')).toHaveCount(3);
    await simulateIncomingOrder(page);
    await expect(column(page, 'new').getByRole('article')).toHaveCount(1);
    await chips.getByRole('button', { name: new RegExp(tr('kitchen.col.cooking')) }).click();
    await expect(
      chips.getByRole('button', { name: new RegExp(tr('kitchen.col.cooking')) }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
