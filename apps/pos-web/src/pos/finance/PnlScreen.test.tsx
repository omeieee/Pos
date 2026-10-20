// @vitest-environment jsdom
import { catalogs, formatBaht, translator } from '@sds/i18n';
import { DEFAULT_EXPENSE_CATEGORIES, type PnlReport, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { SAMPLE_PNL } from '../../dev/mock-finance-data.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { PnlScreen } from './PnlScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const money = (n: number) => formatBaht(n, 'th');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMPLETE: PnlReport = {
  ...SAMPLE_PNL,
  complete: true,
  incompleteReasons: [],
  missing: {
    excludedOrderIds: [],
    uncostedOrderIds: [],
    uncostedMenuItemIds: [],
    rateNotSetOrderIds: [],
    ratesNotSet: [],
  },
  foodCostBasis: 'only_one',
  foodCostNotDeductedSatang: satang(0),
  platformFeesBasis: 'only_one',
  platformFeesNotDeductedSatang: satang(0),
};

async function open(
  pnl: PnlReport | (() => Promise<PnlReport>) = SAMPLE_PNL,
  categoriesFail = false,
) {
  const { auth } = await createTestAuth('owner');
  const env = createTestServices({
    auth,
    reports: { pnl: typeof pnl === 'function' ? pnl : async () => pnl },
    expenses: {
      categories: {
        read: categoriesFail
          ? async () => {
              throw new ApiClientError('NETWORK');
            }
          : async () => ({
              value: DEFAULT_EXPENSE_CATEGORIES,
              version: 0,
              rev: 0,
              updatedAt: null,
            }),
        save: async () => {
          throw new Error('not expected');
        },
      },
    },
  });
  renderScreen(<PnlScreen />, env.services);
  await screen.findByText(th['pnl.line.net']);
  return env;
}

const lines = () => screen.getByRole('group', { name: th['pnl.title'] });
const inLines = () => within(lines());

describe('the figures', () => {
  test('asks for the month so far and lays out the server figures, formatted and not recomputed', async () => {
    const env = await open();
    expect(env.api.reports.pnl).toHaveBeenCalledWith({ from: '2030-10-01', to: '2030-10-15' });
    for (const satang of [79500, 27100, 52400, 4550, 37500, 36850]) {
      expect(inLines().getByText(money(satang)), money(satang)).toBeTruthy();
    }
  });

  test('expenses are listed by category with the category names joined from the list', async () => {
    await open();
    expect(
      await inLines().findByText(tr('pnl.line.expenseRow', { name: 'วัตถุดิบ', count: 2 })),
    ).toBeTruthy();
    expect(inLines().getByText(money(25000))).toBeTruthy();
    expect(
      inLines().getByText(tr('pnl.line.expenseRow', { name: 'ค่าธรรมเนียมแพลตฟอร์ม', count: 1 })),
    ).toBeTruthy();
  });

  test('if the category names cannot be read, the keys are shown instead', async () => {
    await open(SAMPLE_PNL, true);
    expect(
      await inLines().findByText(tr('pnl.line.expenseRow', { name: 'gas', count: 1 })),
    ).toBeTruthy();
  });

  test('commission shows the recorded and the estimated part', async () => {
    await open();
    expect(
      inLines().getByText(tr('pnl.line.commissionRecorded', { amount: money(300) })),
    ).toBeTruthy();
    expect(
      inLines().getByText(tr('pnl.line.commissionEstimated', { amount: money(4250) })),
    ).toBeTruthy();
  });

  test('a loss is a minus sign and the word, not colour alone', async () => {
    await open({ ...COMPLETE, netProfitSatang: -5000 } as PnlReport);
    expect(inLines().getByText(money(-5000))).toBeTruthy();
    expect(inLines().getByText(th['pnl.loss'])).toBeTruthy();
  });

  test('a period with no sales says so', async () => {
    await open({ ...COMPLETE, orderCount: 0 } as PnlReport);
    expect(screen.getByText(th['pnl.empty'])).toBeTruthy();
  });

  test('says it is an estimate, not a tax return', async () => {
    await open();
    expect(screen.getByText(th['pnl.estimateNote'])).toBeTruthy();
  });
});

describe('the incomplete banner', () => {
  test('a complete answer has none', async () => {
    await open(COMPLETE);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(th['pnl.incomplete.title'])).toBeNull();
  });

  test('lists the reasons and the counts of what is missing, and warns the profit is only an upper bound', async () => {
    await open();
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(th['pnl.incomplete.title'])).toBeTruthy();
    expect(within(banner).getByText(th['pnl.incomplete.note'])).toBeTruthy();
    expect(within(banner).getByText(th['pnl.reason.orders_uncosted'])).toBeTruthy();
    expect(
      within(banner).getByText(tr('pnl.count.uncostedOrders', { count: 1, amount: money(6000) })),
    ).toBeTruthy();
    expect(within(banner).getByText(tr('pnl.count.uncostedItems', { count: 1 }))).toBeTruthy();
    expect(
      within(banner).getByRole('link', { name: th['pnl.fix.costs'] }).getAttribute('href'),
    ).toBe('#/settings/menu');
  });

  test('"rate not set" names the platforms and how many orders, and points to the setting', async () => {
    await open({
      ...COMPLETE,
      complete: false,
      incompleteReasons: ['commission_rate_not_set'],
      missing: {
        ...COMPLETE.missing,
        rateNotSetOrderIds: ['a', 'b'],
        ratesNotSet: ['grab', 'lineman'],
      },
    } as PnlReport);
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(th['pnl.reason.commission_rate_not_set'])).toBeTruthy();
    expect(
      within(banner).getByText(
        tr('pnl.count.rateNotSet', { platforms: 'Grab, LINE MAN', count: 2 }),
      ),
    ).toBeTruthy();
    expect(
      within(banner).getByRole('link', { name: th['pnl.fix.rates'] }).getAttribute('href'),
    ).toBe('#/settings/platform-commission');
  });

  test('excluded orders are counted', async () => {
    await open({
      ...COMPLETE,
      complete: false,
      incompleteReasons: ['orders_excluded'],
      missing: { ...COMPLETE.missing, excludedOrderIds: ['a', 'b', 'c'] },
    } as PnlReport);
    expect(
      within(screen.getByRole('alert')).getByText(tr('pnl.count.excluded', { count: 3 })),
    ).toBeTruthy();
  });
});

describe('flags and the rest of the answer', () => {
  test('both pairs present: each note names the side that was deducted, in one status region', async () => {
    await open();
    const region = screen.getByRole('status');
    expect(
      within(region).getByText(
        tr('pnl.foodCost.costOfGoodsUsed', { kept: money(27100), left: money(25000) }),
      ),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        tr('pnl.fees.commissionUsed', { kept: money(4550), left: money(1500) }),
      ),
    ).toBeTruthy();
    // the "added back" line keeps the lines adding up: 524.00 - 45.50 - 375.00 + 265.00 = 368.50
    expect(screen.getByText(th['pnl.line.notDeducted'])).toBeTruthy();
  });

  test('the other sides: ingredients larger, platform fees expense larger', async () => {
    await open({
      ...SAMPLE_PNL,
      foodCostBasis: 'ingredients_expenses',
      platformFeesBasis: 'platform_fees_expenses',
    });
    expect(
      screen.getByText(
        tr('pnl.foodCost.ingredientsUsed', { kept: money(25000), left: money(27100) }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(tr('pnl.fees.expensesUsed', { kept: money(1500), left: money(4550) })),
    ).toBeTruthy();
  });

  test('only one of each pair: no note and no added-back line', async () => {
    await open(COMPLETE);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(th['pnl.line.notDeducted'])).toBeNull();
  });

  test('voided expenses are mentioned as left out', async () => {
    await open();
    expect(screen.getByText(tr('pnl.voidedExpenses', { count: 1 }))).toBeTruthy();
  });

  test('the government co-pay share is in the revenue, and the receivable is "not built yet"', async () => {
    await open();
    expect(screen.getByText(tr('pnl.copay.revenue', { amount: money(6000) }))).toBeTruthy();
    expect(screen.getByText(th['pnl.copay.receivable'])).toBeTruthy();
  });

  test('a per-month table shows when the answer has months, with each month complete or not', async () => {
    await open();
    const table = screen.getByRole('table', { name: th['pnl.months.title'] });
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(3); // header + 2 months
    expect(within(table).getByText(money(24900))).toBeTruthy();
    expect(within(table).getByText(th['pnl.months.incomplete'])).toBeTruthy();
    expect(within(table).getByText(th['pnl.months.complete'])).toBeTruthy();
    expect(screen.getByText(th['pnl.months.partial'])).toBeTruthy();
  });

  test('no months, no table', async () => {
    await open({ ...COMPLETE, months: [] } as PnlReport);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the period and failures', () => {
  test('a preset asks for its own range; an invalid custom range asks for nothing', async () => {
    const env = await open();
    fireEvent.click(screen.getByLabelText(th['dash.range.year']));
    await waitFor(() =>
      expect(env.api.reports.pnl).toHaveBeenLastCalledWith({
        from: '2030-01-01',
        to: '2030-10-15',
      }),
    );
    fireEvent.click(screen.getByLabelText(th['fin.range.custom']));
    const calls = env.api.reports.pnl.mock.calls.length;
    fireEvent.change(screen.getByLabelText(th['fin.range.from']), {
      target: { value: '2030-10-10' },
    });
    fireEvent.change(screen.getByLabelText(th['fin.range.to']), {
      target: { value: '2030-10-01' },
    });
    expect(await screen.findByText(th['fin.range.invalid'])).toBeTruthy();
    expect(env.api.reports.pnl.mock.calls.length).toBe(calls);
  });

  test('a failed load shows a retry that loads again', async () => {
    const pnl = vi
      .fn<() => Promise<PnlReport>>()
      .mockRejectedValueOnce(new ApiClientError('NETWORK'))
      .mockResolvedValue(SAMPLE_PNL);
    const { auth } = await createTestAuth('owner');
    const env = createTestServices({
      auth,
      reports: { pnl },
      expenses: {
        categories: {
          read: async () => ({
            value: DEFAULT_EXPENSE_CATEGORIES,
            version: 0,
            rev: 0,
            updatedAt: null,
          }),
          save: async () => {
            throw new Error('not expected');
          },
        },
      },
    });
    renderScreen(<PnlScreen />, env.services);
    fireEvent.click(await screen.findByRole('button', { name: th['common.retry'] }));
    expect(await screen.findByText(th['pnl.line.net'])).toBeTruthy();
    expect(pnl).toHaveBeenCalledTimes(2);
  });
});
