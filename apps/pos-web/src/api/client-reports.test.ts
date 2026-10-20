import { describe, expect, test } from 'vitest';
import {
  apiError,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';

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

const range = { from: '2026-10-01', to: '2026-10-07' };

const day = {
  businessDate: '2026-10-01',
  revenueSatang: 20050,
  orderCount: 2,
  averageTicketSatang: 10025,
  commissionSatang: 0,
  byChannel: { storefront: 8000, line: 12050 },
  byMethod: { cash: 8000, promptpay: 12050 },
};

describe('reports reads', () => {
  test('each report has its own route, sends the range, and is parsed with the shared schema', async () => {
    const { api, calls } = clientWith((call) => {
      if (call.url.includes('/revenue')) {
        return {
          status: 200,
          json: {
            ...range,
            excludedOrderIds: [],
            days: [day],
            totals: { revenueSatang: 20050, orderCount: 2, commissionSatang: 0 },
            margin: {
              costedOrderCount: 1,
              costedRevenueSatang: 8000,
              costSatang: 3000,
              grossProfitSatang: 5000,
              marginBp: 6250,
              uncostedOrderIds: [],
              uncostedRevenueSatang: 12050,
              uncostedMenuItemIds: [],
            },
            commission: {
              recordedSatang: 0,
              recordedOrderCount: 0,
              estimatedSatang: 0,
              estimatedOrderCount: 0,
              totalSatang: 0,
              rateNotSetOrderIds: [],
              ratesNotSet: [],
            },
          },
        };
      }
      if (call.url.includes('/items'))
        return {
          status: 200,
          json: { ...range, excludedOrderIds: [], items: [], uncostedMenuItemIds: [] },
        };
      if (call.url.includes('/heatmap'))
        return { status: 200, json: { ...range, excludedOrderIds: [], cells: [] } };
      return {
        status: 200,
        json: { summary: { new: 0, regular: 0, lapsed: 0 }, customers: [] },
      };
    });
    const revenue = await api.reports.revenue(range);
    expect(revenue.totals.revenueSatang).toBe(20050);
    expect(revenue.margin.marginBp).toBe(6250);
    expect((await api.reports.items(range)).items).toEqual([]);
    expect((await api.reports.heatmap(range)).cells).toEqual([]);
    expect((await api.reports.customers()).summary.regular).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/reports/revenue?from=2026-10-01&to=2026-10-07`,
      `${BASE}/v1/reports/items?from=2026-10-01&to=2026-10-07`,
      `${BASE}/v1/reports/heatmap?from=2026-10-01&to=2026-10-07`,
      `${BASE}/v1/reports/customers`,
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a bad range never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }));
    await expect(
      api.reports.revenue({ from: '2026-10-07', to: '2026-10-01' }),
    ).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toEqual([]);
  });

  test('an answer that does not match the schema is RESPONSE_INVALID, never used', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { ...range, days: [{ nope: 1 }] } }));
    await expect(api.reports.revenue(range)).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  test('a refusal carries its code (403 for a role without the permission)', async () => {
    const { api } = clientWith(() => apiError(403, 'FORBIDDEN'));
    await expect(api.reports.customers()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('reports csv export', () => {
  test('returns the file text and the name from the answer, with the session as bearer', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      text: '﻿วันที่ทำการ\r\n2026-10-01\r\n',
    }));
    const file = await api.reports.exportCsv('revenue', range);
    expect(file.text).toBe('﻿วันที่ทำการ\r\n2026-10-01\r\n');
    expect(file.filename).toBe('revenue-2026-10-01-2026-10-07.csv');
    expect(calls[0]?.url).toBe(
      `${BASE}/v1/reports/export/revenue.csv?from=2026-10-01&to=2026-10-07`,
    );
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('STEP_UP_REQUIRED is passed on so the screen can ask the owner to confirm', async () => {
    const { api } = clientWith(() => apiError(403, 'STEP_UP_REQUIRED'));
    await expect(api.reports.exportCsv('items', range)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  test('a network failure is a NETWORK error that keeps no URL', async () => {
    const net = createApiClient({
      baseUrl: BASE,
      fetch: (async () => {
        throw new TypeError(`failed to fetch ${BASE}/secret`);
      }) as typeof fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    const error = await net.reports.exportCsv('items', range).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'NETWORK' });
    expect(String((error as Error).message)).not.toContain('secret');
  });
});
