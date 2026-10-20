// @vitest-environment jsdom
import { catalogs, formatBaht, translator } from '@sds/i18n';
import type { TaxProfileResponse, TaxReport } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { sampleTax } from '../../dev/mock-finance-data.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { TaxScreen } from './TaxScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const money = (n: number) => formatBaht(n, 'th');

/** 12:00 in Bangkok on 15 Oct 2030, which is Buddhist Era 2573. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PROFILE: TaxProfileResponse = {
  year: 2573,
  filerType: 'individual',
  allowances: { items: [] },
  methodPreference: null,
  saved: false,
} as TaxProfileResponse;

interface Options {
  tax?: (q: { year: number; period: 'annual' | 'half' }) => Promise<TaxReport>;
  profile?: () => Promise<TaxProfileResponse>;
  save?: (year: number, body: unknown) => Promise<TaxProfileResponse>;
  fresh?: boolean;
}

async function open(options: Options = {}) {
  const { auth } = await createTestAuth('owner');
  if (options.fresh !== false) {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({
    auth,
    reports: { tax: options.tax ?? (async ({ period }) => sampleTax(period)) },
    taxProfile: {
      read: options.profile ?? (async () => PROFILE),
      save: (options.save ?? (async () => PROFILE)) as never,
    },
  });
  renderScreen(<TaxScreen />, env.services);
  return env;
}

const loaded = () => screen.findByText(th['tax.estimate.title']);

describe('what is always on screen', () => {
  test('the disclaimer, the proposed status and the rule year show before the answer arrives', async () => {
    let release: (report: TaxReport) => void = () => undefined;
    await open({ tax: () => new Promise<TaxReport>((resolve) => (release = resolve)) });
    expect(screen.getByText(th['tax.status.proposed'])).toBeTruthy();
    // Until the answer says otherwise, the year asked for is the year shown.
    expect(screen.getByText(tr('tax.disclaimer', { year: 2573 }))).toBeTruthy();
    release(sampleTax('annual'));
    await loaded();
    expect(screen.getByText(tr('tax.disclaimer', { year: 2569 }))).toBeTruthy();
    expect(screen.getByText(tr('tax.ruleYear', { year: 2569 }))).toBeTruthy();
    expect(screen.getByText(th['tax.status.proposed'])).toBeTruthy();
  });

  test('a year with no rules says so, and the disclaimer is still there', async () => {
    await open({
      tax: async () => {
        throw new ApiClientError('TAX_RULES_NOT_AVAILABLE', { status: 422 });
      },
    });
    expect(await screen.findByText(th['error.taxRulesNotAvailable'])).toBeTruthy();
    expect(screen.getByText(tr('tax.disclaimer', { year: 2573 }))).toBeTruthy();
    expect(screen.getByText(th['tax.status.proposed'])).toBeTruthy();
  });

  test('every rule source is a link that opens a new page without handing over the opener', async () => {
    await open();
    await loaded();
    const links = within(screen.getByRole('list', { name: th['tax.sources.title'] })).getAllByRole(
      'link',
    );
    expect(links.length).toBe(sampleTax('half').sources.length);
    for (const [index, link] of links.entries()) {
      expect(link.getAttribute('href')).toBe(sampleTax('half').sources[index]?.url);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
    expect(
      screen.getAllByText(tr('tax.sources.checked', { date: '20 ต.ค. 2569' })).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(th['tax.rule.brackets']).length).toBeGreaterThan(0);
  });
});

describe('the estimate', () => {
  test('asks for the current Buddhist Era year, whole year; the year and the return can change', async () => {
    const env = await open();
    await loaded();
    expect(env.api.reports.tax).toHaveBeenCalledWith({ year: 2573, period: 'annual' });
    fireEvent.click(screen.getByLabelText(th['tax.period.half']));
    await waitFor(() =>
      expect(env.api.reports.tax).toHaveBeenLastCalledWith({ year: 2573, period: 'half' }),
    );
    fireEvent.change(screen.getByLabelText(th['tax.year']), { target: { value: '2572' } });
    await waitFor(() =>
      expect(env.api.reports.tax).toHaveBeenLastCalledWith({ year: 2572, period: 'half' }),
    );
  });

  test('shows the form, the dates it counts to, and the server tax payable', async () => {
    await open({ tax: async () => sampleTax('half') });
    await loaded();
    expect(screen.getAllByText(/ภ\.ง\.ด\.94/).length).toBeGreaterThan(0);
    expect(screen.getByText(tr('tax.coversThrough', { date: '30 มิ.ย. 2569' }))).toBeTruthy();
    expect(screen.getByLabelText(th['tax.estimate.title']).textContent).toContain(money(240_000));
  });

  test('compares the two methods side by side and marks the one in use and the cheaper one', async () => {
    await open({ tax: async () => sampleTax('half') });
    await loaded();
    const table = screen.getByRole('table', { name: th['tax.compare.title'] });
    for (const satang of [31_200_000, 32_400_000, 240_000, 180_000]) {
      expect(within(table).getAllByText(money(satang)).length, money(satang)).toBeGreaterThan(0);
    }
    const heads = within(table).getAllByRole('columnheader');
    expect(within(heads[1] as HTMLElement).getByText(th['tax.compare.chosen'])).toBeTruthy();
    expect(within(heads[2] as HTMLElement).getByText(th['tax.compare.cheaper'])).toBeTruthy();
    expect(
      screen.getByText(tr('tax.cheaper.other', { method: th['tax.method.flat'] })),
    ).toBeTruthy();
    expect(screen.getByText(th['tax.chosenBy.default_actual'])).toBeTruthy();
  });

  test('the 0.5% block shows only when the answer has one', async () => {
    await open({ tax: async () => sampleTax('half') });
    await loaded();
    expect(screen.queryByText(th['tax.half.title'])).toBeNull();
    cleanup();
    const withHalf: TaxReport = {
      ...sampleTax('annual'),
      halfPercent: {
        rateBasisPoints: 50,
        taxSatang: 600_000,
        thresholdSatang: 12_000_000,
        thresholdStatus: 'conflict',
        exemptCeilingSatang: 500_000,
        status: 'applied',
      },
      notes: ['tax.note.halfPercentThresholdSources'],
    } as TaxReport;
    await open({ tax: async () => withHalf });
    await loaded();
    expect(screen.getByText(th['tax.half.title'])).toBeTruthy();
    expect(
      screen.getByText(tr('tax.half.line', { rate: '0.5%', amount: money(600_000) })),
    ).toBeTruthy();
    expect(screen.getByText(th['tax.half.conflict'])).toBeTruthy();
    expect(screen.getByText(th['tax.half.applied'])).toBeTruthy();
    expect(screen.getByText(th['tax.note.halfPercentThresholdSources'])).toBeTruthy();
  });

  test('the 0.5% note is not invented when the answer does not carry it', async () => {
    await open({ tax: async () => sampleTax('annual') });
    await loaded();
    expect(screen.queryByText(th['tax.note.halfPercentThresholdSources'])).toBeNull();
    expect(screen.queryByText(th['tax.note.halfPercentNotApplied'])).toBeNull();
  });
});

describe('warnings', () => {
  test('a profit that is not complete is a banner with its reasons, and the note shows once', async () => {
    await open({ tax: async () => sampleTax('annual') });
    await loaded();
    expect(screen.getAllByText(th['tax.note.pnlIncomplete']).length).toBe(1);
    expect(screen.getByText(th['pnl.reason.orders_uncosted'])).toBeTruthy();
  });

  test('the larger-of-two notes and a late filing are banners too, once each, in one status region', async () => {
    await open({
      tax: async () =>
        ({
          ...sampleTax('half'),
          foodCostBasis: 'cost_of_goods',
          platformFeesBasis: 'commission',
          notes: [
            'tax.note.pnlIncomplete',
            'tax.note.foodCostCostOfGoodsUsed',
            'tax.note.platformFeesCommissionUsed',
            'tax.note.filingLate',
          ],
        }) as TaxReport,
    });
    await loaded();
    expect(screen.getAllByText(th['tax.note.foodCostCostOfGoodsUsed']).length).toBe(1);
    expect(screen.getAllByText(th['tax.note.platformFeesCommissionUsed']).length).toBe(1);
    // grouped in one polite live region, never role=alert
    expect(screen.queryByRole('alert')).toBeNull();
    const region = screen.getByRole('status');
    expect(within(region).getByText(th['tax.note.foodCostCostOfGoodsUsed'])).toBeTruthy();
    expect(within(region).getByText(th['tax.note.filingLate'])).toBeTruthy();
    expect(screen.getAllByText(th['tax.note.filingLate']).length).toBe(1);
    expect(screen.getByText(th['tax.filing.pastDue'])).toBeTruthy();
  });

  test('a complete profit has no incomplete banner', async () => {
    await open({
      tax: async () =>
        ({
          ...sampleTax('annual'),
          pnlComplete: true,
          incompleteReasons: [],
          notes: [],
        }) as TaxReport,
    });
    await loaded();
    expect(screen.queryByText(th['tax.note.pnlIncomplete'])).toBeNull();
  });

  test('the other notes of the answer are listed in words', async () => {
    await open({ tax: async () => sampleTax('annual') });
    await loaded();
    expect(screen.getByText(th['tax.note.costOfGoodsEstimated'])).toBeTruthy();
    expect(screen.getByText(th['tax.note.halfYearCredit'])).toBeTruthy();
  });
});

describe('filing and watches', () => {
  test('says if the shop must file, with the window', async () => {
    await open({ tax: async () => sampleTax('half') });
    await loaded();
    expect(screen.getByText(tr('tax.filing.must', { amount: money(6_000_000) }))).toBeTruthy();
    expect(
      screen.getByText(tr('tax.filing.window', { from: '1 ก.ค. 2569', to: '30 ก.ย. 2569' })),
    ).toBeTruthy();
  });

  test('the VAT and e-Payment watches show their status in words', async () => {
    await open({ tax: async () => sampleTax('half') });
    await loaded();
    expect(
      screen.getByText(
        tr('tax.watch.vatLine', {
          revenue: money(54_000_000),
          limit: money(180_000_000),
          percent: 30,
        }),
      ),
    ).toBeTruthy();
    // Both watches are below their thresholds, and say it in the same words.
    expect(screen.getAllByText(th['tax.watch.vatStatus.below']).length).toBe(2);
    expect(
      screen.getByText(
        tr('tax.watch.ePaymentLine', {
          count: 120,
          amount: money(18_000_000),
          limit: 400,
          altCount: 200,
          altAmount: money(300_000_000),
        }),
      ),
    ).toBeTruthy();
  });

  test('no incoming-transfer data is said plainly', async () => {
    await open({
      tax: async () =>
        ({
          ...sampleTax('half'),
          watch: { ...sampleTax('half').watch, ePayment: null },
        }) as TaxReport,
    });
    await loaded();
    expect(screen.getByText(th['tax.watch.ePaymentNone'])).toBeTruthy();
  });
});

describe('the allowances editor', () => {
  const saved = (over: Partial<TaxProfileResponse> = {}) =>
    ({ ...PROFILE, saved: true, ...over }) as TaxProfileResponse;

  test('shows the personal allowance that was used, and loads what the owner saved', async () => {
    await open({
      profile: async () =>
        saved({
          allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
          methodPreference: 'flat',
        } as never),
    });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    expect(within(editor).getByText(money(6_000_000))).toBeTruthy();
    expect((await within(editor).findByDisplayValue('ประกันชีวิต')) as HTMLInputElement).toBeTruthy();
    expect((within(editor).getByDisplayValue('25000') as HTMLInputElement).value).toBe('25000');
    expect((within(editor).getByLabelText(th['tax.method.flat']) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  test('a save sends the whole profile of the year in satang, asks nothing twice, then recalculates', async () => {
    const save = vi.fn(async () => saved());
    const env = await open({ save });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.add'] }));
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.label']), {
      target: { value: 'เบี้ยประกัน' },
    });
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.amount']), {
      target: { value: '25000.50' },
    });
    fireEvent.click(within(editor).getByLabelText(th['tax.method.flat']));
    const before = env.api.reports.tax.mock.calls.length;
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.save'] }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(2573, {
      allowances: { items: [{ label: 'เบี้ยประกัน', annualSatang: 2_500_050 }] },
      methodPreference: 'flat',
    });
    await waitFor(() => expect(env.api.reports.tax.mock.calls.length).toBeGreaterThan(before));
    expect(await within(editor).findByText(th['tax.allow.saved'])).toBeTruthy();
  });

  test('a row without a name, or with a bad amount, is refused before the step-up', async () => {
    const save = vi.fn(async () => saved());
    await open({ save });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.add'] }));
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.save'] }));
    expect(await within(editor).findByText(th['tax.allow.error.label'])).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.label']), {
      target: { value: 'x' },
    });
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.amount']), {
      target: { value: 'abc' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.save'] }));
    expect(await within(editor).findByText(th['tax.allow.error.amount'])).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  test('a row can be removed', async () => {
    await open({
      profile: async () =>
        saved({ allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 100 }] } } as never),
    });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    await within(editor).findByDisplayValue('ประกันชีวิต');
    fireEvent.click(
      within(editor).getByRole('button', { name: tr('tax.allow.remove', { label: 'ประกันชีวิต' }) }),
    );
    expect(within(editor).queryByDisplayValue('ประกันชีวิต')).toBeNull();
  });

  test('without a fresh step-up the owner is asked to confirm first, and nothing is sent yet', async () => {
    const save = vi.fn(async () => saved());
    await open({ save, fresh: false });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.save'] }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  test('if the saved profile cannot be read, saving is off and it says why', async () => {
    const save = vi.fn(async () => saved());
    await open({
      profile: async () => {
        throw new ApiClientError('NETWORK');
      },
      save,
    });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    expect(await within(editor).findByText(th['tax.allow.loadFailed'])).toBeTruthy();
    expect(
      (within(editor).getByRole('button', { name: th['tax.allow.save'] }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test('a refused save shows the reason and keeps the form', async () => {
    const save = vi.fn().mockRejectedValue(new ApiClientError('FORBIDDEN', { status: 403 }));
    await open({ save });
    await loaded();
    const editor = screen.getByRole('group', { name: th['tax.allow.title'] });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.add'] }));
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.label']), {
      target: { value: 'x' },
    });
    fireEvent.change(within(editor).getByLabelText(th['tax.allow.amount']), {
      target: { value: '5' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: th['tax.allow.save'] }));
    expect(await within(editor).findByText(th['error.forbidden'])).toBeTruthy();
    expect((within(editor).getByLabelText(th['tax.allow.label']) as HTMLInputElement).value).toBe(
      'x',
    );
  });
});
