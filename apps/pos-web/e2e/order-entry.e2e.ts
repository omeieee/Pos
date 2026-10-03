import { formatBaht } from '@sds/i18n';
import { addDish, expect, openCart, ringOrder, signInWithPin, test, tr } from './support.ts';

const baht = (satang: number) => formatBaht(satang, 'th');

test.describe('order entry (S1)', () => {
  test('a dish with required choices needs them, then the order shows the server total', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');

    // The options sheet keeps the add button off until the required groups are chosen.
    await page
      .locator('.dishes')
      .getByRole('button', { name: /^ก๋วยเตี๋ยวต้มยำ/ })
      .click();
    const sheet = page.getByRole('dialog');
    const add = sheet.getByRole('button', { name: /^เพิ่ม ·/ });
    await expect(add).toBeDisabled();
    await expect(sheet.getByRole('status')).toContainText('เส้น');
    // A sold-out option cannot be chosen.
    await expect(sheet.getByRole('radio', { name: /วุ้นเส้น/ })).toBeDisabled();
    await sheet.getByRole('button', { name: tr('common.close') }).click();
    await expect(sheet).toHaveCount(0);

    // Two bowls with a paid extra: (฿50 + ฿10) x 2.
    await addDish(page, {
      dish: 'ก๋วยเตี๋ยวต้มยำ',
      options: ['เส้นเล็ก', 'เผ็ดน้อย', 'ไข่ต้ม'],
      qty: 2,
    });
    const cart = await openCart(page);
    await expect(cart.getByText('เส้นเล็ก · เผ็ดน้อย · ไข่ต้ม')).toBeVisible();
    // The cart's figure is an estimate and is labelled as one.
    await expect(cart.locator('.sumrow.total')).toContainText(tr('pos.orderEntry.estimate'));
    await expect(cart.locator('.sumrow.total')).toContainText(baht(12000));
    // Placing needs the delivery details.
    const place = cart.getByRole('button', { name: tr('pos.orderEntry.place'), exact: true });
    await expect(place).toBeDisabled();
    await cart.locator('label.bld__item', { hasText: 'B1' }).click();
    await cart.getByLabel(tr('pos.delivery.name')).fill('คุณทดสอบ');
    await expect(place).toBeEnabled();
    await place.click();

    // The order page shows the number and the total the SERVER priced.
    await expect(page.getByRole('heading', { level: 1, name: /^ออเดอร์ S-\d+/ })).toBeVisible();
    await expect(page.locator('.odetail__total')).toContainText(tr('order.detail.serverTotal'));
    await expect(page.locator('.odetail__total')).toContainText(baht(12000));
    await expect(page.locator('.odetail__lines')).toContainText('เส้นเล็ก · เผ็ดน้อย · ไข่ต้ม');
    await expect(page.locator('.odetail__to')).toContainText('B1 · คุณทดสอบ');
  });

  test('a sold-out dish cannot be added', async ({ page }) => {
    await signInWithPin(page, 'manager');
    const sold = page.locator('.dishes').getByRole('button', { name: /^ต้มยำทะเลรวมมิตร/ });
    await expect(sold).toBeDisabled();
    await expect(sold).toContainText(tr('pos.orderEntry.soldOut'));
  });

  test('search and category chips narrow the menu', async ({ page }) => {
    await signInWithPin(page, 'manager');
    const dishes = page.locator('.dishes > li');
    await expect(dishes).toHaveCount(10);
    await page.getByRole('button', { name: /^เครื่องดื่ม/ }).click();
    await expect(dishes).toHaveCount(3);
    await page.getByRole('button', { name: /^ทั้งหมด/ }).click();
    await page.getByRole('searchbox', { name: tr('common.search') }).fill('ชาเย็น');
    await expect(dishes).toHaveCount(1);
  });

  // The owner's real criterion is the timing on the iPad; this is only a smoke check that the
  // flow itself (menu, options, delivery, create, order page) has no step that stalls.
  test('smoke: a full order with options is entered within 20 s', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    const started = Date.now();
    await ringOrder(page, {
      dish: 'ก๋วยเตี๋ยวต้มยำ',
      options: ['เส้นเล็ก', 'เผ็ดน้อย', 'ไข่ต้ม'],
    });
    const seconds = (Date.now() - started) / 1000;
    expect(seconds, `took ${seconds.toFixed(1)} s`).toBeLessThan(20);
  });
});
