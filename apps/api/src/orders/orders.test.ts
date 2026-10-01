import { type OrderDto, orderDtoSchema } from '@sds/shared';
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

/** Each test works on its own business day (10:00 in Bangkok), so order numbers start at 001. */
let dayNo = 0;
function newDay(): string {
  dayNo += 1;
  const at = new Date(Date.UTC(2028, 0, dayNo, 3, 0, 0));
  h.clock.set(at.toISOString());
  return at.toISOString().slice(0, 10);
}

const sign = (role: 'cashier' | 'manager' | 'kitchen') =>
  h.pinSession(device.token, staff[role].id, staff[role].pin);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const orderBody = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  channel: 'storefront',
  fulfillment: 'takeaway',
  items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  ...over,
});

function post(token: string | undefined, body: unknown, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...(token ? bearer(token) : {}), ...headers },
    payload: body as Record<string, unknown>,
  });
}

async function place(token: string, over: Record<string, unknown> = {}): Promise<OrderDto> {
  const res = await post(token, orderBody(over));
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  return orderDtoSchema.parse(res.json());
}

const get = (token: string, url: string) =>
  h.app.inject({ method: 'GET', url, headers: bearer(token) });

function patch(token: string, id: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'PATCH',
    url: `/v1/orders/${id}`,
    headers: bearer(token),
    payload: body,
  });
}

function transition(token: string, id: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/orders/${id}/transition`,
    headers: bearer(token),
    payload: body,
  });
}

function cancel(token: string, id: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/orders/${id}/cancel`,
    headers: bearer(token),
    payload: body,
  });
}

async function row(sql: string, params: unknown[]) {
  return (await h.client.query<Record<string, unknown>>(sql, params)).rows[0];
}

const orderCount = async (clientRequestId: string) =>
  Number(
    (
      await row('select count(*)::int as n from orders where client_request_id = $1', [
        clientRequestId,
      ])
    )?.n,
  );

describe('POST /v1/orders', () => {
  test('needs a session and the order.create permission', async () => {
    newDay();
    expect((await post(undefined, orderBody())).statusCode).toBe(401);
    const res = await post(await sign('kitchen'), orderBody());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await post(await sign('cashier'), orderBody())).statusCode).toBe(201);
  });

  test('creates a storefront order, priced by the server', async () => {
    const day = newDay();
    const cashier = await sign('cashier');
    const res = await post(
      cashier,
      orderBody({
        note: 'ห่อกลับ',
        items: [
          {
            menuItemId: menu.noodles,
            qty: 2,
            modifierOptionIds: [menu.wide, menu.egg, menu.large],
            note: 'ไม่ใส่ผัก',
          },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const order = orderDtoSchema.parse(res.json());
    // (฿50 + ฿5 egg + ฿10 large) × 2
    expect(order).toMatchObject({
      orderNo: 'S-001',
      businessDate: day,
      channel: 'storefront',
      fulfillment: 'takeaway',
      status: 'preparing',
      paymentStatus: 'unpaid',
      subtotalSatang: 13000,
      discountSatang: 0,
      totalSatang: 13000,
      note: 'ห่อกลับ',
      version: 1,
      createdByStaffId: staff.cashier.id,
      createdOnDeviceId: device.id,
      placedAt: h.clock.now().toISOString(),
      acceptedAt: h.clock.now().toISOString(),
      readyAt: null,
      completedAt: null,
      cancelledAt: null,
    });
    expect(order.rev).toBeGreaterThan(0);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      menuItemId: menu.noodles,
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      unitPriceSatang: 5000,
      qty: 2,
      lineTotalSatang: 13000,
      note: 'ไม่ใส่ผัก',
    });
    expect(order.items[0]?.modifiers.map((m) => [m.nameTh, m.priceDeltaSatang])).toEqual([
      ['เส้นใหญ่', 0],
      ['ไข่', 500],
      ['พิเศษ', 1000],
    ]);
  });

  test('saves the cost snapshot in the database but never sends it to a device', async () => {
    newDay();
    const res = await post(
      await sign('cashier'),
      orderBody({
        items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin, menu.egg] }],
      }),
    );
    expect(res.body).not.toMatch(/cost/i);
    const saved = await row(
      'select unit_price_satang, unit_cost_satang, line_total_satang, modifiers from order_items where order_id = $1',
      [res.json().id],
    );
    // estimated cost ฿22 + egg cost ฿3
    expect(saved).toMatchObject({
      unit_price_satang: 5000,
      unit_cost_satang: 2500,
      line_total_satang: 5500,
    });
    expect(JSON.stringify(saved?.modifiers)).toContain('"costDeltaSatang":300');
  });

  test('ignores any price, total or discount the client sends', async () => {
    newDay();
    const body = orderBody({
      totalSatang: 1,
      subtotalSatang: 1,
      discountSatang: 4000,
      items: [
        {
          menuItemId: menu.noodles,
          qty: 1,
          modifierOptionIds: [menu.thin],
          unitPriceSatang: 1,
          lineTotalSatang: 1,
        },
      ],
    });
    const order = orderDtoSchema.parse((await post(await sign('cashier'), body)).json());
    expect(order).toMatchObject({ subtotalSatang: 5000, discountSatang: 0, totalSatang: 5000 });
    expect(order.items[0]).toMatchObject({ unitPriceSatang: 5000, lineTotalSatang: 5000 });
  });

  test('LINE and platform orders wait for staff (new); Grab uses the Grab price', async () => {
    newDay();
    const cashier = await sign('cashier');
    const line = await place(cashier, { channel: 'line', fulfillment: 'pickup' });
    expect(line).toMatchObject({
      status: 'new',
      acceptedAt: null,
      orderNo: 'L-001',
      totalSatang: 5000,
    });
    const grab = await place(cashier, { channel: 'grab', fulfillment: 'platform_delivery' });
    expect(grab).toMatchObject({ status: 'new', orderNo: 'G-002', totalSatang: 6500 });
    expect(grab.items[0]?.unitPriceSatang).toBe(6500);
    const lineman = await place(cashier, { channel: 'lineman', fulfillment: 'platform_delivery' });
    expect(lineman).toMatchObject({ orderNo: 'M-003', totalSatang: 5000 });
  });

  test('a phone order is keyed in at the counter: storefront prices, goes straight to preparing', async () => {
    newDay();
    const phone = await place(await sign('cashier'), { channel: 'phone', fulfillment: 'pickup' });
    expect(phone).toMatchObject({ orderNo: 'P-001', status: 'preparing', totalSatang: 5000 });
  });

  test('a room delivery keeps its room number', async () => {
    newDay();
    const order = await place(await sign('cashier'), {
      fulfillment: 'room_delivery',
      roomNo: ' 1204 ',
    });
    expect(order).toMatchObject({ fulfillment: 'room_delivery', roomNo: '1204' });
  });

  test('later menu edits do not change a saved order', async () => {
    newDay();
    const own = await h.newMenu();
    const order = await place(await sign('cashier'), {
      items: [{ menuItemId: own.noodles, qty: 1, modifierOptionIds: [own.thin] }],
    });
    await h.client.query(
      "update menu_items set price_satang = 9999, name_th = 'เปลี่ยนชื่อ' where id = $1",
      [own.noodles],
    );
    await h.client.query("update modifier_options set name_th = 'เปลี่ยน' where id = $1", [own.thin]);
    const again = orderDtoSchema.parse(
      (await get(await sign('cashier'), `/v1/orders/${order.id}`)).json(),
    );
    expect(again.totalSatang).toBe(5000);
    expect(again.items[0]).toMatchObject({ nameTh: 'ก๋วยเตี๋ยวต้มยำ', unitPriceSatang: 5000 });
    expect(again.items[0]?.modifiers[0]?.nameTh).toBe('เส้นเล็ก');
  });

  test('refuses what the menu does not allow, with the reason for each line', async () => {
    newDay();
    const cashier = await sign('cashier');
    const ghost = crypto.randomUUID();
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'a sold-out item',
        { items: [{ menuItemId: menu.soldOut, qty: 1, modifierOptionIds: [] }] },
        'ITEM_UNAVAILABLE',
      ],
      [
        'an item not on Grab',
        {
          channel: 'grab',
          fulfillment: 'platform_delivery',
          items: [{ menuItemId: menu.water, qty: 1, modifierOptionIds: [] }],
        },
        'ITEM_NOT_ON_CHANNEL',
      ],
      [
        'a missing required choice',
        { items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [] }] },
        'GROUP_TOO_FEW',
      ],
      [
        'two noodle types',
        {
          items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin, menu.wide] }],
        },
        'GROUP_TOO_MANY',
      ],
      [
        'an unknown option',
        { items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin, ghost] }] },
        'UNKNOWN_OPTION',
      ],
      [
        'an unknown item',
        { items: [{ menuItemId: ghost, qty: 1, modifierOptionIds: [] }] },
        'UNKNOWN_ITEM',
      ],
    ];
    for (const [label, over, code] of cases) {
      const res = await post(cashier, orderBody(over));
      expect(res.statusCode, label).toBe(422);
      expect(res.json(), label).toMatchObject({
        code: 'ORDER_INVALID',
        details: { errors: [expect.objectContaining({ code, lineIndex: 0 })] },
      });
    }
  });

  test('reports every bad line, and an unavailable option or archived item', async () => {
    newDay();
    const own = await h.newMenu();
    await h.client.query('update modifier_options set is_available = false where id = $1', [
      own.egg,
    ]);
    await h.client.query('update menu_items set archived_at = now() where id = $1', [own.water]);
    const res = await post(
      await sign('cashier'),
      orderBody({
        items: [
          { menuItemId: own.noodles, qty: 1, modifierOptionIds: [own.thin, own.egg] },
          { menuItemId: own.water, qty: 1, modifierOptionIds: [] },
        ],
      }),
    );
    expect(res.statusCode).toBe(422);
    const errs = (res.json() as { details: { errors: { code: string; lineIndex: number }[] } })
      .details.errors;
    expect(errs.map((e) => `${e.code}:${e.lineIndex}`)).toEqual([
      'OPTION_UNAVAILABLE:0',
      'ITEM_UNAVAILABLE:1',
    ]);
  });

  test('a refused order creates nothing and uses no order number', async () => {
    newDay();
    const cashier = await sign('cashier');
    const bad = orderBody({ items: [{ menuItemId: menu.soldOut, qty: 1, modifierOptionIds: [] }] });
    expect((await post(cashier, bad)).statusCode).toBe(422);
    expect(await orderCount(bad.clientRequestId)).toBe(0);
    expect((await place(cashier)).orderNo).toBe('S-001');
  });

  test.each([
    ['no items', { items: [] }],
    ['quantity 0', { items: [{ menuItemId: crypto.randomUUID(), qty: 0, modifierOptionIds: [] }] }],
    [
      'quantity 100',
      { items: [{ menuItemId: crypto.randomUUID(), qty: 100, modifierOptionIds: [] }] },
    ],
    ['room delivery without a room', { fulfillment: 'room_delivery' }],
    ['an unknown channel', { channel: 'fax' }],
    ['a missing request id', { clientRequestId: undefined }],
  ])('rejects %s with a validation error', async (_label, over) => {
    newDay();
    const res = await post(await sign('cashier'), orderBody(over));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('refuses a customer that does not exist', async () => {
    newDay();
    const res = await post(await sign('cashier'), orderBody({ customerId: crypto.randomUUID() }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_CUSTOMER' });
  });
});

describe('POST /v1/orders is idempotent', () => {
  test('sending the same order twice returns the same order and uses one number', async () => {
    newDay();
    const cashier = await sign('cashier');
    const body = orderBody();
    const first = await post(cashier, body);
    const second = await post(cashier, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await orderCount(body.clientRequestId)).toBe(1);
    // The replay did not burn a number.
    expect((await place(cashier)).orderNo).toBe('S-002');
  });

  test('the Idempotency-Key header must agree with the request id in the body', async () => {
    newDay();
    const cashier = await sign('cashier');
    const body = orderBody();
    const ok = await post(cashier, body, { 'idempotency-key': body.clientRequestId });
    expect(ok.statusCode).toBe(201);
    const mismatch = await post(cashier, orderBody(), { 'idempotency-key': crypto.randomUUID() });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
  });

  test('a retry returns the original even if the menu has changed since', async () => {
    newDay();
    const own = await h.newMenu();
    const cashier = await sign('cashier');
    const body = orderBody({
      items: [{ menuItemId: own.noodles, qty: 1, modifierOptionIds: [own.thin] }],
    });
    const first = await post(cashier, body);
    await h.client.query('update menu_items set is_available = false where id = $1', [own.noodles]);
    const retry = await post(cashier, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });

  test('two identical requests at the same moment make one order', async () => {
    newDay();
    const cashier = await sign('cashier');
    const body = orderBody();
    const [a, b] = await Promise.all([post(cashier, body), post(cashier, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect(await orderCount(body.clientRequestId)).toBe(1);
    expect((await place(cashier)).orderNo).toBe('S-002');
  });

  test('a replay publishes no events', async () => {
    newDay();
    const cashier = await sign('cashier');
    const body = orderBody();
    await post(cashier, body);
    const before = h.events.length;
    await post(cashier, body);
    expect(h.events.length).toBe(before);
  });
});

describe('order numbers', () => {
  test('one daily sequence across channels, with the channel letter', async () => {
    newDay();
    const cashier = await sign('cashier');
    const numbers = [
      (await place(cashier)).orderNo,
      (await place(cashier, { channel: 'line', fulfillment: 'pickup' })).orderNo,
      (await place(cashier)).orderNo,
      (await place(cashier, { channel: 'phone', fulfillment: 'pickup' })).orderNo,
    ];
    expect(numbers).toEqual(['S-001', 'L-002', 'S-003', 'P-004']);
  });

  test('orders placed at the same moment get different numbers', async () => {
    // PGlite runs transactions one at a time, so this cannot prove isolation by itself: the
    // guarantee is the single-statement counter upsert plus the unique (business_date, order_no).
    newDay();
    const cashier = await sign('cashier');
    const placed = await Promise.all(Array.from({ length: 8 }, () => place(cashier)));
    const numbers = placed.map((o) => o.orderNo).sort();
    expect(new Set(numbers).size).toBe(8);
    expect(numbers).toEqual([
      'S-001',
      'S-002',
      'S-003',
      'S-004',
      'S-005',
      'S-006',
      'S-007',
      'S-008',
    ]);
  });

  test('the sequence restarts at the 04:00 Bangkok cutoff', async () => {
    // 04:00 in Bangkok (UTC+7) is 21:00 UTC the day before.
    h.clock.set('2027-03-01T20:59:58.000Z'); // 03:59:58 on 2 March in Bangkok: still 1 March
    const cashier = await sign('cashier');
    const a = await place(cashier);
    h.clock.set('2027-03-01T20:59:59.000Z');
    const b = await place(cashier);
    h.clock.set('2027-03-01T21:00:00.000Z'); // 04:00:00 on 2 March: a new business day
    const c = await place(cashier);
    h.clock.set('2027-03-01T21:00:01.000Z');
    const d = await place(cashier);
    expect([a, b, c, d].map((o) => [o.businessDate, o.orderNo])).toEqual([
      ['2027-03-01', 'S-001'],
      ['2027-03-01', 'S-002'],
      ['2027-03-02', 'S-001'],
      ['2027-03-02', 'S-002'],
    ]);
  });

  test('uses the cutoff from settings when there is one', async () => {
    await h.client.query(
      `insert into settings (key, value) values ('business_day', '{"cutoffMinutes": 360, "timeZone": "Asia/Bangkok"}')`,
    );
    try {
      h.clock.set('2027-04-01T22:59:59.000Z'); // 05:59:59 on 2 April in Bangkok: before the 06:00 cutoff
      const cashier = await sign('cashier');
      const before = await place(cashier);
      h.clock.set('2027-04-01T23:00:00.000Z'); // 06:00:00
      const after = await place(cashier);
      expect([before.businessDate, after.businessDate]).toEqual(['2027-04-01', '2027-04-02']);
      expect(after.orderNo).toBe('S-001');
    } finally {
      await h.client.query(`delete from settings where key = 'business_day'`);
    }
  });
});

describe('events after commit', () => {
  test('a new order publishes order.upserted and a new-order alert, carrying the committed rev', async () => {
    newDay();
    const cashier = await sign('cashier');
    const seen: { id: string; sameRevInDb: boolean }[] = [];
    const off = h.bus.subscribe(async (event) => {
      if (event.type !== 'order.upserted') return;
      const saved = await row('select rev from orders where id = $1', [event.id]);
      seen.push({ id: event.id, sameRevInDb: Number(saved?.rev) === event.rev });
    });
    const before = h.events.length;
    const res = await post(cashier, orderBody({ channel: 'line', fulfillment: 'pickup' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();

    const order = orderDtoSchema.parse(res.json());
    const published = h.events.slice(before);
    expect(published.map((e) => e.type)).toEqual(['order.upserted', 'alert.new_order']);
    const [upserted, alert] = published;
    expect(upserted).toMatchObject({ type: 'order.upserted', id: order.id, rev: order.rev });
    expect(JSON.parse(JSON.stringify((upserted as { data: unknown }).data))).toEqual(
      JSON.parse(res.body),
    );
    expect(alert).toMatchObject({
      type: 'alert.new_order',
      orderId: order.id,
      orderNo: order.orderNo,
      channel: 'line',
      status: 'new',
      createdOnDeviceId: device.id,
    });
    // The row was already visible, with that rev, when the subscriber ran.
    expect(seen).toEqual([{ id: order.id, sameRevInDb: true }]);
  });

  test('a refused order publishes nothing', async () => {
    newDay();
    const cashier = await sign('cashier');
    const before = h.events.length;
    await post(
      cashier,
      orderBody({ items: [{ menuItemId: menu.soldOut, qty: 1, modifierOptionIds: [] }] }),
    );
    await post(cashier, orderBody({ items: [] }));
    expect(h.events.length).toBe(before);
  });
});

describe('GET /v1/orders', () => {
  test('needs a session; every role can read', async () => {
    newDay();
    expect((await h.app.inject({ method: 'GET', url: '/v1/orders' })).statusCode).toBe(401);
    for (const role of ['cashier', 'manager', 'kitchen'] as const) {
      expect((await get(await sign(role), '/v1/orders')).statusCode, role).toBe(200);
    }
  });

  test("lists today's orders oldest first, with items, and none from other days", async () => {
    const today = newDay();
    const cashier = await sign('cashier');
    const first = await place(cashier);
    h.clock.advanceSeconds(60);
    const second = await place(cashier, { channel: 'line', fulfillment: 'pickup' });
    const res = await get(cashier, '/v1/orders');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { day: string; orders: OrderDto[] };
    expect(body.day).toBe(today);
    expect(body.orders.map((o) => o.id)).toEqual([first.id, second.id]);
    expect(body.orders[0]?.items).toHaveLength(1);
    expect(res.body).not.toMatch(/cost/i);

    const other = await get(cashier, '/v1/orders?day=2020-01-01');
    expect(other.json()).toEqual({ day: '2020-01-01', orders: [] });
  });

  test('filters by status, channel and day', async () => {
    const today = newDay();
    const cashier = await sign('cashier');
    const storefront = await place(cashier);
    const line = await place(cashier, { channel: 'line', fulfillment: 'pickup' });
    const ids = async (query: string) =>
      ((await get(cashier, `/v1/orders${query}`)).json() as { orders: OrderDto[] }).orders.map(
        (o) => o.id,
      );
    expect(await ids('?status=new')).toEqual([line.id]);
    expect(await ids('?status=preparing')).toEqual([storefront.id]);
    expect(await ids('?channel=line')).toEqual([line.id]);
    expect(await ids(`?day=${today}&channel=storefront&status=preparing`)).toEqual([storefront.id]);
    expect(await ids('?status=completed')).toEqual([]);
  });

  test('uses the business day, not the calendar day, for "today"', async () => {
    h.clock.set('2027-05-01T20:30:00.000Z'); // 03:30 on 2 May in Bangkok: still the 1 May business day
    const cashier = await sign('cashier');
    await place(cashier);
    const body = (await get(cashier, '/v1/orders')).json() as { day: string; orders: unknown[] };
    expect(body.day).toBe('2027-05-01');
    expect(body.orders).toHaveLength(1);
  });

  test.each(['?day=01/10/2026', '?status=paid', '?channel=fax'])(
    'rejects the query %s',
    async (query) => {
      newDay();
      const res = await get(await sign('cashier'), `/v1/orders${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );
});

describe('GET /v1/orders/{id}', () => {
  test('returns one order; unknown is 404; a malformed id is 400', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const res = await get(cashier, `/v1/orders/${order.id}`);
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toEqual(order);
    expect((await get(cashier, `/v1/orders/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await get(cashier, '/v1/orders/not-a-uuid')).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: `/v1/orders/${order.id}` })).statusCode).toBe(
      401,
    );
  });
});

describe('PATCH /v1/orders/{id}', () => {
  test('changes the note and room, bumps version and rev, and publishes', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier, { fulfillment: 'room_delivery', roomNo: '1204' });
    const before = h.events.length;
    const res = await patch(cashier, order.id, {
      expectedVersion: 1,
      note: 'ไม่เผ็ด',
      roomNo: '1310',
    });
    expect(res.statusCode).toBe(200);
    const updated = orderDtoSchema.parse(res.json());
    expect(updated).toMatchObject({
      note: 'ไม่เผ็ด',
      roomNo: '1310',
      version: 2,
      totalSatang: order.totalSatang,
    });
    expect(updated.rev).toBeGreaterThan(order.rev);
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({ type: 'order.upserted', id: order.id, rev: updated.rev }),
    ]);
  });

  test('can clear the note', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier, { note: 'x' });
    const res = await patch(cashier, order.id, { expectedVersion: 1, note: null });
    expect(res.json()).toMatchObject({ note: null });
  });

  test('needs the version the client saw: missing is 400, stale is 409 with the current version', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    expect((await patch(cashier, order.id, { note: 'a' })).statusCode).toBe(400);
    expect((await patch(cashier, order.id, { expectedVersion: 1, note: 'a' })).statusCode).toBe(
      200,
    );
    const stale = await patch(cashier, order.id, { expectedVersion: 1, note: 'b' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    expect(orderDtoSchema.parse((await get(cashier, `/v1/orders/${order.id}`)).json()).note).toBe(
      'a',
    );
  });

  test('two devices editing at once: one wins, one is told to reload', async () => {
    newDay();
    const cashier = await sign('cashier');
    const manager = await sign('manager');
    const order = await place(cashier);
    const [a, b] = await Promise.all([
      patch(cashier, order.id, { expectedVersion: 1, note: 'จากเครื่อง A' }),
      patch(manager, order.id, { expectedVersion: 1, note: 'จากเครื่อง B' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  test('refuses money, status and item fields instead of ignoring them', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    for (const field of ['totalSatang', 'subtotalSatang', 'discountSatang', 'status', 'items']) {
      const res = await patch(cashier, order.id, { expectedVersion: 1, note: 'x', [field]: 1 });
      expect(res.statusCode, field).toBe(400);
    }
    expect(
      orderDtoSchema.parse((await get(cashier, `/v1/orders/${order.id}`)).json()).version,
    ).toBe(1);
  });

  test('a room delivery cannot lose its room number', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier, { fulfillment: 'room_delivery', roomNo: '1204' });
    const res = await patch(cashier, order.id, { expectedVersion: 1, roomNo: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'ROOM_REQUIRED' });
  });

  test('unknown order is 404; a finished order is closed; kitchen may not edit', async () => {
    newDay();
    const cashier = await sign('cashier');
    expect(
      (await patch(cashier, crypto.randomUUID(), { expectedVersion: 1, note: 'x' })).statusCode,
    ).toBe(404);

    const order = await place(cashier);
    expect(
      (await patch(await sign('kitchen'), order.id, { expectedVersion: 1, note: 'x' })).statusCode,
    ).toBe(403);

    await transition(cashier, order.id, { to: 'ready' });
    await transition(cashier, order.id, { to: 'completed' });
    const closed = await patch(cashier, order.id, { expectedVersion: 3, note: 'x' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: 'ORDER_CLOSED' });
  });
});

describe('POST /v1/orders/{id}/transition', () => {
  test('a storefront order goes preparing, ready, completed; each step is stamped and versioned', async () => {
    newDay();
    const cashier = await sign('cashier');
    const kitchen = await sign('kitchen');
    const order = await place(cashier);
    expect(order.status).toBe('preparing');

    h.clock.advanceSeconds(300);
    const ready = orderDtoSchema.parse(
      (await transition(kitchen, order.id, { to: 'ready' })).json(),
    );
    expect(ready).toMatchObject({
      status: 'ready',
      version: 2,
      readyAt: h.clock.now().toISOString(),
    });
    expect(ready.rev).toBeGreaterThan(order.rev);

    h.clock.advanceSeconds(120);
    const done = orderDtoSchema.parse(
      (await transition(cashier, order.id, { to: 'completed' })).json(),
    );
    expect(done).toMatchObject({
      status: 'completed',
      version: 3,
      completedAt: h.clock.now().toISOString(),
    });
    expect(done.rev).toBeGreaterThan(ready.rev);
  });

  test('each change is published once, with the new rev', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    const before = h.events.length;
    const ready = orderDtoSchema.parse(
      (await transition(cashier, order.id, { to: 'ready' })).json(),
    );
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({ type: 'order.upserted', id: order.id, rev: ready.rev }),
    ]);
  });

  test('a LINE order is accepted by staff (new to preparing)', async () => {
    newDay();
    const order = await place(await sign('cashier'), { channel: 'line', fulfillment: 'pickup' });
    expect(order.acceptedAt).toBeNull();
    h.clock.advanceSeconds(30);
    const res = await transition(await sign('kitchen'), order.id, { to: 'preparing' });
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      status: 'preparing',
      acceptedAt: h.clock.now().toISOString(),
    });
  });

  test.each([
    ['preparing', 'completed', []],
    ['preparing', 'new', []],
    ['ready', 'preparing', ['ready']],
    ['completed', 'ready', ['ready', 'completed']],
    ['cancelled', 'preparing', ['cancel']],
  ])('%s to %s is refused and changes nothing', async (from, to, setup) => {
    newDay();
    const cashier = await sign('cashier');
    const manager = await sign('manager');
    const order = await place(cashier);
    for (const step of setup) {
      if (step === 'cancel') await cancel(manager, order.id, { reason: 'ทดสอบ' });
      else await transition(cashier, order.id, { to: step });
    }
    const current = orderDtoSchema.parse((await get(cashier, `/v1/orders/${order.id}`)).json());
    expect(current.status).toBe(from);
    const before = h.events.length;

    const res = await transition(manager, order.id, { to, reason: 'ทดสอบ' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_TRANSITION', details: { from, to } });
    expect(orderDtoSchema.parse((await get(cashier, `/v1/orders/${order.id}`)).json())).toEqual(
      current,
    );
    expect(h.events.length).toBe(before);
  });

  test('a status that does not exist is a validation error', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    expect((await transition(cashier, order.id, { to: 'paid' })).statusCode).toBe(400);
  });

  test('two devices pressing the same button: one succeeds, the other is refused', async () => {
    newDay();
    const cashier = await sign('cashier');
    const kitchen = await sign('kitchen');
    const order = await place(cashier);
    const [a, b] = await Promise.all([
      transition(cashier, order.id, { to: 'ready' }),
      transition(kitchen, order.id, { to: 'ready' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(
      orderDtoSchema.parse((await get(cashier, `/v1/orders/${order.id}`)).json()).version,
    ).toBe(2);
  });

  test('a stale expectedVersion is a conflict; the right one goes through', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    await patch(cashier, order.id, { expectedVersion: 1, note: 'x' });
    const stale = await transition(cashier, order.id, { to: 'ready', expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    expect(
      (await transition(cashier, order.id, { to: 'ready', expectedVersion: 2 })).statusCode,
    ).toBe(200);
  });

  test('unknown order is 404; no session is 401', async () => {
    newDay();
    const cashier = await sign('cashier');
    expect((await transition(cashier, crypto.randomUUID(), { to: 'ready' })).statusCode).toBe(404);
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${crypto.randomUUID()}/transition`,
      payload: { to: 'ready' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('cancelling', () => {
  test('a cashier may cancel a new order with a reason', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier, { channel: 'line', fulfillment: 'pickup' });
    h.clock.advanceSeconds(45);
    const res = await cancel(cashier, order.id, { reason: 'ลูกค้ายกเลิก' });
    expect(res.statusCode).toBe(200);
    expect(orderDtoSchema.parse(res.json())).toMatchObject({
      status: 'cancelled',
      cancelReason: 'ลูกค้ายกเลิก',
      cancelledAt: h.clock.now().toISOString(),
      version: 2,
    });
  });

  test('once cooking has started only a manager may cancel', async () => {
    newDay();
    const cashier = await sign('cashier');
    const order = await place(cashier);
    for (const role of ['cashier', 'kitchen'] as const) {
      const denied = await cancel(await sign(role), order.id, { reason: 'ทดสอบ' });
      expect(denied.statusCode, role).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
    const res = await cancel(await sign('manager'), order.id, { reason: 'วัตถุดิบหมด' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', cancelReason: 'วัตถุดิบหมด' });
  });

  test('a reason is required, on /cancel and on /transition', async () => {
    newDay();
    const manager = await sign('manager');
    const order = await place(manager);
    expect((await cancel(manager, order.id, {})).statusCode).toBe(400);
    expect((await cancel(manager, order.id, { reason: '   ' })).statusCode).toBe(400);
    const res = await transition(manager, order.id, { to: 'cancelled' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(
      (await transition(manager, order.id, { to: 'cancelled', reason: 'ทดสอบ' })).statusCode,
    ).toBe(200);
  });

  test('a finished or already cancelled order cannot be cancelled', async () => {
    newDay();
    const manager = await sign('manager');
    const done = await place(manager);
    await transition(manager, done.id, { to: 'ready' });
    await transition(manager, done.id, { to: 'completed' });
    expect((await cancel(manager, done.id, { reason: 'ทดสอบ' })).statusCode).toBe(409);

    const gone = await place(manager);
    await cancel(manager, gone.id, { reason: 'ทดสอบ' });
    const again = await cancel(manager, gone.id, { reason: 'ทดสอบ' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('versions and revs', () => {
  test('every change adds exactly 1 to the version and takes a newer rev', async () => {
    newDay();
    const cashier = await sign('cashier');
    const a = await place(cashier);
    const b = await place(cashier);
    const a2 = orderDtoSchema.parse(
      (await patch(cashier, a.id, { expectedVersion: 1, note: 'x' })).json(),
    );
    const b2 = orderDtoSchema.parse((await transition(cashier, b.id, { to: 'ready' })).json());
    const a3 = orderDtoSchema.parse((await transition(cashier, a.id, { to: 'ready' })).json());
    expect([a.version, a2.version, a3.version, b.version, b2.version]).toEqual([1, 2, 3, 1, 2]);
    const revs = [a.rev, b.rev, a2.rev, b2.rev, a3.rev];
    expect([...revs].sort((x, y) => x - y)).toEqual(revs);
    expect(new Set(revs).size).toBe(revs.length);
  });
});
