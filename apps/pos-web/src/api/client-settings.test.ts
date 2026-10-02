import {
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
} from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';
const NOW = '2026-10-03T03:00:00.000Z';

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

const answer = (value: unknown, version = 1) => ({
  status: 200,
  json: { value, version, rev: 10, updatedAt: NOW },
});

describe('settings reads', () => {
  test('each resource has its own route and is parsed with the shared schema', async () => {
    const { api, calls } = clientWith((call) => {
      if (call.url.endsWith('/shop')) return answer(DEFAULT_SHOP_SETTINGS, 0);
      if (call.url.endsWith('/opening-hours')) return answer(DEFAULT_OPENING_HOURS, 2);
      if (call.url.endsWith('/numbering')) {
        return answer({ cutoffMinutes: 240, timeZone: 'Asia/Bangkok' });
      }
      if (call.url.endsWith('/payments')) {
        return answer({ cash: true, promptpay: true, platform: true, other: false });
      }
      return answer(DEFAULT_DELIVERY_SETTINGS);
    });
    expect((await api.settings.shop.read()).value.nameTh).toBe(DEFAULT_SHOP_SETTINGS.nameTh);
    expect((await api.settings.openingHours.read()).version).toBe(2);
    expect((await api.settings.numbering.read()).value.cutoffMinutes).toBe(240);
    expect((await api.settings.payments.read()).value.other).toBe(false);
    expect((await api.settings.deliveryList.read()).value.buildings).toContain('A1');
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/settings/shop`,
      `${BASE}/v1/settings/opening-hours`,
      `${BASE}/v1/settings/numbering`,
      `${BASE}/v1/settings/payments`,
      `${BASE}/v1/settings/delivery`,
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('an answer that does not match the schema is RESPONSE_INVALID, never used', async () => {
    const { api } = clientWith(() => answer({ nameTh: 5 }));
    await expect(api.settings.shop.read()).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });
});

describe('settings writes', () => {
  test('a shop change is a PATCH with expectedVersion and only the given fields', async () => {
    const { api, calls } = clientWith(() =>
      answer({ ...DEFAULT_SHOP_SETTINGS, phone: '0812345678' }, 3),
    );
    const saved = await api.settings.shop.save({ expectedVersion: 2, phone: '0812345678' });
    expect(saved.version).toBe(3);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/settings/shop` });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 2, phone: '0812345678' });
  });

  test('the building list is replaced as a whole with PUT', async () => {
    const { api, calls } = clientWith(() => answer({ buildings: ['A1', 'B2'] }, 4));
    await api.settings.deliveryList.save({ expectedVersion: 3, buildings: ['A1', 'B2'] });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/v1/settings/delivery` });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 3, buildings: ['A1', 'B2'] });
  });

  test('a body with no change, or with an unknown field, fails before the network', async () => {
    const { api, calls } = clientWith(() => answer(DEFAULT_SHOP_SETTINGS));
    await expect(api.settings.shop.save({ expectedVersion: 1 })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    await expect(
      api.settings.payments.save({ expectedVersion: 1, cash: false, free: true } as never),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('a stale version is VERSION_CONFLICT carrying the current version', async () => {
    const { api } = clientWith(() => apiError(409, 'VERSION_CONFLICT', { currentVersion: 7 }));
    await expect(
      api.settings.numbering.save({ expectedVersion: 5, cutoffMinutes: 300 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 7 });
  });

  test('numbering, payments and opening hours use their own routes', async () => {
    const { api, calls } = clientWith(() => answer({}));
    await api.settings.numbering.save({ expectedVersion: 0, cutoffMinutes: 300 }).catch(() => null);
    await api.settings.payments.save({ expectedVersion: 0, other: true }).catch(() => null);
    await api.settings.openingHours
      .save({ expectedVersion: 0, storefront: { openMinute: 600, closeMinute: 1200 } })
      .catch(() => null);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PATCH ${BASE}/v1/settings/numbering`,
      `PATCH ${BASE}/v1/settings/payments`,
      `PATCH ${BASE}/v1/settings/opening-hours`,
    ]);
  });
});
