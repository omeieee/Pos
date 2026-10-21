import type { Page } from '@playwright/test';
import { expect, openPage, ringOrder, signInWithPin, test, tr } from './support.ts';

const orderHash = (page: Page) => new URL(page.url()).hash.slice(1);
const reprint = (page: Page) =>
  page.getByRole('button', { name: tr('print.reprint.button'), exact: true });

test.describe('kitchen printing (P8)', () => {
  test('a manager reprints an order: refused while printing is off, then sent once it is on, and the job list shows it', async ({
    page,
  }) => {
    await signInWithPin(page, 'manager');
    await ringOrder(page, { dish: 'ชาเย็น' });
    const orderPage = orderHash(page);

    // Printing is off by default: the server's refusal is explained in plain Thai.
    await reprint(page).click();
    await expect(
      page.getByRole('alert').filter({ hasText: tr('error.printingOff') }),
    ).toBeVisible();

    // The Printing section: off, with the explanation; switch it on and save.
    await openPage(page, '/settings');
    await page.locator('main a[href="#/settings/printing"]').click();
    await expect(
      page.getByRole('heading', { level: 1, name: tr('settings.printing.title') }),
    ).toBeVisible();
    await expect(page.getByText(tr('settings.printing.stateOff'))).toBeVisible();
    await expect(page.getByText(tr('settings.printing.explainShutdown'))).toBeVisible();
    await page.getByRole('checkbox', { name: tr('settings.printing.switch') }).check();
    await page.getByRole('button', { name: tr('common.save'), exact: true }).click();
    await expect(page.getByText(tr('settings.saved'))).toBeVisible();
    await expect(page.getByText(tr('settings.printing.stateOn'))).toBeVisible();

    // The list already holds earlier jobs of the dev shop, one of them failed with a reason.
    const jobs = page.getByRole('list', { name: tr('settings.printing.jobs.listLabel') });
    await expect(jobs.getByText(tr('settings.printing.jobs.status.printed'))).toBeVisible();
    await expect(jobs.getByText(tr('settings.printing.jobs.status.failed'))).toBeVisible();
    await expect(jobs).toContainText(tr('settings.printing.jobs.error.OUT_OF_PAPER'));

    // Back on the order: one tap makes one reprint.
    await openPage(page, orderPage);
    await reprint(page).click();
    await expect(page.getByText(tr('print.reprint.done', { seq: 1 }))).toBeVisible();

    // The new job waits for the print notebook, at the top of the list.
    await openPage(page, '/settings/printing');
    const waiting = page
      .getByRole('list', { name: tr('settings.printing.jobs.listLabel') })
      .getByRole('listitem')
      .first();
    await expect(waiting).toContainText(tr('settings.printing.jobs.status.pending'));
    await expect(waiting).toContainText(tr('settings.printing.jobs.kind.reprint', { seq: 1 }));
  });

  test('a cashier can reprint but has no Printing section', async ({ page }) => {
    await signInWithPin(page, 'cashier');
    await ringOrder(page, { dish: 'ชาเย็น' });
    await expect(reprint(page)).toBeVisible();
    await openPage(page, '/settings');
    await expect(page.locator('main a[href="#/settings/shop"]')).toBeVisible();
    await expect(page.locator('main a[href="#/settings/printing"]')).toHaveCount(0);
  });
});
