import type { Page } from '@playwright/test';
import { formatBaht } from '@sds/i18n';
import { expect, openPage, signInWithPin, test, tr } from './support.ts';

/** The menu editor is a row of the Settings page (the navigation has no link of its own). */
async function openMenuEditor(page: Page) {
  await openPage(page, '/settings');
  await page.locator('main a[href="#/settings/menu"]').click();
}

const baht = (satang: number) => formatBaht(satang, 'th');
const NEW_DISH = 'ผัดซีอิ๊วทดสอบ';

test.describe('menu editor (M1)', () => {
  test('a manager creates a dish, changes its price and marks it sold out; the till follows', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await openMenuEditor(page);
    await expect(
      page.getByRole('heading', { level: 1, name: tr('menuEditor.title') }),
    ).toBeVisible();

    // Create: name, category, price.
    await page.getByRole('button', { name: tr('menuEditor.add.item') }).click();
    const dialog = page.getByRole('dialog', { name: tr('menuEditor.dialog.item.new') });
    const save = dialog.getByRole('button', { name: tr('common.save'), exact: true });
    await dialog.getByLabel(tr('menuEditor.field.nameTh'), { exact: true }).fill(NEW_DISH);
    await dialog
      .getByLabel(tr('menuEditor.category.pick'), { exact: true })
      .selectOption({ label: 'ของทานเล่น' });
    await dialog.getByLabel(tr('menuEditor.field.price'), { exact: true }).fill('45');
    await save.click();
    await expect(dialog).toHaveCount(0);

    // It is listed in its category with its price.
    await page.getByRole('button', { name: 'ของทานเล่น', exact: true }).click();
    const row = page.locator('main li').filter({ hasText: NEW_DISH });
    await expect(row).toContainText(baht(4500).replace('.00', ''));

    // Price edit.
    await row.getByRole('button', { name: tr('menuEditor.edit.for', { name: NEW_DISH }) }).click();
    const edit = page.getByRole('dialog', { name: tr('menuEditor.dialog.item.edit') });
    await edit.getByLabel(tr('menuEditor.field.price'), { exact: true }).fill('50');
    await edit.getByRole('button', { name: tr('common.save'), exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText(baht(5000).replace('.00', ''));

    // The order-entry page shows the new dish at the new price.
    await openPage(page, '/new');
    const dish = page.locator('main').getByRole('button', { name: new RegExp(`^${NEW_DISH}`) });
    await expect(dish).toContainText(baht(5000).replace('.00', ''));
    await expect(dish).toBeEnabled();

    // Sold out from the editor: the dish is dimmed and cannot be added.
    await openMenuEditor(page);
    await page.getByRole('button', { name: 'ของทานเล่น', exact: true }).click();
    const soldSwitch = page.getByRole('switch', {
      name: tr('menuEditor.soldOut.for', { name: NEW_DISH }),
    });
    await soldSwitch.click();
    await expect(soldSwitch).toBeChecked();
    await openPage(page, '/new');
    await expect(dish).toBeDisabled();
    await expect(dish).toContainText(tr('pos.orderEntry.soldOut'));
  });

  test('a cashier has no menu editor', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await openPage(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: tr('settings.title') })).toBeVisible();
    await expect(page.locator('main a[href="#/settings/menu"]')).toHaveCount(0);
  });
});
