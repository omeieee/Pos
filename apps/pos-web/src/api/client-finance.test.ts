import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMockFinance } from '../dev/mock-finance.ts';
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

describe('expense receipt photos', () => {
  const ID = ROW?.id ?? '';
  const KEY = '0192f3a0-0000-7000-8000-00000000beef';
  const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], {
    type: 'image/jpeg',
  });

  test('attaching sends the bytes as they are, the version in the query and one Idempotency-Key', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: { ...ROW, hasReceipt: true } }));
    const done = await api.expenses.receipt.attach(ID, photo, {
      expectedVersion: 3,
      requestId: KEY,
    });
    expect(done.row.hasReceipt).toBe(true);
    expect(done.replay).toBe(false);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/v1/expenses/${ID}/receipt?expectedVersion=3`,
    });
    expect(calls[0]?.headers['idempotency-key']).toBe(KEY);
    expect(calls[0]?.headers['content-type']).toBe('image/jpeg');
    expect(Array.from(calls[0]?.bytes ?? [])).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a 200 answer is a replay, and a call with no id makes one', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { ...ROW, hasReceipt: true } }));
    const done = await api.expenses.receipt.attach(ID, photo, { expectedVersion: 1 });
    expect(done.replay).toBe(true);
    expect(done.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.headers['idempotency-key']).toBe(done.requestId);
  });

  test('a bad id, version or empty file never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: ROW }));
    await expect(
      api.expenses.receipt.attach('not-an-id', photo, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(
      api.expenses.receipt.attach(ID, photo, { expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(
      api.expenses.receipt.attach(ID, new Blob([], { type: 'image/png' }), { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toEqual([]);
  });

  test('reading is a GET with the session header and hands back the picture as a Blob', async () => {
    const net = mockFetch(() => ({ status: 200, text: 'PNGBYTES' }));
    const api = createApiClient({
      baseUrl: BASE,
      fetch: net.fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    const blob = await api.expenses.receipt.read(ID);
    expect(await blob.text()).toBe('PNGBYTES');
    expect(net.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/expenses/${ID}/receipt` });
    expect(net.calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a refused read carries its code and no body text', async () => {
    const { api } = clientWith(() => apiError(503, 'RECEIPT_STORAGE_UNAVAILABLE'));
    await expect(api.expenses.receipt.read(ID)).rejects.toMatchObject({
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 503,
    });
  });

  test('removing is a DELETE with the version and answers with the expense', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: ROW }));
    const row = await api.expenses.receipt.remove(ID, 4);
    expect(row.id).toBe(ID);
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `${BASE}/v1/expenses/${ID}/receipt?expectedVersion=4`,
    });
  });

  test('refusals carry their code', async () => {
    for (const [status, code] of [
      [415, 'RECEIPT_TYPE_UNSUPPORTED'],
      [409, 'EXPENSE_VOIDED'],
      [503, 'RECEIPT_STORAGE_UNAVAILABLE'],
    ] as const) {
      const { api } = clientWith(() => apiError(status, code));
      await expect(
        api.expenses.receipt.attach(ID, photo, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe('profit and loss and tax reads', () => {
  test('pnl is a GET with the range and parses with the shared schema', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: SAMPLE_PNL }));
    const pnl = await api.reports.pnl(range);
    expect(pnl.netProfitSatang).toBe(36850);
    expect(pnl.govCopay.receivable).toBe('not_tracked');
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

describe('cash receipts and payments', () => {
  const mock = createMockFinance({ now: () => Date.parse(NOW) });
  const sample = mock.handle('GET', '/v1/reports/cash', new URLSearchParams(range), undefined, {
    role: 'owner',
  })?.body;

  test('the report is a GET with the range; emptyDays is sent only when asked for', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: sample }));
    const report = await api.reports.cash(range);
    expect(report.totals.receiptsSatang).toBeGreaterThan(0);
    await api.reports.cash(range, { emptyDays: true });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/reports/cash?from=2026-10-01&to=2026-10-07`,
      `${BASE}/v1/reports/cash?from=2026-10-01&to=2026-10-07&emptyDays=true`,
    ]);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a bad range never reaches the network, and an answer that is not a cash report is RESPONSE_INVALID', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { days: 'no' } }));
    await expect(api.reports.cash({ from: '2026-10-07', to: '2026-10-01' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toEqual([]);
    await expect(api.reports.cash(range)).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  test('the CSV file is a step-up call with the cash file name', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, text: 'x\r\n' }));
    const file = await api.reports.exportCsv('cash', range);
    expect(file.filename).toBe('cash-2026-10-01-2026-10-07.csv');
    expect(calls[0]?.url).toBe(`${BASE}/v1/reports/export/cash.csv?from=2026-10-01&to=2026-10-07`);
    const denied = clientWith(() => apiError(403, 'STEP_UP_REQUIRED'));
    await expect(denied.api.reports.exportCsv('cash', range)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  test('the opening cash is a versioned setting changed with PATCH; a half-set or negative one fails first', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: {
        value: { amountSatang: 50000, asOf: '2026-09-24' },
        version: 1,
        rev: 3,
        updatedAt: NOW,
      },
    }));
    expect((await api.settings.cashOpening.read()).value.amountSatang).toBe(50000);
    await api.settings.cashOpening.save({
      expectedVersion: 1,
      amountSatang: satang(60000),
      asOf: '2026-09-25',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/settings/cash-opening`,
      `PATCH ${BASE}/v1/settings/cash-opening`,
    ]);
    expect(bodyOf(calls[1])).toEqual({
      expectedVersion: 1,
      amountSatang: 60000,
      asOf: '2026-09-25',
    });
    await expect(
      api.settings.cashOpening.save({
        expectedVersion: 1,
        amountSatang: satang(-1),
        asOf: '2026-09-25',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });
});
