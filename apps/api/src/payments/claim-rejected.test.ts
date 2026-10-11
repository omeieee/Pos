/**
 * Staff reject a claimed payment ("โอนแล้ว" but no money found, `cancel-claimed`): the LINE
 * customer gets ONE message through the quota-aware sender, once per payment.
 */
import type { LineClient, LineMessage, TextMessage } from '@sds/line';
import { type OrderDto, orderDtoSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';

const SECRET = 'test-channel-secret-not-real';
const LINE_USER = 'Utest00000000000000000000000000e5';
const pushes: { to: string; messages: LineMessage[] }[] = [];
const fakeClient: LineClient = {
  async reply() {
    return { ok: true };
  },
  async push(to, messages) {
    pushes.push({ to, messages });
    return { ok: true };
  },
};

let h: Harness;
let menu: Menu;
let device: { id: string; token: string };
let cashierId: string;
let runtime: ReturnType<typeof createLineRuntime>;

beforeAll(async () => {
  runtime = createLineRuntime(
    { channelSecret: SECRET, channelAccessToken: undefined },
    { client: fakeClient },
  );
  h = await createHarness({ line: runtime });
  menu = await h.newMenu();
  device = await h.newDevice();
  cashierId = (await h.newStaff('cashier', '4821')).id;
  await h.client.query(
    `insert into settings (key, value) values ('promptpay', '{"idType":"phone","idValue":"0812345678"}'::jsonb)
     on conflict (key) do nothing`,
  );
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 0;
function newDay(): void {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2030, 5, dayNo, 3, 0, 0)).toISOString());
}

function call(method: 'GET' | 'POST', url: string, token: string, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}
const cashier = () => h.pinSession(device.token, cashierId, '4821');
const textOf = (m: LineMessage | undefined) => (m as TextMessage | undefined)?.text ?? '';

async function place(token: string, asLine: boolean): Promise<OrderDto> {
  const res = await call('POST', '/v1/orders', token, {
    clientRequestId: crypto.randomUUID(),
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    items: [{ menuItemId: menu.water, qty: 1, modifierOptionIds: [] }],
  });
  const order = orderDtoSchema.parse(res.json());
  if (asLine) {
    const [cust] = (
      await h.client.query<{ id: string }>(
        `insert into customers (line_user_id) values ($1)
         on conflict (line_user_id) do update set line_user_id = excluded.line_user_id returning id`,
        [LINE_USER],
      )
    ).rows;
    await h.client.query("update orders set channel = 'line', customer_id = $1 where id = $2", [
      cust?.id,
      order.id,
    ]);
  }
  return order;
}

async function claimed(token: string, orderId: string): Promise<string> {
  const created = await call('POST', `/v1/orders/${orderId}/payments`, token, {
    clientRequestId: crypto.randomUUID(),
    method: 'promptpay',
  });
  const id = (created.json() as { payment: { id: string } }).payment.id;
  expect((await call('POST', `/v1/payments/${id}/claim`, token, {})).statusCode).toBe(200);
  return id;
}
const reject = (token: string, id: string) =>
  call('POST', `/v1/payments/${id}/cancel-claimed`, token, { reason: 'ไม่พบยอดเงินเข้า' });
const reset = async () => {
  pushes.length = 0;
  await h.client.query('delete from line_quota_months');
};

describe('staff reject a claimed payment', () => {
  test('the LINE customer gets one message with the order number; a retry sends none', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const order = await place(token, true);
    const id = await claimed(token, order.id);
    expect((await reject(token, id)).statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.to).toBe(LINE_USER);
    expect(textOf(pushes[0]?.messages[0])).toContain(order.orderNo);
    expect(textOf(pushes[0]?.messages[0])).toContain('ยังไม่พบยอดโอน');
    // A lost response retried: the payment is already cancelled and nothing more is sent.
    expect((await reject(token, id)).statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(1);
  });

  test('a second rejected claim on the same order is its own message', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const order = await place(token, true);
    await reject(token, await claimed(token, order.id));
    await reject(token, await claimed(token, order.id));
    await runtime.idle();
    expect(pushes).toHaveLength(2);
  });

  test('a counter order, an unclaimed cancel and an exhausted quota send nothing and never fail', async () => {
    newDay();
    await reset();
    const token = await cashier();
    const counter = await place(token, false);
    expect((await reject(token, await claimed(token, counter.id))).statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(0);

    const line = await place(token, true);
    await h.client.query(
      `insert into settings (key, value) values ('line_policy', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ push: 'off', warnAtPercent: 80, monthlyLimit: 300 })],
    );
    expect((await reject(token, await claimed(token, line.id))).statusCode).toBe(200);
    await runtime.idle();
    expect(pushes).toHaveLength(0);
    await h.client.query("delete from settings where key = 'line_policy'");
  });
});
