import type { Locator } from '@playwright/test';
import { expect, openPage, signInWithPin, test, tr } from './support.ts';

/** A 1x1 PNG: a real picture, so the viewer's <img> decodes it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const photo = { name: 'bill.png', mimeType: 'image/png', buffer: PNG };

/** The dialog may open before the category list has arrived: wait for it, then pick the first. */
async function chooseCategory(dialog: Locator) {
  const select = dialog.getByLabel(tr('exp.field.category'));
  await expect(select.locator('option')).not.toHaveCount(0);
  await select.selectOption({ index: 0 });
}

test.describe('expense receipt photos (P7, D-36)', () => {
  test('attach on a new expense, view it, remove it; nothing overflows sideways', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await openPage(page, '/expenses');
    await page.getByRole('button', { name: tr('exp.add') }).click();
    const dialog = page.getByRole('dialog');
    await chooseCategory(dialog);
    await dialog.getByLabel(tr('exp.field.amount')).fill('45');
    await dialog.locator('input[type="file"]').setInputFiles(photo);
    await expect(dialog.getByText(tr('exp.receipt.picked', { name: 'bill.png' }))).toBeVisible();
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await overflow()).toBe(false);
    await dialog.getByRole('button', { name: tr('common.save') }).click();
    await expect(dialog).toBeHidden();

    // The new row carries the receipt button.
    const view = page.getByRole('button', { name: /ดูรูปใบเสร็จ/ });
    await expect(view).toHaveCount(1);
    expect((await view.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await view.click();
    const image = page.getByRole('dialog').getByAltText(tr('exp.receipt.alt'));
    await expect(image).toBeVisible();
    expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await overflow()).toBe(false);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: tr('exp.receipt.close') })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Remove it from the edit dialog, after the question.
    await page.getByRole('button', { name: /^แก้ไข/ }).last().click();
    const edit = page.getByRole('dialog');
    await edit.getByRole('button', { name: tr('exp.receipt.remove') }).click();
    await edit.getByRole('button', { name: tr('exp.receipt.removeConfirm') }).click();
    await expect(edit.getByText(tr('exp.receipt.none'))).toBeVisible();
    await edit.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(page.getByRole('button', { name: /ดูรูปใบเสร็จ/ })).toHaveCount(0);
  });

  test('photo storage not set up: a calm message, and the expense is still saved', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await openPage(page, '/expenses');
    await page.evaluate(() =>
      (
        globalThis as unknown as { __sdsMock: { setReceiptStorage(on: boolean): void } }
      ).__sdsMock.setReceiptStorage(false),
    );
    await page.getByRole('button', { name: tr('exp.add') }).click();
    const dialog = page.getByRole('dialog');
    await chooseCategory(dialog);
    await dialog.getByLabel(tr('exp.field.amount')).fill('33');
    await dialog.locator('input[type="file"]').setInputFiles(photo);
    await dialog.getByRole('button', { name: tr('common.save') }).click();
    await expect(
      dialog.getByText(
        tr('exp.receipt.attachFailed', { reason: tr('error.expenseReceiptStorage') }),
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await dialog.getByRole('button', { name: tr('common.cancel') }).click();
    await expect(page.getByText('฿33.00').first()).toBeVisible();
  });
});
