/**
 * The order board's "claimed but no slip picture" flag (`claimWithoutSlip` on the staff order
 * DTO and the sync feed). It is stored on the order and written in the same transaction as every
 * payment change that can move it, so the realtime feed carries it: the order gets a new rev and
 * version and `order.upserted` goes out after the commit. It is a boolean: no key or path leaves.
 */
import { type OrderDto, orderDtoSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';
import { createMemorySlipStore } from './store.ts';

let tokenNo = 0;
const newToken = () => `id-token-${++tokenNo}-0000000000000000000000`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

const verifier: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    if (token === 'down') throw new LiffUnavailableError();
    return token.startsWith('id-token-') ? { userId: `Utest${token.slice(9)}` } : null;
  },
};

let h: Harness;
let menu: Menu;
let cashierToken: string;
let owner: OwnerFixture;

beforeAll(async () => {
  const runtime = createLineRuntime(
    {
      channelSecret: 'unused-test-secret',
      channelAccessToken: undefined,
      liffId: '1234567890-abcdefgh',
    },
    { liffVerifier: verifier, client: null },
  );
  h = await createHarness({ line: runtime, slips: createMemorySlipStore() });
  menu = await h.newMenu();
  h.clock.set('2028-02-01T08:00:00.000Z');
  owner = await h.newOwner();
  const device = await h.newDevice('ipad');
  const cashier = await h.newStaff('cashier', '2468');
  cashierToken = await h.pinSession(device.token, cashier.id, '2468');
  await h.client.query("insert into settings (key, value) values ('promptpay', $1::jsonb)", [
    JSON.stringify({ idType: 'phone', idValue: '0899994321' }),
  ]);
}, 60_000);
afterAll(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST', url: string, token: string | undefined, body?: unknown) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });

async function customer(): Promise<string> {
  const res = await call('POST', '/v1/app/session', undefined, { idToken: newToken() });
  const token = res.json().token as string;
  await call('POST', '/v1/app/privacy-ack', token);
  return token;
}

async function place(token: string): Promise<string> {
  const res = await call('POST', '/v1/app/orders', token, {
    clientRequestId: crypto.randomUUID(),
    items: [{ menuItemId: menu.water, qty: 1 }],
    deliveryBuilding: 'B1',
    recipientName: 'ฟ้าทดสอบ',
    paymentMethod: 'promptpay',
  });
  expect(res.statusCode).toBe(201);
  return res.json().order.id as string;
}

const upload = (token: string, orderId: string) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/app/orders/${orderId}/slip`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
    payload: JPEG,
    remoteAddress: h.nextIp(),
  });

const staffOrder = async (id: string): Promise<OrderDto> =>
  orderDtoSchema.parse((await call('GET', `/v1/orders/${id}`, cashierToken)).json());

const paymentId = async (orderId: string) =>
  (await h.client.query<{ id: string }>('select id from payments where order_id = $1', [orderId]))
    .rows[0]?.id as string;

/** The order events after `marker` for one order, newest last. */
const orderEvents = (marker: number, id: string) =>
  h.events.slice(marker).flatMap((e) => (e.type === 'order.upserted' && e.id === id ? [e] : []));

describe('claimWithoutSlip on the staff order', () => {
  test('is false on a fresh order and when the customer claims with a slip', async () => {
    const token = await customer();
    const id = await place(token);
    expect((await staffOrder(id)).claimWithoutSlip).toBe(false);
    expect((await upload(token, id)).statusCode).toBe(200);
    const order = await staffOrder(id);
    expect(order.paymentStatus).not.toBe('paid');
    expect(order.claimWithoutSlip).toBe(false);
  });

  test('a claim with no picture sets it, bumps the order and announces it after the commit', async () => {
    const token = await customer();
    const id = await place(token);
    const before = await staffOrder(id);
    const marker = h.events.length;
    expect((await call('POST', `/v1/app/orders/${id}/claim`, token)).statusCode).toBe(200);
    const after = await staffOrder(id);
    expect(after.claimWithoutSlip).toBe(true);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.rev).toBeGreaterThan(before.rev);
    const events = orderEvents(marker, id);
    expect(events.at(-1)).toMatchObject({ rev: after.rev });
    expect(events.at(-1)?.data.claimWithoutSlip).toBe(true);
  });

  test('a slip attached to that claim clears it, with a new rev and an order event', async () => {
    const token = await customer();
    const id = await place(token);
    await call('POST', `/v1/app/orders/${id}/claim`, token);
    const claimed = await staffOrder(id);
    const marker = h.events.length;
    expect((await upload(token, id)).statusCode).toBe(200);
    const after = await staffOrder(id);
    expect(after.claimWithoutSlip).toBe(false);
    expect(after.rev).toBeGreaterThan(claimed.rev);
    expect(after.version).toBeGreaterThan(claimed.version);
    const events = orderEvents(marker, id);
    expect(events).toHaveLength(1);
    expect(events[0]?.data.claimWithoutSlip).toBe(false);
    expect(events[0]?.rev).toBe(after.rev);
  });

  test('a second picture on a claim that already has one leaves the order alone', async () => {
    const token = await customer();
    const id = await place(token);
    await upload(token, id);
    const first = await staffOrder(id);
    const marker = h.events.length;
    expect((await upload(token, id)).statusCode).toBe(200);
    const after = await staffOrder(id);
    expect(after.claimWithoutSlip).toBe(false);
    expect(after.rev).toBe(first.rev);
    expect(orderEvents(marker, id)).toHaveLength(0);
  });

  test('cancelling the claim or confirming the payment clears it', async () => {
    const token = await customer();
    const cancelled = await place(token);
    await call('POST', `/v1/app/orders/${cancelled}/claim`, token);
    expect((await staffOrder(cancelled)).claimWithoutSlip).toBe(true);
    const marker = h.events.length;
    expect(
      (
        await call(
          'POST',
          `/v1/payments/${await paymentId(cancelled)}/cancel-claimed`,
          cashierToken,
          { reason: 'ไม่พบยอดเงินเข้า' },
        )
      ).statusCode,
    ).toBe(200);
    expect((await staffOrder(cancelled)).claimWithoutSlip).toBe(false);
    expect(orderEvents(marker, cancelled).at(-1)?.data.claimWithoutSlip).toBe(false);

    const confirmed = await place(token);
    await call('POST', `/v1/app/orders/${confirmed}/claim`, token);
    expect((await staffOrder(confirmed)).claimWithoutSlip).toBe(true);
    expect(
      (await call('POST', `/v1/payments/${await paymentId(confirmed)}/confirm`, cashierToken, {}))
        .statusCode,
    ).toBe(200);
    expect((await staffOrder(confirmed)).claimWithoutSlip).toBe(false);
  });

  test("an owner's void of the order cancels the claim and clears it, in the same update", async () => {
    const token = await customer();
    const id = await place(token);
    await call('POST', `/v1/app/orders/${id}/claim`, token);
    const claimed = await staffOrder(id);
    expect(claimed.claimWithoutSlip).toBe(true);
    const marker = h.events.length;
    h.clock.advanceSeconds(90);
    const voided = await call('POST', `/v1/orders/${id}/void`, await h.steppedUpOwner(owner), {
      clientRequestId: crypto.randomUUID(),
      reason: 'ลูกค้ายกเลิก',
      expectedVersion: claimed.version,
    });
    expect(voided.statusCode).toBe(201);
    const after = await staffOrder(id);
    expect(after.status).toBe('cancelled');
    expect(after.claimWithoutSlip).toBe(false);
    expect(orderEvents(marker, id).at(-1)?.data.claimWithoutSlip).toBe(false);
  });

  test('the order list and the DTO carry the boolean only: no slip key, path or hash', async () => {
    const token = await customer();
    const id = await place(token);
    await call('POST', `/v1/app/orders/${id}/claim`, token);
    const body = JSON.stringify((await call('GET', `/v1/orders/${id}`, cashierToken)).json());
    expect(body).toContain('"claimWithoutSlip":true');
    expect(body.replace('claimWithoutSlip', '')).not.toMatch(/slip/i);
  });
});
