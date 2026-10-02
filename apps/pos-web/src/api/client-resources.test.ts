import { describe, expect, test } from 'vitest';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { categoryDto, orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { type ApiClientOptions, createApiClient } from './client.ts';
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

const ORDER = uuid(1);
const PAYMENT = uuid(2);
const KEY = uuid(3);
const order = orderDto(ORDER, 9);
const payment = paymentDto(PAYMENT, ORDER, 10);

describe('menu', () => {
  test('the public menu needs no session and asks for a channel', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { channel: 'storefront', categories: [] },
    }));
    expect(await api.menu.publicMenu('storefront')).toEqual({
      channel: 'storefront',
      categories: [],
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu?channel=storefront`);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  test('the staff lists carry the session and are parsed with the shared DTOs', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { categories: [categoryDto(uuid(5), 3)] },
    }));
    const result = await api.menu.listCategories();
    expect(result.categories[0]?.id).toBe(uuid(5));
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/categories`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a list that does not match the schema is a RESPONSE_INVALID error', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { items: [{ id: 'nope' }] } }));
    await expect(api.menu.listItems()).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });
});

describe('recipients', () => {
  const saved = {
    id: uuid(40),
    building: 'B1',
    recipientName: 'Fah',
    deliveryNote: null,
    lastOrderAt: null,
  };

  test('lists the latest ones with the session, asking for a limit and nothing else', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { recipients: [saved] } }));
    expect((await api.recipients.list({ limit: 8 })).recipients).toEqual([saved]);
    expect(calls[0]?.url).toBe(`${BASE}/v1/recipients?limit=8`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a search sends the typed text as q, encoded', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { recipients: [] } }));
    await api.recipients.list({ q: 'ฟ้า a&b', limit: 8 });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('ฟ้า a&b');
    expect(url.searchParams.get('limit')).toBe('8');
  });

  test('an answer that is not a list of recipients is RESPONSE_INVALID', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { recipients: [{ id: 1 }] } }));
    await expect(api.recipients.list({})).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  test('a failed search keeps the code only: the typed name is not in the error', async () => {
    const { api } = clientWith(() => {
      throw new TypeError('failed to fetch https://api.example.test/v1/recipients?q=SECRETNAME');
    });
    const error = await api.recipients.list({ q: 'SECRETNAME' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(JSON.stringify(error)).not.toContain('SECRETNAME');
    expect((error as ApiClientError).message).toBe('NETWORK');
  });
});

describe('delivery settings', () => {
  test('reads the building list with its rev, for the order screen', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: {
        value: { buildings: ['A1', 'B1'] },
        version: 0,
        rev: 0,
        updatedAt: null,
      },
    }));
    const result = await api.settings.delivery();
    expect(result.value.buildings).toEqual(['A1', 'B1']);
    expect(calls[0]?.url).toBe(`${BASE}/v1/settings/delivery`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });
});

describe('an order to the building entrance', () => {
  test('carries building, name, details and the customer id; the request id as before', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: order }));
    await api.orders.create(
      {
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah',
        deliveryNote: 'ชั้น 3',
        customerId: uuid(40),
        items: [{ menuItemId: uuid(7), qty: 1, modifierOptionIds: [] }],
      },
      { clientRequestId: KEY },
    );
    expect(bodyOf(calls[0])).toMatchObject({
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Fah',
      deliveryNote: 'ชั้น 3',
      customerId: uuid(40),
      clientRequestId: KEY,
    });
  });

  test('an entrance order without a name is refused before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: order }));
    await expect(
      api.orders.create({
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        items: [{ menuItemId: uuid(7), qty: 1, modifierOptionIds: [] }],
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });
});

describe('sync', () => {
  test('asks for changes since a rev, with a limit', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { changes: [], nextSince: 40, hasMore: false, serverRev: 40 },
    }));
    const page = await api.sync.changes({ since: 12, limit: 200 });
    expect(page).toEqual({ changes: [], nextSince: 40, hasMore: false, serverRev: 40 });
    expect(calls[0]?.url).toBe(`${BASE}/v1/sync?since=12&limit=200`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('a negative since fails before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }));
    await expect(api.sync.changes({ since: -1 })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('payments', () => {
  test('create sends the idempotency key in the body and the header, and no amount', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: { payment, order } }));
    const outcome = await api.payments.create(
      ORDER,
      { method: 'cash', tendered: 20000 },
      { clientRequestId: KEY },
    );
    expect(outcome.replay).toBe(false);
    expect(outcome.result.payment.id).toBe(PAYMENT);
    expect(calls[0]?.url).toBe(`${BASE}/v1/orders/${ORDER}/payments`);
    expect(calls[0]?.headers['idempotency-key']).toBe(KEY);
    expect(bodyOf(calls[0])).toEqual({ method: 'cash', tendered: 20000, clientRequestId: KEY });
  });

  test('a 200 answer is a replay of the same request', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { payment, order } }));
    const outcome = await api.payments.create(ORDER, { method: 'promptpay' });
    expect(outcome.replay).toBe(true);
  });

  test('the client refuses an amount in the request (the server charges the order total)', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: { payment, order } }));
    await expect(
      api.payments.create(ORDER, {
        method: 'promptpay',
        amountSatang: 1,
      } as unknown as Parameters<typeof api.payments.create>[1]),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('the moves post to their own address and return the payment and the order', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { payment, order } }));
    await api.payments.claim(PAYMENT);
    await api.payments.confirm(PAYMENT, { referenceNote: 'ref-1' });
    await api.payments.cancelClaimed(PAYMENT, { reason: 'ลูกค้ายังไม่โอน' });
    await api.payments.void(PAYMENT, { reason: 'คิดผิด' });
    await api.payments.refund(PAYMENT, { reason: 'ลูกค้าไม่รับ' });
    expect(calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      `POST /v1/payments/${PAYMENT}/claim`,
      `POST /v1/payments/${PAYMENT}/confirm`,
      `POST /v1/payments/${PAYMENT}/cancel-claimed`,
      `POST /v1/payments/${PAYMENT}/void`,
      `POST /v1/payments/${PAYMENT}/refund`,
    ]);
    expect(bodyOf(calls[1])).toEqual({ referenceNote: 'ref-1' });
  });

  test('void and refund need a reason before anything is sent', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { payment, order } }));
    await expect(api.payments.void(PAYMENT, { reason: '' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(0);
  });

  test('change method returns the replacement, the cancelled payment and the order', async () => {
    const replacement = paymentDto(uuid(4), ORDER, 11, { method: 'promptpay', status: 'pending' });
    const { api, calls } = clientWith(() => ({
      status: 201,
      json: { payment: replacement, cancelledPayment: payment, order },
    }));
    const outcome = await api.payments.changeMethod(
      PAYMENT,
      { method: 'promptpay' },
      { clientRequestId: KEY },
    );
    expect(outcome.result.cancelledPayment.id).toBe(PAYMENT);
    expect(calls[0]?.url).toBe(`${BASE}/v1/payments/${PAYMENT}/change-method`);
    expect(calls[0]?.headers['idempotency-key']).toBe(KEY);
  });

  test('the QR link comes back as an absolute address on the API origin', async () => {
    const { api } = clientWith(() => ({
      status: 200,
      json: {
        url: `/v1/payments/${PAYMENT}/qr.png?exp=1&sig=abc`,
        expiresAt: '2030-01-01T05:05:00.000Z',
        promptpayTargetMasked: '******1234',
      },
    }));
    const qr = await api.payments.qrUrl(PAYMENT);
    expect(qr.url).toBe(`${BASE}/v1/payments/${PAYMENT}/qr.png?exp=1&sig=abc`);
    expect(qr.promptpayTargetMasked).toBe('******1234');
  });

  test('list returns the payments of an order', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { payments: [payment] } }));
    expect((await api.payments.list(ORDER)).payments).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/v1/orders/${ORDER}/payments`);
  });

  test('a payment error keeps its code for the screen to map', async () => {
    const { api } = clientWith(() => apiError(422, 'TENDERED_BELOW_TOTAL'));
    const error = await api.payments
      .create(ORDER, { method: 'cash', tendered: 100 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: 'TENDERED_BELOW_TOTAL', status: 422 });
  });
});

describe('a refused order', () => {
  test('keeps the failing line and code, and nothing else from the body', async () => {
    const { api } = clientWith(() =>
      apiError(422, 'ORDER_INVALID', {
        errors: [
          { code: 'ITEM_UNAVAILABLE', lineIndex: 2, menuItemId: uuid(8) },
          { code: 'GROUP_TOO_FEW', lineIndex: 0, menuItemId: uuid(9), groupId: uuid(7) },
        ],
      }),
    );
    const error = await api.orders
      .create({
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Tester',
        items: [{ menuItemId: uuid(8), qty: 1 }],
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'ORDER_INVALID',
      lineErrors: [
        { code: 'ITEM_UNAVAILABLE', lineIndex: 2 },
        { code: 'GROUP_TOO_FEW', lineIndex: 0 },
      ],
    });
  });
});
