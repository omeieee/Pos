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

// A made-up ID (the dev shop's), never a real account.
const MADE_UP_ID = '0800001234';

describe('the PromptPay ID is only ever shown masked', () => {
  test('a read keeps the type and the masked form, and nothing else of the ID', async () => {
    const { api, calls } = clientWith(() => answer({ idType: 'phone', idValue: MADE_UP_ID }, 4));
    const read = await api.settings.promptpayMasked.read();
    expect(read.value).toEqual({ idType: 'phone', idMasked: '******1234' });
    expect(read.version).toBe(4);
    expect(JSON.stringify(read)).not.toContain(MADE_UP_ID);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/settings/promptpay` });
  });

  test('no ID saved yet reads as null', async () => {
    const { api } = clientWith(() => answer(null, 0));
    expect((await api.settings.promptpayMasked.read()).value).toBeNull();
  });

  test('a change sends the whole new ID once, and the answer comes back masked', async () => {
    const { api, calls } = clientWith(() => answer({ idType: 'phone', idValue: '0899990000' }, 5));
    const saved = await api.settings.promptpayMasked.save({
      expectedVersion: 4,
      idType: 'phone',
      idValue: '0899990000',
    });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/settings/promptpay` });
    expect(bodyOf(calls[0])).toEqual({
      expectedVersion: 4,
      idType: 'phone',
      idValue: '0899990000',
    });
    expect(saved.value).toEqual({ idType: 'phone', idMasked: '******0000' });
    expect(JSON.stringify(saved)).not.toContain('0899990000');
  });

  test('an ID of the wrong shape never reaches the network', async () => {
    const { api, calls } = clientWith(() => answer(null, 0));
    await expect(
      api.settings.promptpayMasked.save({ expectedVersion: 1, idType: 'phone', idValue: '12345' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('a refusal carries only its code: the ID is in no error', async () => {
    const { api } = clientWith(() => apiError(403, 'STEP_UP_REQUIRED'));
    const error = await api.settings.promptpayMasked
      .save({ expectedVersion: 1, idType: 'phone', idValue: MADE_UP_ID })
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(MADE_UP_ID);
  });
});

describe('the co-pay scheme', () => {
  const scheme = {
    id: '0192f3a0-0000-7000-8000-000000000077',
    code: 'thai_chuay_thai_plus_2',
    nameTh: 'ไทยช่วยไทย พลัส',
    nameEn: null,
    settlementNote: null,
    version: 3,
    rev: 30,
    govShareBp: 6000,
    govDailyCapSatang: 20000,
    govTotalCapSatang: null,
    activeFrom: '2030-10-01',
    activeTo: '2030-11-30',
    activeFromMinute: 360,
    activeToMinute: 1380,
    channels: ['storefront'],
    enabled: false,
  };

  test('reads the scheme, or null when there is none', async () => {
    const some = clientWith(() => ({ status: 200, json: { scheme } }));
    expect((await some.api.settings.govCopay.read()).scheme?.govShareBp).toBe(6000);
    expect(some.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/settings/gov-copay` });
    const none = clientWith(() => ({ status: 200, json: { scheme: null } }));
    expect((await none.api.settings.govCopay.read()).scheme).toBeNull();
  });

  test('a change is a PATCH with the version, parsed with the shared schema', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { scheme: { ...scheme, enabled: true, version: 4 } },
    }));
    const saved = await api.settings.govCopay.save({ expectedVersion: 3, enabled: true });
    expect(saved.scheme?.version).toBe(4);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/settings/gov-copay` });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 3, enabled: true });
  });

  test('a change with nothing in it, or a share over 100 percent, never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { scheme } }));
    await expect(api.settings.govCopay.save({ expectedVersion: 3 })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    await expect(
      api.settings.govCopay.save({ expectedVersion: 3, govShareBp: 10001 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('FORBIDDEN (not the owner) and STEP_UP_REQUIRED keep their codes', async () => {
    const forbidden = clientWith(() => apiError(403, 'FORBIDDEN'));
    await expect(
      forbidden.api.settings.govCopay.save({ expectedVersion: 3, enabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stepUp = clientWith(() => apiError(403, 'STEP_UP_REQUIRED'));
    await expect(
      stepUp.api.settings.govCopay.save({ expectedVersion: 3, enabled: true }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});

describe('devices and staff (owner only; the API asks for a step-up on every call)', () => {
  const device = {
    id: '0192f3a0-0000-7000-8000-000000000001',
    name: 'iPad เคาน์เตอร์',
    kind: 'ipad',
    lastSeenAt: NOW,
    revokedAt: null,
    version: 1,
  };
  const person = {
    id: '0192f3a0-0000-7000-8000-000000000002',
    displayName: 'น้องเอ',
    role: 'cashier',
    active: true,
    email: null,
    hasPin: true,
    pinLockedUntil: null,
    version: 2,
  };

  test('lists devices and revokes one with a POST and no body', async () => {
    const { api, calls } = clientWith((call) =>
      call.method === 'GET'
        ? { status: 200, json: { devices: [device] } }
        : { status: 200, json: { ...device, revokedAt: NOW, version: 2 } },
    );
    expect((await api.admin.devices()).devices[0]?.name).toBe('iPad เคาน์เตอร์');
    const revoked = await api.admin.revokeDevice(device.id);
    expect(revoked.revokedAt).toBe(NOW);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `${BASE}/v1/devices/${device.id}/revoke`,
    });
    expect(calls[1]?.body).toBeUndefined();
  });

  test('a device id that is not a UUID never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: device }));
    await expect(api.admin.revokeDevice('../staff')).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(0);
  });

  test('lists staff and creates one: 201, the body is exactly the shared create schema, with no request id because the API refuses extra fields', async () => {
    const { api, calls } = clientWith((call) =>
      call.method === 'GET'
        ? { status: 200, json: { staff: [person] } }
        : { status: 201, json: person },
    );
    expect((await api.admin.staff()).staff).toHaveLength(1);
    const created = await api.admin.createStaff({
      displayName: 'น้องเอ',
      role: 'cashier',
      pin: '1234',
    });
    expect(created.displayName).toBe('น้องเอ');
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BASE}/v1/staff` });
    expect(bodyOf(calls[1])).toEqual({ displayName: 'น้องเอ', role: 'cashier', pin: '1234' });
    expect(calls[1]?.headers['idempotency-key']).toBeUndefined();
  });

  test('a manager PIN under 6 digits, or an owner role, never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: person }));
    await expect(
      api.admin.createStaff({ displayName: 'ผู้จัดการ', role: 'manager', pin: '1234' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(
      api.admin.createStaff({ displayName: 'x', role: 'owner' as never, pin: '123456' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('a rename or deactivation is a PATCH with the version; a PIN is a POST to its own route', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: person }));
    await api.admin.patchStaff(person.id, { expectedVersion: 2, active: false });
    await api.admin.setStaffPin(person.id, { pin: '654321' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/staff/${person.id}` });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 2, active: false });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BASE}/v1/staff/${person.id}/pin` });
    expect(bodyOf(calls[1])).toEqual({ pin: '654321' });
  });

  test('a patch with no change is refused before the network; LAST_OWNER keeps its code', async () => {
    const none = clientWith(() => ({ status: 200, json: person }));
    await expect(
      none.api.admin.patchStaff(person.id, { expectedVersion: 2 }),
    ).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(none.calls).toHaveLength(0);
    const owner = clientWith(() => apiError(409, 'LAST_OWNER'));
    await expect(
      owner.api.admin.patchStaff(person.id, { expectedVersion: 2, active: false }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  test('a PIN is never in an error', async () => {
    const { api } = clientWith(() => apiError(403, 'STEP_UP_REQUIRED'));
    const error = await api.admin
      .setStaffPin(person.id, { pin: '654321' })
      .catch((e: unknown) => e as Error);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain('654321');
  });
});
