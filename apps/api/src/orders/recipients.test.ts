import { type OrderDto, orderDtoSchema, recipientsResponseSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', { id: string; pin: string }>;

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  device = await h.newDevice();
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 0;
function newDay() {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2029, 0, dayNo, 3, 0, 0)).toISOString());
}
const sign = (role: 'cashier' | 'manager' | 'kitchen') =>
  h.pinSession(device.token, staff[role].id, staff[role].pin);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Made-up recipients only: no real customer data in tests.
const body = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Test Alpha',
  items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  ...over,
});

async function place(over: Record<string, unknown> = {}, token?: string): Promise<OrderDto> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: bearer(token ?? (await sign('cashier'))),
    payload: body(over),
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}

const recipients = (token: string | undefined, query = '') =>
  h.app.inject({
    method: 'GET',
    url: `/v1/recipients${query}`,
    headers: token ? bearer(token) : {},
  });

const customerRow = async (id: string) =>
  (await h.client.query<Record<string, unknown>>('select * from customers where id = $1', [id]))
    .rows[0];
const customerCount = async () =>
  Number(
    (await h.client.query<{ n: number }>('select count(*)::int as n from customers')).rows[0]?.n,
  );

describe('GET /v1/recipients', () => {
  beforeAll(async () => {
    newDay();
    const cashier = await sign('cashier');
    for (const [building, name, note] of [
      ['B1', 'Rec Anna', 'ชั้น 1'],
      ['B1', 'Rec Bella', null],
      ['C2', 'Other Anna', null],
      ['D1', 'Rec Cara', null],
    ] as const) {
      h.clock.advanceSeconds(60);
      await place(
        {
          deliveryBuilding: building,
          recipientName: name,
          ...(note ? { deliveryNote: note } : {}),
        },
        cashier,
      );
    }
    // A customer with personal data of other kinds, and no recipient: never listed.
    await h.client.query(
      "insert into customers (display_name, phone, picture_url) values ('No Recipient', '0811111111', 'https://img.example.test/x.jpg')",
    );
  }, 60_000);

  test('needs a session and the order.create permission', async () => {
    expect((await recipients(undefined)).statusCode).toBe(401);
    const kitchen = await recipients(await sign('kitchen'));
    expect(kitchen.statusCode).toBe(403);
    expect(kitchen.json()).toMatchObject({ code: 'FORBIDDEN' });
    for (const role of ['cashier', 'manager'] as const) {
      expect((await recipients(await sign(role))).statusCode, role).toBe(200);
    }
  });

  test('most recent first, with exactly five fields and no cache', async () => {
    const res = await recipients(await sign('cashier'));
    expect(res.headers['cache-control']).toBe('no-store');
    const { recipients: list } = recipientsResponseSchema.parse(res.json());
    expect(list.map((r) => r.recipientName)).toEqual([
      'Rec Cara',
      'Other Anna',
      'Rec Bella',
      'Rec Anna',
    ]);
    expect(list[3]).toMatchObject({ building: 'B1', deliveryNote: 'ชั้น 1' });
    expect(Object.keys(res.json().recipients[0]).sort()).toEqual(
      ['building', 'deliveryNote', 'id', 'lastOrderAt', 'recipientName'].sort(),
    );
    expect(res.body).not.toMatch(/phone|picture|line|consent|0811111111|orderCount|order_count/i);
  });

  test('filters by name (case and spacing do not matter) and by building', async () => {
    const cashier = await sign('cashier');
    const names = async (query: string) =>
      (await recipients(cashier, query))
        .json()
        .recipients.map((r: { recipientName: string }) => r.recipientName);
    expect(await names('?q=anna')).toEqual(['Other Anna', 'Rec Anna']);
    expect(await names('?q=%20%20REC%20')).toEqual(['Rec Cara', 'Rec Bella', 'Rec Anna']);
    expect(await names('?building=B1')).toEqual(['Rec Bella', 'Rec Anna']);
    expect(await names('?building=B1&q=ann')).toEqual(['Rec Anna']);
    expect(await names('?q=zzz')).toEqual([]);
    expect(await names('?q=%25')).toEqual([]); // "%" is a character, not a wildcard
  });

  test('the limit defaults to 8, is at most 20, and a bad value is a validation error', async () => {
    const cashier = await sign('cashier');
    expect((await recipients(cashier, '?limit=2')).json().recipients).toHaveLength(2);
    expect((await recipients(cashier, '?limit=20')).statusCode).toBe(200);
    for (const bad of ['?limit=21', '?limit=0', '?limit=x', `?q=${'x'.repeat(61)}`]) {
      const res = await recipients(cashier, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  test('more than 8 matches return 8 by default', async () => {
    const cashier = await sign('cashier');
    for (let i = 0; i < 10; i += 1) {
      await place({ deliveryBuilding: 'A1', recipientName: `Many ${i}` }, cashier);
    }
    expect((await recipients(cashier, '?q=many')).json().recipients).toHaveLength(8);
    expect((await recipients(cashier, '?q=many&limit=20')).json().recipients).toHaveLength(10);
  });

  test('an anonymised customer is not listed', async () => {
    const cashier = await sign('cashier');
    const order = await place({ deliveryBuilding: 'A2', recipientName: 'Rec Erased' }, cashier);
    await h.client.query('update customers set anonymized_at = now() where id = $1', [
      order.customerId,
    ]);
    expect((await recipients(cashier, '?q=erased')).json().recipients).toEqual([]);
  });

  test('the search text is in no log line', async () => {
    const cashier = await sign('cashier');
    await recipients(cashier, '?q=Zzyx-Search-Text&building=B1');
    expect(h.logs()).toContain('/v1/recipients'); // the request is logged...
    expect(h.logs()).not.toContain('Zzyx-Search-Text'); // ...without its query string
  });
});

describe('automatic customer memory on POST /v1/orders', () => {
  test('the first order for a recipient creates the customer and links it to the order', async () => {
    newDay();
    const before = await customerCount();
    const order = await place({
      deliveryBuilding: 'A1',
      recipientName: 'Memory One',
      deliveryNote: 'ชั้น 3',
    });
    expect(await customerCount()).toBe(before + 1);
    expect(order.customerId).not.toBeNull();
    expect(await customerRow(order.customerId ?? '')).toMatchObject({
      building: 'A1',
      recipient_name: 'Memory One',
      delivery_note: 'ชั้น 3',
      order_count: 1,
      total_spent_satang: 0,
      line_user_id: null,
    });
    const stored = await h.client.query<{ customer_id: string }>(
      'select customer_id from orders where id = $1',
      [order.id],
    );
    expect(stored.rows[0]?.customer_id).toBe(order.customerId);
  });

  test('the same building and name, in any case or spacing, is the same customer; the count grows', async () => {
    newDay();
    const first = await place({ deliveryBuilding: 'B2', recipientName: 'Memory Two' });
    const second = await place({
      deliveryBuilding: 'B2',
      recipientName: '  memory   TWO ',
      deliveryNote: 'ใหม่',
    });
    expect(second.customerId).toBe(first.customerId);
    expect(await customerRow(first.customerId ?? '')).toMatchObject({
      order_count: 2,
      recipient_name: 'memory   TWO', // the last used spelling
      delivery_note: 'ใหม่',
    });
    const other = await place({ deliveryBuilding: 'C1', recipientName: 'Memory Two' });
    expect(other.customerId).not.toBe(first.customerId);
  });

  test('a replay of the same request does not count twice, and a refused order counts nothing', async () => {
    newDay();
    const cashier = await sign('cashier');
    const request = body({ deliveryBuilding: 'C2', recipientName: 'Memory Three' });
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: bearer(cashier),
        payload: request,
      });
    const created = await send();
    expect(created.statusCode).toBe(201);
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(await customerRow(created.json().customerId)).toMatchObject({ order_count: 1 });

    const before = await customerCount();
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: bearer(cashier),
      payload: body({
        deliveryBuilding: 'D1',
        recipientName: 'Memory Refused',
        items: [{ menuItemId: menu.soldOut, qty: 1, modifierOptionIds: [] }],
      }),
    });
    expect(bad.statusCode).toBe(422);
    expect(await customerCount()).toBe(before);
    const unknownBuilding = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: bearer(cashier),
      payload: body({ deliveryBuilding: 'ZZ', recipientName: 'Memory Refused' }),
    });
    expect(unknownBuilding.statusCode).toBe(422);
    expect(await customerCount()).toBe(before);
  });

  test('a customer id from the client is used, and its recipient details are updated', async () => {
    newDay();
    const first = await place({ deliveryBuilding: 'D1', recipientName: 'Memory Four' });
    const again = await place({
      customerId: first.customerId,
      deliveryBuilding: 'D1',
      recipientName: 'Memory Four',
      deliveryNote: 'ถือร่ม',
    });
    expect(again.customerId).toBe(first.customerId);
    expect(await customerRow(first.customerId ?? '')).toMatchObject({
      order_count: 2,
      delivery_note: 'ถือร่ม',
    });
  });

  test('a customer id that does not exist is refused', async () => {
    newDay();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: bearer(await sign('cashier')),
      payload: body({ customerId: crypto.randomUUID() }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_CUSTOMER' });
  });

  test('a LINE customer given by id is linked and counted, never given recipient details, and never matched by name', async () => {
    newDay();
    const line = await h.client.query<{ id: string }>(
      "insert into customers (line_user_id, display_name) values ('U-test-line-order', 'Test Line') returning id",
    );
    const lineId = line.rows[0]?.id ?? '';
    const viaLine = await place({
      channel: 'line',
      customerId: lineId,
      deliveryBuilding: 'A2',
      recipientName: 'Memory Five',
    });
    expect(viaLine.customerId).toBe(lineId);
    expect(await customerRow(lineId)).toMatchObject({
      line_user_id: 'U-test-line-order',
      building: null,
      recipient_name: null,
      recipient_key: null,
      order_count: 1,
    });
    const byName = await place({ deliveryBuilding: 'A2', recipientName: 'Memory Five' });
    expect(byName.customerId).not.toBe(lineId);
  });

  test('a platform order creates no customer', async () => {
    newDay();
    const before = await customerCount();
    const order = await place({
      channel: 'grab',
      fulfillment: 'platform_delivery',
      deliveryBuilding: undefined,
      recipientName: undefined,
    });
    expect(order.customerId).toBeNull();
    expect(await customerCount()).toBe(before);
  });

  test('the remembered details appear in no log line and no event', async () => {
    newDay();
    const before = h.events.length;
    await place({
      deliveryBuilding: 'B1',
      recipientName: 'Zzyx-Memory-Name',
      deliveryNote: 'Zzyx-Memory-Note',
    });
    await recipients(await sign('cashier'), '?q=Zzyx-Memory');
    expect(h.logs()).not.toContain('Zzyx-Memory');
    const others = h.events.slice(before).filter((e) => e.type !== 'order.upserted');
    expect(JSON.stringify(others)).not.toContain('Zzyx-Memory');
  });
});

describe('the customers feed', () => {
  test('a remembered recipient reaches /v1/sync as a small customer with none of the new columns', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(
      { deliveryBuilding: 'C1', recipientName: 'Feed Person', deliveryNote: 'Feed-Note-Sentinel' },
      cashier,
    );
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/sync?since=0&limit=500',
      headers: bearer(cashier),
    });
    expect(res.statusCode).toBe(200);
    const customer = res
      .json()
      .changes.find(
        (c: { type: string; id: string }) =>
          c.type === 'customer.upserted' && c.id === order.customerId,
      );
    expect(customer).toBeDefined();
    expect(customer.data).toMatchObject({ orderCount: 1, displayName: null, anonymized: false });
    expect(JSON.stringify(customer)).not.toMatch(
      /Feed Person|Feed-Note-Sentinel|building|recipient/i,
    );
  });
});
