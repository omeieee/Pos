// @vitest-environment jsdom
import { catalogs, formatBaht, translator } from '@sds/i18n';
import { type CashReport, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../../api/client.ts';
import { ApiClientError } from '../../api/errors.ts';
import { createMockFinance } from '../../dev/mock-finance.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { CashScreen } from './CashScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const money = (n: number) => formatBaht(n, 'th');
const NOW = '2030-10-15T05:00:00Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const answer = (report: CashReport) => async () => report;
const NOT_SET = { value: { amountSatang: null, asOf: null }, version: 0, rev: 0, updatedAt: null };

async function open(
  cash: CashReport | (() => Promise<CashReport>),
  overrides: {
    cashOpening?: Partial<ApiClient['settings']['cashOpening']>;
    exportCsv?: ReturnType<typeof vi.fn>;
    fresh?: boolean;
  } = {},
) {
  const { auth } = await createTestAuth('owner');
  if (overrides.fresh !== false) {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({
    auth,
    reports: {
      cash: vi.fn(typeof cash === 'function' ? cash : answer(cash)),
      ...(overrides.exportCsv ? { exportCsv: overrides.exportCsv as never } : {}),
    },
    cashOpening: overrides.cashOpening ?? { read: async () => NOT_SET },
  });
  renderScreen(<CashScreen />, env.services);
  await screen.findByText(th['cash.summary.title']);
  return env;
}

/** A real-shaped answer: the dev mock's, which the shared schema accepts (its own tests pin the figures). */
function report(
  opening?: { amountSatang: number; asOf: string },
  range = { from: '2026-09-24', to: '2026-10-07' },
): CashReport {
  const mock = createMockFinance({ now: () => Date.parse(NOW) });
  if (opening) {
    mock.handle(
      'PATCH',
      '/v1/settings/cash-opening',
      new URLSearchParams(),
      { expectedVersion: 0, ...opening },
      { role: 'owner', stepUpFresh: true },
    );
  }
  return mock.handle('GET', '/v1/reports/cash', new URLSearchParams(range), undefined, {
    role: 'owner',
  })?.body as CashReport;
}

describe('the figures', () => {
  test('asks for the month so far and shows the server figures formatted, not recomputed', async () => {
    const env = await open(report());
    expect(env.api.reports.cash).toHaveBeenCalledWith(
      { from: '2030-10-01', to: '2030-10-15' },
      { emptyDays: false },
    );
    const table = screen.getByRole('table', { name: th['cash.table'] });
    // 24 Sep: cash 130.00, goods 150.00
    const row = within(table).getByText('24 ก.ย. 2569').closest('tr') as HTMLElement;
    expect(within(row).getAllByText(money(13000)).length).toBeGreaterThan(0);
    expect(within(row).getAllByText(money(15000))).toHaveLength(2); // goods and total paid
    // total row: receipts 685.00, payments 375.00
    const total = within(table).getByText(th['cash.total']).closest('tr') as HTMLElement;
    expect(within(total).getByText(money(68500))).toBeTruthy();
    expect(within(total).getByText(money(37500))).toBeTruthy();
  });

  test('the summary follows the Revenue Department form: receipts, payments split, and the difference', async () => {
    await open(report());
    const card = screen.getByText(th['cash.summary.title']).closest('.fin-card') as HTMLElement;
    expect(within(card).getByText(money(68500))).toBeTruthy();
    expect(
      within(card).getByText(
        tr('cash.summary.paymentsSplit', { goods: money(27000), other: money(10500) }),
      ),
    ).toBeTruthy();
    expect(within(card).getByText(money(31000))).toBeTruthy();
  });

  test('the receipts are tied to the revenue report in words', async () => {
    await open(report());
    expect(screen.getByText(tr('cash.reconcile.ok', { amount: money(68500) }))).toBeTruthy();
  });

  test('a mismatch with the revenue report is said loudly, with both figures', async () => {
    const r = report();
    await open({
      ...r,
      reconciliation: { revenueReportSatang: satang(68000), differenceSatang: satang(500) },
    });
    expect(
      screen.getByText(
        tr('cash.reconcile.bad', {
          amount: money(68500),
          revenue: money(68000),
          difference: money(500),
        }),
      ),
    ).toBeTruthy();
  });

  test('always says it is a working record, not a filed document, not a bank statement, and the assumptions', async () => {
    await open(report());
    expect(screen.getByText(th['cash.workingRecord'])).toBeTruthy();
    expect(screen.getByText(th['cash.assumptions'])).toBeTruthy();
    expect(screen.getByText(th['cash.notBank'])).toBeTruthy();
  });

  test('the shop has no cash drawer: no wording in the page promises a drawer or a cash balance', () => {
    for (const catalog of [catalogs.th, catalogs.en]) {
      for (const [key, text] of Object.entries(catalog)) {
        if (!key.startsWith('cash.') && key !== 'nav.cash' && key !== 'settings.link.cash.desc')
          continue;
        expect(text, key).not.toMatch(/ลิ้นชัก|เงินสดคงเหลือ|drawer|cash balance/i);
      }
    }
  });

  test('a period with nothing says so', async () => {
    const r = report(undefined, { from: '2030-01-01', to: '2030-01-02' });
    await open(r);
    expect(screen.getByText(th['cash.empty'])).toBeTruthy();
    expect(screen.queryByRole('table', { name: th['cash.table'] })).toBeNull();
  });

  test('orders set aside as inconsistent are a warning', async () => {
    await open({ ...report(), complete: false, excludedOrderIds: ['a', 'b'] });
    expect(screen.getByText(tr('cash.incomplete', { count: 2 }))).toBeTruthy();
  });

  test('a failed read is told, with a retry that reads again', async () => {
    let first = true;
    const cash = vi.fn(async () => {
      if (first) {
        first = false;
        throw new ApiClientError('NETWORK');
      }
      return report();
    });
    const { auth } = await createTestAuth('owner');
    const env = createTestServices({
      auth,
      reports: { cash },
      cashOpening: { read: async () => NOT_SET },
    });
    renderScreen(<CashScreen />, env.services);
    fireEvent.click(await screen.findByRole('button', { name: th['common.retry'] }));
    await screen.findByText(th['cash.summary.title']);
    expect(cash).toHaveBeenCalledTimes(2);
  });
});

describe('the running net', () => {
  test('with no start amount there is no running net: the page says so and shows "none", never 0', async () => {
    await open(report());
    expect(screen.getByText(th['cash.opening.notSet'])).toBeTruthy();
    const card = screen.getByText(th['cash.summary.title']).closest('.fin-card') as HTMLElement;
    expect(within(card).getAllByText(th['cash.running.none']).length).toBe(2);
  });

  test('with a start amount, the start amount, the running start and end and a running net per day', async () => {
    const r = report({ amountSatang: 50000, asOf: '2026-09-24' });
    await open(r, {
      cashOpening: {
        read: async () => ({
          value: { amountSatang: satang(50000), asOf: '2026-09-24' },
          version: 1,
          rev: 1,
          updatedAt: NOW,
        }),
      },
    });
    expect(
      await screen.findByText(
        tr('cash.opening.value', { amount: money(50000), date: '24 ก.ย. 2569' }),
      ),
    ).toBeTruthy();
    const card = screen.getByText(th['cash.summary.title']).closest('.fin-card') as HTMLElement;
    expect(within(card).getByText(money(50000))).toBeTruthy(); // running net at the start
    expect(within(card).getByText(money(81000))).toBeTruthy(); // 500.00 + 685.00 - 375.00
    const table = screen.getByRole('table', { name: th['cash.table'] });
    expect(within(table).getAllByText(money(48000)).length).toBeGreaterThan(0); // after 24 Sep
  });
});

describe('the start amount form', () => {
  test('saving asks for the step-up, sends whole satang with the version, and reads the report again', async () => {
    const save = vi.fn(async () => ({
      value: { amountSatang: satang(125075), asOf: '2026-09-24' },
      version: 1,
      rev: 1,
      updatedAt: NOW,
    }));
    const env = await open(report(), {
      cashOpening: { read: async () => NOT_SET, save },
    });
    fireEvent.click(await screen.findByRole('button', { name: th['cash.opening.edit'] }));
    fireEvent.change(screen.getByLabelText(th['cash.opening.amount']), {
      target: { value: '1,250.75' },
    });
    fireEvent.change(screen.getByLabelText(th['cash.opening.asOf']), {
      target: { value: '2026-09-24' },
    });
    fireEvent.click(screen.getByRole('button', { name: th['cash.opening.save'] }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      expectedVersion: 0,
      amountSatang: 125075,
      asOf: '2026-09-24',
    });
    expect(await screen.findByText(th['cash.opening.saved'])).toBeTruthy();
    await waitFor(() => expect(env.api.reports.cash).toHaveBeenCalledTimes(2));
  });

  test('a bad amount or a missing date is told and nothing is sent', async () => {
    const save = vi.fn();
    await open(report(), { cashOpening: { read: async () => NOT_SET, save } });
    fireEvent.click(await screen.findByRole('button', { name: th['cash.opening.edit'] }));
    fireEvent.change(screen.getByLabelText(th['cash.opening.amount']), {
      target: { value: '12.345' },
    });
    fireEvent.click(screen.getByRole('button', { name: th['cash.opening.save'] }));
    expect(await screen.findAllByText(th['cash.opening.invalid'])).not.toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  test('a refused save keeps the form and says why', async () => {
    const save = vi.fn(async () => {
      throw new ApiClientError('VERSION_CONFLICT', { status: 409 });
    });
    await open(report(), { cashOpening: { read: async () => NOT_SET, save } });
    fireEvent.click(await screen.findByRole('button', { name: th['cash.opening.edit'] }));
    fireEvent.change(screen.getByLabelText(th['cash.opening.amount']), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: th['cash.opening.save'] }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText(th['cash.opening.amount'])).toBeTruthy();
  });

  test('the opening can be cleared (both set to null) and the report is read again', async () => {
    const save = vi.fn(async () => NOT_SET);
    const env = await open(report({ amountSatang: 50000, asOf: '2026-09-24' }), {
      cashOpening: {
        read: async () => ({
          value: { amountSatang: satang(50000), asOf: '2026-09-24' },
          version: 2,
          rev: 2,
          updatedAt: NOW,
        }),
        save,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: th['cash.opening.clear'] }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ expectedVersion: 2, amountSatang: null, asOf: null }),
    );
    await waitFor(() => expect(env.api.reports.cash).toHaveBeenCalledTimes(2));
  });
});

describe('the options and the export', () => {
  test('"show days with no activity" asks the server for them', async () => {
    const env = await open(report());
    fireEvent.click(screen.getByRole('checkbox', { name: th['cash.emptyDays'] }));
    await waitFor(() =>
      expect(env.api.reports.cash).toHaveBeenLastCalledWith(
        { from: '2030-10-01', to: '2030-10-15' },
        { emptyDays: true },
      ),
    );
  });

  test('the period picker asks again for the new range', async () => {
    const env = await open(report());
    fireEvent.click(screen.getByRole('radio', { name: th['dash.range.today'] }));
    await waitFor(() =>
      expect(env.api.reports.cash).toHaveBeenLastCalledWith(
        { from: '2030-10-15', to: '2030-10-15' },
        { emptyDays: false },
      ),
    );
  });

  test('the export button saves the cash file for the period on screen, after the step-up', async () => {
    const exportCsv = vi.fn(async () => ({
      text: 'ไฟล์',
      filename: 'cash-2030-10-01-2030-10-15.csv',
    }));
    const env = await open(report(), { exportCsv });
    fireEvent.click(screen.getByRole('button', { name: th['cash.export'] }));
    await waitFor(() => expect(exportCsv).toHaveBeenCalledTimes(1));
    expect(exportCsv).toHaveBeenCalledWith('cash', { from: '2030-10-01', to: '2030-10-15' });
    expect(env.files.save).toHaveBeenCalledWith(
      'cash-2030-10-01-2030-10-15.csv',
      'text/csv',
      'ไฟล์',
    );
  });

  test('no dashboard files are offered here, only the cash one', async () => {
    await open(report());
    expect(screen.queryByRole('button', { name: th['dash.export.revenue'] })).toBeNull();
    expect(screen.queryByRole('button', { name: th['dash.export.items'] })).toBeNull();
  });
});
