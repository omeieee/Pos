import { describe, expect, test, vi } from 'vitest';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_EMAIL,
  FAKE_SESSION_TOKEN,
  IDS,
  mockFetch,
  sessionBody,
} from '../test-support/fixtures.ts';
import { type ApiClientOptions, createApiClient, newClientRequestId } from './client.ts';
import { ApiClientError } from './errors.ts';

const BASE = 'https://api.example.test';

function clientWith(
  responder: Parameters<typeof mockFetch>[0],
  overrides: Partial<ApiClientOptions> = {},
) {
  const net = mockFetch(responder);
  const api = createApiClient({
    baseUrl: BASE,
    fetch: net.fetch,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
    ...overrides,
  });
  return { api, calls: net.calls };
}

const orderBody = {
  id: IDS.order,
  orderNo: 'S-001',
  businessDate: '2030-01-01',
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  roomNo: null,
  deliveryBuilding: 'B1',
  recipientName: 'Tester',
  deliveryNote: null,
  customerId: null,
  status: 'new',
  paymentStatus: 'unpaid',
  subtotalSatang: 5000,
  discountSatang: 0,
  totalSatang: 5000,
  note: null,
  createdByStaffId: IDS.cashier,
  createdOnDeviceId: IDS.device,
  placedAt: '2030-01-01T05:00:00.000Z',
  acceptedAt: null,
  readyAt: null,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  rev: 7,
  items: [],
};

const newOrder = {
  channel: 'storefront' as const,
  fulfillment: 'entrance_delivery' as const,
  deliveryBuilding: 'B1',
  recipientName: 'Tester',
  items: [{ menuItemId: IDS.menuItem, qty: 1 }],
};

describe('headers', () => {
  test('the staff list sends the device token only, as a header, and no body headers', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { staff: [{ id: IDS.cashier, displayName: 'พนักงานตัวอย่าง', role: 'cashier' }] },
    }));
    const result = await api.auth.listStaff();
    expect(result.staff).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`${BASE}/v1/auth/staff`);
    expect(call?.headers['x-device-token']).toBe(FAKE_DEVICE_TOKEN);
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.headers['content-type']).toBeUndefined();
  });

  test('an authenticated call sends both tokens as headers and puts neither in the URL', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { staff: [] } }));
    await api.auth.listStaff();
    const withSession = clientWith(() => ({
      status: 200,
      json: {
        staff: { id: IDS.cashier, displayName: 'พนักงานตัวอย่าง', role: 'cashier' },
        deviceId: IDS.device,
        permissions: [],
        expiresAt: '2030-01-01T12:00:00.000Z',
        stepUpUntil: null,
      },
    }));
    await withSession.api.auth.me();
    const call = withSession.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
    expect(call?.headers['x-device-token']).toBe(FAKE_DEVICE_TOKEN);
    expect(call?.url).not.toContain(FAKE_SESSION_TOKEN);
    expect(call?.url).not.toContain(FAKE_DEVICE_TOKEN);
    expect(calls[0]?.url).not.toContain(FAKE_DEVICE_TOKEN);
  });

  test('sends no device header when the device has no token (owner sign-in on a new device)', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: sessionBody('owner') }), {
      getDeviceToken: () => null,
    });
    await api.auth.ownerLogin({
      email: FAKE_EMAIL,
      password: 'not-a-real-password',
      totp: '123456',
    });
    expect(calls[0]?.headers['x-device-token']).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  test('normalises the e-mail with the shared schema before sending', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: sessionBody('owner') }));
    await api.auth.ownerLogin({
      email: `  ${FAKE_EMAIL.toUpperCase()} `,
      password: 'x',
      recoveryCode: 'ABCD-EFGH-JKLM-NPQR',
    });
    expect(bodyOf(calls[0]).email).toBe(FAKE_EMAIL);
  });

  test('a call that needs a session fails locally when there is none', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }), {
      getSessionToken: () => null,
    });
    await expect(api.auth.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls).toHaveLength(0);
  });

  test('a call that needs this device fails locally when it has no token', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }), {
      getDeviceToken: () => null,
    });
    await expect(api.auth.listStaff()).rejects.toMatchObject({ code: 'DEVICE_UNREGISTERED' });
    await expect(api.auth.pinLogin({ staffId: IDS.cashier, pin: '1234' })).rejects.toMatchObject({
      code: 'DEVICE_UNREGISTERED',
    });
    expect(calls).toHaveLength(0);
  });

  test('logout sends no body and no JSON content type, and accepts 204', async () => {
    const { api, calls } = clientWith(() => ({ status: 204 }));
    await expect(api.auth.logout()).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  test('logout can revoke a session the store already cleared locally', async () => {
    const { api, calls } = clientWith(() => ({ status: 204 }), { getSessionToken: () => null });
    await api.auth.logout('sds_ses_EXPLICITEXPLICITEXPLICIT01');
    expect(calls[0]?.headers.authorization).toBe('Bearer sds_ses_EXPLICITEXPLICITEXPLICIT01');
  });

  test('never uses cookies, the HTTP cache or the referrer', async () => {
    const seen: RequestInit[] = [];
    const api = createApiClient({
      baseUrl: BASE,
      getSessionToken: () => null,
      getDeviceToken: () => null,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify(sessionBody('owner')), { status: 200 });
      }) as typeof fetch,
    });
    await api.auth.ownerLogin({ email: FAKE_EMAIL, password: 'x', totp: '123456' });
    expect(seen[0]).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  });
});

describe('schema validation', () => {
  test('a body that does not match the shared schema is RESPONSE_INVALID', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { staff: [{ id: 'not-a-uuid' }] } }));
    await expect(api.auth.listStaff()).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
      status: 200,
    });
  });

  test('an HTML body on a 200 (a captive portal) is RESPONSE_INVALID, not a crash', async () => {
    const { api } = clientWith(() => ({ status: 200, text: '<html>Wi-Fi login</html>' }));
    await expect(api.auth.listStaff()).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  test('input that fails the shared request schema never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }));
    await expect(api.auth.pinLogin({ staffId: IDS.cashier, pin: '12' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    await expect(api.auth.ownerLogin({ email: FAKE_EMAIL, password: 'x' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    await expect(api.orders.get('not-a-uuid')).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('the error carries no response content and no token', async () => {
    const secret = 'super-secret-body-content';
    const { api } = clientWith(() => ({ status: 200, json: { staff: secret } }));
    const error = await api.auth.listStaff().catch((e: unknown) => e);
    const printed = [String(error), JSON.stringify(error), (error as Error).stack ?? ''].join('|');
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(FAKE_SESSION_TOKEN);
    expect(printed).not.toContain(FAKE_DEVICE_TOKEN);
  });
});

describe('error mapping', () => {
  test.each([
    [409, 'VERSION_CONFLICT', { currentVersion: 4 }],
    [409, 'INVALID_TRANSITION', { from: 'new', to: 'completed' }],
    [422, 'ORDER_INVALID', { errors: [{ code: 'ITEM_UNAVAILABLE', lineIndex: 0 }] }],
    [409, 'IDEMPOTENCY_KEY_REUSED', {}],
    [400, 'IDEMPOTENCY_KEY_MISMATCH', {}],
    [401, 'DEVICE_MISMATCH', {}],
    [403, 'STEP_UP_REQUIRED', {}],
    [503, 'SECOND_FACTOR_UNAVAILABLE', {}],
  ])('%i %s keeps the stable code and drops the server text', async (status, code, details) => {
    const { api } = clientWith(() => apiError(status, code, details));
    const error = await api.orders.get(IDS.order).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code, status });
    expect((error as ApiClientError).message).toBe(code);
  });

  test('reads the version, the lock wait and the rate-limit wait', async () => {
    const conflict = clientWith(() => apiError(409, 'VERSION_CONFLICT', { currentVersion: 4 }));
    await expect(conflict.api.orders.get(IDS.order)).rejects.toMatchObject({ currentVersion: 4 });

    const locked = clientWith(() => apiError(423, 'ACCOUNT_LOCKED', { retryAfterSeconds: 3600 }));
    await expect(
      locked.api.auth.pinLogin({ staffId: IDS.cashier, pin: '1234' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED', retryAfterSeconds: 3600 });

    const limited = clientWith(() => apiError(429, 'RATE_LIMITED', { retryAfterMs: 1500 }));
    await expect(limited.api.auth.listStaff()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 2,
    });
  });

  test('a proxy error page without our JSON still maps to a code', async () => {
    const { api } = clientWith(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
    await expect(api.auth.listStaff()).rejects.toMatchObject({ code: 'INTERNAL', status: 502 });
  });

  test('a code from a newer API is passed through as is', async () => {
    const { api } = clientWith(() => apiError(409, 'SOMETHING_NEW'));
    await expect(api.auth.listStaff()).rejects.toMatchObject({ code: 'SOMETHING_NEW' });
  });

  test('a network failure and a timeout are distinct and carry no URL', async () => {
    const down = createApiClient({
      baseUrl: BASE,
      getSessionToken: () => null,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
      fetch: (() => Promise.reject(new TypeError(`Failed to fetch ${BASE}`))) as typeof fetch,
    });
    const networkError = await down.auth.listStaff().catch((e: unknown) => e);
    expect(networkError).toMatchObject({ code: 'NETWORK' });
    expect(String(networkError)).not.toContain('example.test');

    const slow = createApiClient({
      baseUrl: BASE,
      timeoutMs: 10,
      getSessionToken: () => null,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          );
        })) as typeof fetch,
    });
    await expect(slow.auth.listStaff()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('auth failure hook', () => {
  test('fires for an expired session, a removed device and a device mismatch', async () => {
    const seen: string[] = [];
    const onAuthFailure = vi.fn((e: ApiClientError) => seen.push(e.code));
    for (const code of ['UNAUTHENTICATED', 'DEVICE_UNREGISTERED', 'DEVICE_MISMATCH']) {
      const { api } = clientWith(() => apiError(401, code), { onAuthFailure });
      await api.orders.list().catch(() => undefined);
    }
    expect(seen).toEqual(['UNAUTHENTICATED', 'DEVICE_UNREGISTERED', 'DEVICE_MISMATCH']);
  });

  test('does not fire for a wrong PIN, a lock or a missing permission', async () => {
    const onAuthFailure = vi.fn();
    for (const [status, code] of [
      [401, 'INVALID_CREDENTIALS'],
      [423, 'ACCOUNT_LOCKED'],
      [403, 'FORBIDDEN'],
      [403, 'STEP_UP_REQUIRED'],
    ] as const) {
      const { api } = clientWith(() => apiError(status, code, { retryAfterSeconds: 5 }), {
        onAuthFailure,
      });
      await api.auth.pinLogin({ staffId: IDS.cashier, pin: '1234' }).catch(() => undefined);
    }
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  test('UNAUTHENTICATED on a request without a session is not a "session ended" signal', async () => {
    const onAuthFailure = vi.fn();
    const { api } = clientWith(() => apiError(401, 'UNAUTHENTICATED'), { onAuthFailure });
    await api.auth.listStaff().catch(() => undefined);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  test('a throwing listener does not hide the real error', async () => {
    const { api } = clientWith(() => apiError(401, 'DEVICE_UNREGISTERED'), {
      onAuthFailure: () => {
        throw new Error('listener bug');
      },
    });
    await expect(api.auth.listStaff()).rejects.toMatchObject({ code: 'DEVICE_UNREGISTERED' });
  });
});

describe('idempotent order creation', () => {
  test('sends the request id in the body and in Idempotency-Key, with the session', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: orderBody }));
    const result = await api.orders.create(newOrder);
    const call = calls[0];
    const body = call?.body as { clientRequestId: string; items: unknown[] };
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${BASE}/v1/orders`);
    expect(body.clientRequestId).toBe(result.clientRequestId);
    expect(call?.headers['idempotency-key']).toBe(body.clientRequestId);
    expect(call?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
    expect(result.replay).toBe(false);
    expect(result.order.orderNo).toBe('S-001');
  });

  test('two new orders get two different ids', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: orderBody }));
    await api.orders.create(newOrder);
    await api.orders.create(newOrder);
    const ids = calls.map((c) => (c.body as { clientRequestId: string }).clientRequestId);
    expect(new Set(ids).size).toBe(2);
  });

  test('a retry of the same order reuses the id it was given, and 200 means replay', async () => {
    const id = newClientRequestId();
    let first = true;
    const { api, calls } = clientWith(() => {
      if (first) {
        first = false;
        return apiError(503, 'DB_UNAVAILABLE');
      }
      return { status: 200, json: orderBody };
    });
    await expect(api.orders.create(newOrder, { clientRequestId: id })).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });
    const retry = await api.orders.create(newOrder, { clientRequestId: id });
    expect(retry.replay).toBe(true);
    expect(retry.clientRequestId).toBe(id);
    expect(calls.map((c) => (c.body as { clientRequestId: string }).clientRequestId)).toEqual([
      id,
      id,
    ]);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual([id, id]);
  });

  test('never sends a price: only ids, quantities and notes', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: orderBody }));
    await api.orders.create(newOrder);
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/price|total|satang/i);
  });
});

describe('orders: other calls', () => {
  test('PATCH sends expectedVersion and goes to the encoded order path', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: orderBody }));
    await api.orders.patch(IDS.order, { expectedVersion: 1, note: 'ไม่ใส่ผัก' });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(`${BASE}/v1/orders/${IDS.order}`);
    expect(bodyOf(calls[0]).expectedVersion).toBe(1);
  });

  test('a stale PATCH surfaces VERSION_CONFLICT with the current version', async () => {
    const { api } = clientWith(() => apiError(409, 'VERSION_CONFLICT', { currentVersion: 3 }));
    await expect(
      api.orders.patch(IDS.order, { expectedVersion: 1, note: 'x' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 3 });
  });

  test('list puts the filters in the query string, not the tokens', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { day: '2030-01-01', orders: [orderBody] },
    }));
    const result = await api.orders.list({ day: '2030-01-01', status: 'new' });
    expect(calls[0]?.url).toBe(`${BASE}/v1/orders?day=2030-01-01&status=new`);
    expect(result.orders).toHaveLength(1);
  });

  test('transition and cancel post to their paths', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: orderBody }));
    await api.orders.transition(IDS.order, { to: 'preparing' });
    await api.orders.cancel(IDS.order, { reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/orders/${IDS.order}/transition`,
      `${BASE}/v1/orders/${IDS.order}/cancel`,
    ]);
  });
});
