import { describe, expect, test } from 'vitest';
import {
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';
const ID = uuid(900);
const REQUEST = uuid(901);

function clientWith() {
  const net = mockFetch(() => ({ status: 200, json: orderDto(ID, 2) }));
  const api = createApiClient({
    baseUrl: BASE,
    fetch: net.fetch,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
  });
  return { api, calls: net.calls };
}

describe('the owner correction calls', () => {
  test('correct is a PATCH of /correction with the body as given', async () => {
    const { api, calls } = clientWith();
    await api.orders.correct(ID, { expectedVersion: 3, reason: 'คีย์ผิด', note: null });
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`PATCH ${BASE}/v1/orders/${ID}/correction`);
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 3, reason: 'คีย์ผิด', note: null });
  });

  test('void is a POST whose Idempotency-Key is the clientRequestId', async () => {
    const { api, calls } = clientWith();
    await api.orders.void(ID, { clientRequestId: REQUEST, reason: 'ซ้ำ', paymentAction: 'refund' });
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`POST ${BASE}/v1/orders/${ID}/void`);
    expect(calls[0]?.headers['idempotency-key']).toBe(REQUEST);
    expect(bodyOf(calls[0])).toEqual({
      clientRequestId: REQUEST,
      reason: 'ซ้ำ',
      paymentAction: 'refund',
    });
  });

  test('a void without a reason is refused before the network', async () => {
    const { api, calls } = clientWith();
    await expect(api.orders.void(ID, { clientRequestId: REQUEST, reason: ' ' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
