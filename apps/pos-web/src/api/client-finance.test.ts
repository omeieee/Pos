import { describe, expect, test } from 'vitest';
import { SAMPLE_EXPENSES, SAMPLE_PNL, sampleTax } from '../dev/mock-finance-data.ts';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';
const range = { from: '2026-10-01', to: '2026-10-07' };
const NOW = '2026-10-20T03:00:00.000Z';
const ROW = SAMPLE_EXPENSES[0];

function clientWith(responder: Parameters<typeof mockFetch>[0]) {
  const net = mockFetch(responder);
  const api = createApiClient({
    baseUrl: BASE,
    fetch: net.fetch,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
  });
  return { api, calls: net.calls };
}

describe('expenses', () => {
  test('the list is a GET with the range and keeps the server total', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { expenses: SAMPLE_EXPENSES, totalSatang: 37500 },
    }));
    const list = await api.expenses.list(range);
    expect(list.totalSatang).toBe(37500);
    expect(list.expenses).toHaveLength(SAMPLE_EXPENSES.length);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/v1/expenses?from=2026-10-01&to=2026-10-07`,
    });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a bad range never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }));
    await expect(api.expenses.list({ from: '2026-10-07', to: '2026-10-01' })).rejects.toMatchObject(
      { code: 'REQUEST_INVALID' },
    );
    expect(calls).toEqual([]);
  });

  test('a create carries one id in the body and in Idempotency-Key, and says if it was a replay', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: ROW }));
    const made = await api.expenses.create(
      { category: 'gas', amountSatang: 8000, businessDate: '2026-11-01' },
      { clientRequestId: '0192f3a0-0000-7000-8000-00000000abcd' },
    );
    expect(made.replay).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/expenses` });
    expect(bodyOf(calls[0])).toEqual({
      category: 'gas',
      amountSatang: 8000,
      businessDate: '2026-11-01',
      clientRequestId: '0192f3a0-0000-7000-8000-00000000abcd',
    });
    expect(calls[0]?.headers['idempotency-key']).toBe('0192f3a0-0000-7000-8000-00000000abcd');
  });

  test('a create with no id makes one; zero or fractional satang fail before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: ROW }));
    const made = await api.expenses.create({ category: 'gas', amountSatang: 100 });
    expect(made.replay).toBe(false);
    expect(made.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    for (const amountSatang of [0, -5, 10.5]) {
      await expect(api.expenses.create({ category: 'gas', amountSatang })).rejects.toMatchObject({
        code: 'REQUEST_INVALID',
      });
    }
    expect(calls).toHaveLength(1);
  });

  test('a correction is a PATCH with the version and only the changed fields; none is refused', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: ROW }));
    await api.expenses.patch(ROW?.id ?? '', { expectedVersion: 1, amountSatang: 9000 });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `${BASE}/v1/expenses/${ROW?.id}`,
    });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 1, amountSatang: 9000 });
    await expect(api.expenses.patch(ROW?.id ?? '', { expectedVersion: 1 })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(1);
  });

  test('a void needs a reason and goes to /void', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: ROW }));
    await api.expenses.void(ROW?.id ?? '', { expectedVersion: 2, reason: 'พิมพ์ผิด' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/v1/expenses/${ROW?.id}/void`,
    });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 2, reason: 'พิมพ์ผิด' });
    await expect(
      api.expenses.void(ROW?.id ?? '', { expectedVersion: 2, reason: '  ' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });

  test('categories read as a setting and are replaced whole with PUT', async () => {
    const list = {
      categories: [{ key: 'gas', nameTh: 'แก๊ส', nameEn: null, active: true }],
    };
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { value: list, version: 3, rev: 9, updatedAt: NOW },
    }));
    expect((await api.expenses.categories.read()).version).toBe(3);
    await api.expenses.categories.save({ expectedVersion: 3, ...list });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/expenses/categories`,
      `PUT ${BASE}/v1/expenses/categories`,
    ]);
    expect(bodyOf(calls[1])).toEqual({ expectedVersion: 3, ...list });
    await expect(
      api.expenses.categories.save({ expectedVersion: 3, categories: [] }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });

  test('a refusal carries its code', async () => {
    const { api } = clientWith(() => apiError(403, 'FORBIDDEN'));
    await expect(api.expenses.list(range)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('profit and loss and tax reads', () => {
  test('pnl is a GET with the range and parses with the shared schema', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: SAMPLE_PNL }));
    const pnl = await api.reports.pnl(range);
    expect(pnl.netProfitSatang).toBe(10350);
    expect(pnl.govCopay.receivable).toBe('not_built');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/v1/reports/pnl?from=2026-10-01&to=2026-10-07`,
    });
  });

  test('a P&L answer missing a figure is RESPONSE_INVALID', async () => {
    const { api } = clientWith(() => ({
      status: 200,
      json: { ...SAMPLE_PNL, complete: undefined },
    }));
    await expect(api.reports.pnl(range)).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  test('tax sends the Buddhist Era year and the period', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: sampleTax('half') }));
    const tax = await api.reports.tax({ year: 2569, period: 'half' });
    expect(tax.form).toBe('ภ.ง.ด.94');
    expect(tax.status).toBe('proposed - confirm with the Revenue Department');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/v1/reports/tax?year=2569&period=half`,
    });
  });

  test('a year that is not a Buddhist Era year, or a bad period, never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: sampleTax('half') }));
    await expect(api.reports.tax({ year: 2026, period: 'half' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    await expect(api.reports.tax({ year: 2569, period: 'quarter' as never })).rejects.toMatchObject(
      { code: 'REQUEST_INVALID' },
    );
    expect(calls).toEqual([]);
  });

  test('a year without rules is TAX_RULES_NOT_AVAILABLE (422)', async () => {
    const { api } = clientWith(() => apiError(422, 'TAX_RULES_NOT_AVAILABLE'));
    await expect(api.reports.tax({ year: 2575, period: 'annual' })).rejects.toMatchObject({
      code: 'TAX_RULES_NOT_AVAILABLE',
      status: 422,
    });
  });
});

describe('tax profile and platform commission settings', () => {
  const profile = {
    year: 2569,
    filerType: 'individual',
    allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
    methodPreference: null,
    saved: true,
  };

  test('the profile is read for a year and saved whole with PUT ?year=', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: profile }));
    expect((await api.settings.taxProfile.read(2569)).saved).toBe(true);
    await api.settings.taxProfile.save(2569, {
      allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
      methodPreference: 'flat',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/settings/tax-profile?year=2569`,
      `PUT ${BASE}/v1/settings/tax-profile?year=2569`,
    ]);
    expect(bodyOf(calls[1])).toEqual({
      allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
      methodPreference: 'flat',
    });
  });

  test('an allowance with no label or a fractional amount fails before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: profile }));
    await expect(
      api.settings.taxProfile.save(2569, {
        allowances: { items: [{ label: ' ', annualSatang: 100 }] },
        methodPreference: null,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(
      api.settings.taxProfile.save(2569, {
        allowances: { items: [{ label: 'x', annualSatang: 1.5 }] },
        methodPreference: null,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toEqual([]);
  });

  test('the commission rates are a versioned setting changed with PATCH', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: {
        value: { grabRateBp: 2500, linemanRateBp: null },
        version: 2,
        rev: 4,
        updatedAt: NOW,
      },
    }));
    expect((await api.settings.platformCommission.read()).value.grabRateBp).toBe(2500);
    await api.settings.platformCommission.save({ expectedVersion: 2, linemanRateBp: 2000 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/settings/platform-commission`,
      `PATCH ${BASE}/v1/settings/platform-commission`,
    ]);
    expect(bodyOf(calls[1])).toEqual({ expectedVersion: 2, linemanRateBp: 2000 });
    await expect(
      api.settings.platformCommission.save({ expectedVersion: 2, grabRateBp: 10001 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });
});
