/**
 * A customer edits, cancels and merges their own unpaid LINE orders (D-39) on the real app and an
 * in-memory Postgres. The money rules under test: the server reprices, a payment is replaced and
 * never edited, nothing claimed or confirmed is ever touched, and one transfer stays one payment.
 */
import { type MyOrder, mergedReason } from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { mergeOrders } from './customer-edit.ts';

let h: Harness;
let menu: Menu;
let staffToken: string;
let tokenNo = 0;

const liff: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    return token.startsWith('id-token-') ? { userId: `Uedit${token.slice(9)}` } : null;
  },
};

beforeAll(async () => {
  const runtime = createLineRuntime(
    {
      channelSecret: 'unused-test-secret',
      channelAccessToken: undefined,
      liffId: '1234567890-abcdefgh',
    },
    { liffVerifier: liff, client: null },
  );
  h = await createHarness({ line: runtime });
  menu = await h.newMenu();
  const owner = await h.newOwner();
  h.clock.set('2028-02-01T08:00:00.000Z');
  staffToken = await h.ownerSession(owner);
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
    [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), owner.staffId],
  );
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.clock.set('2028-02-01T08:00:00.000Z');
});

const send = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  body?: unknown,
  key: string | null = crypto.randomUUID(),
) =>
  h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });

/** A new customer who has accepted the privacy notice. */
async function customer(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/app/session',
    payload: { idToken: `id-token-${++tokenNo}-3333333333333333333333` },
    remoteAddress: h.nextIp(),
  });
  const token = res.json().token as string;
  await send('POST', '/v1/app/privacy-ack', token, undefined, null);
  return token;
}

const water = (qty = 1) => [{ menuItemId: menu.water, qty }];
const noodles = (qty = 1) => [{ menuItemId: menu.noodles, qty, modifierOptionIds: [menu.thin] }];

async function place(
  token: string,
  items: unknown[] = water(),
  over: Record<string, unknown> = {},
): Promise<MyOrder> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/app/orders',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      clientRequestId: crypto.randomUUID(),
      items,
      deliveryBuilding: 'B1',
      recipientName: 'ฟ้าทดสอบ',
      paymentMethod: 'promptpay',
      ...over,
    },
    remoteAddress: h.nextIp(),
  });
  if (res.statusCode !== 201) throw new Error(`place failed ${res.statusCode} ${res.body}`);
  return res.json().order as MyOrder;
}

const get = async (token: string, id: string) =>
  (await send('GET', `/v1/app/orders/${id}`, token, undefined, null)).json() as MyOrder;

const version = async (id: string) =>
  Number(
    (await h.client.query<{ version: string }>('select version from orders where id = $1', [id]))
      .rows[0]?.version,
  );

const paymentsOf = async (orderId: string) =>
  (
    await h.client.query<{
      id: string;
      status: string;
      method: string;
      amount_satang: string;
    }>(
      'select id, status, method, amount_satang from payments where order_id = $1 order by rev, id',
      [orderId],
    )
  ).rows.map((p) => ({ ...p, amount: Number(p.amount_satang) }));

const liveLines = async (orderId: string) =>
  (
    await h.client.query<{ qty: number; line_total_satang: number }>(
      'select qty, line_total_satang from order_items where order_id = $1 and removed_at is null',
      [orderId],
    )
  ).rows;

const edit = async (token: string, order: MyOrder, items: unknown[], key?: string) =>
  send(
    'PUT',
    `/v1/app/orders/${order.id}/items`,
    token,
    { expectedVersion: await version(order.id), items },
    key,
  );

const cancel = async (token: string, order: MyOrder, key?: string) =>
  send(
    'POST',
    `/v1/app/orders/${order.id}/cancel`,
    token,
    { expectedVersion: await version(order.id) },
    key,
  );

const merge = async (token: string, target: MyOrder, sources: MyOrder[], key?: string) =>
  send(
    'POST',
    `/v1/app/orders/${target.id}/merge`,
    token,
    {
      expectedVersion: await version(target.id),
      sourceIds: sources.map((s) => s.id),
      expectedVersions: await Promise.all(sources.map((s) => version(s.id))),
    },
    key,
  );

const claim = (token: string, order: MyOrder) =>
  send('POST', `/v1/app/orders/${order.id}/claim`, token, undefined, null);

describe('editing the lines', () => {
  test('reprices on the server, retires the old lines and replaces the pending payment', async () => {
    const token = await customer();
    const order = await place(token, water());
    expect(order.totalSatang).toBe(1000);
    expect(order.actions).toMatchObject({ edit: true, cancel: true });
    const oldPayment = (await paymentsOf(order.id))[0];
    const marker = h.events.length;

    const res = await edit(token, order, noodles(2));
    expect(res.statusCode).toBe(200);
    const view = res.json() as MyOrder;
    expect(view.totalSatang).toBe(10000);
    expect(view.subtotalSatang).toBe(10000);
    expect(view.payment).toMatchObject({ status: 'pending', amountSatang: 10000 });
    expect(view.actions.edit).toBe(true);

    // The old payment is cancelled and kept; a new one asks for the new total.
    const payments = await paymentsOf(order.id);
    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({ id: oldPayment?.id, status: 'cancelled', amount: 1000 });
    expect(payments[1]).toMatchObject({ status: 'pending', method: 'promptpay', amount: 10000 });

    // Old lines are marked removed, never deleted.
    expect(await liveLines(order.id)).toEqual([{ qty: 2, line_total_satang: 10000 }]);
    const all = await h.client.query('select id from order_items where order_id = $1', [order.id]);
    expect(all.rows).toHaveLength(2);

    // The audit row and the events (after the commit).
    const audit = (await h.auditRows(order.id)).filter((a) => a.action === 'order.customer_edit');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'customer' });
    const events = h.events.slice(marker);
    expect(events.some((e) => e.type === 'order.upserted' && e.id === order.id)).toBe(true);
    expect(events.filter((e) => e.type === 'payment.upserted').length).toBeGreaterThanOrEqual(2);
  });

  test('a retry with the same Idempotency-Key writes nothing more', async () => {
    const token = await customer();
    const order = await place(token, water());
    const key = crypto.randomUUID();
    const body = { expectedVersion: await version(order.id), items: noodles(1) };
    const first = await send('PUT', `/v1/app/orders/${order.id}/items`, token, body, key);
    expect(first.statusCode).toBe(200);
    const marker = h.events.length;
    const again = await send('PUT', `/v1/app/orders/${order.id}/items`, token, body, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().totalSatang).toBe(5000);
    expect(await paymentsOf(order.id)).toHaveLength(2);
    expect(h.events.length).toBe(marker);
    // A new key with the old version is the stale-client 409.
    const stale = await send('PUT', `/v1/app/orders/${order.id}/items`, token, body);
    expect(stale.statusCode).toBe(409);
  });

  test('needs an Idempotency-Key, a current version and menu items the shop sells', async () => {
    const token = await customer();
    const order = await place(token, water());
    const noKey = await send(
      'PUT',
      `/v1/app/orders/${order.id}/items`,
      token,
      { expectedVersion: await version(order.id), items: noodles() },
      null,
    );
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const sold = await edit(token, order, [{ menuItemId: menu.soldOut, qty: 1 }]);
    expect(sold.statusCode).toBe(422);
    expect(sold.json().code).toBe('ORDER_INVALID');
    // Nothing changed: still the same payment and lines.
    expect((await paymentsOf(order.id)).map((p) => p.status)).toEqual(['pending']);
    expect(await liveLines(order.id)).toHaveLength(1);
  });

  test("another customer's order is a plain 404", async () => {
    const owner = await customer();
    const other = await customer();
    const order = await place(owner, water());
    const res = await edit(other, order, noodles());
    expect(res.statusCode).toBe(404);
  });

  test('is refused after "โอนแล้ว" (a claimed payment)', async () => {
    const token = await customer();
    const order = await place(token, water());
    expect((await claim(token, order)).statusCode).toBe(200);
    const res = await edit(token, order, noodles());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ORDER_NOT_EDITABLE');
    expect((await get(token, order.id)).actions.edit).toBe(false);
    expect((await paymentsOf(order.id)).map((p) => p.status)).toEqual(['claimed']);
  });

  test('is refused once a slip was ever sent, even if the claim was rejected', async () => {
    const token = await customer();
    const order = await place(token, water());
    await claim(token, order);
    // A slip picture is on the payment, then staff reject the claim: the payment is cancelled.
    await h.client.query(
      "update payments set slip_image_key = 'k', slip_image_hash = 'h', status = 'cancelled' where order_id = $1",
      [order.id],
    );
    const res = await edit(token, order, noodles());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ORDER_NOT_EDITABLE');
    expect((await get(token, order.id)).actions).toMatchObject({ edit: false, cancel: false });
  });

  test('is refused when the order is no longer new', async () => {
    const token = await customer();
    const order = await place(token, water(), { paymentMethod: 'cash' });
    const accept = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/transition`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { to: 'preparing' },
    });
    expect(accept.statusCode).toBe(200);
    const res = await edit(token, order, noodles());
    expect(res.statusCode).toBe(409);
  });

  test('a cash order has no payment to replace and gets none', async () => {
    const token = await customer();
    const order = await place(token, water(), { paymentMethod: 'cash' });
    const res = await edit(token, order, noodles());
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSatang).toBe(5000);
    expect(await paymentsOf(order.id)).toEqual([]);
  });

  test('an edit and a claim racing end consistently: one open payment, for the order total', async () => {
    const token = await customer();
    const order = await place(token, water());
    const body = { expectedVersion: await version(order.id), items: noodles(2) };
    const [e, c] = await Promise.all([
      send('PUT', `/v1/app/orders/${order.id}/items`, token, body),
      claim(token, order),
    ]);
    // Either the claim came first (the edit is refused) or the edit did (the claim lands on the
    // replacement payment). Never a claim on an old amount of a repriced order.
    const row = (
      await h.client.query<{ total_satang: string }>(
        'select total_satang from orders where id = $1',
        [order.id],
      )
    ).rows[0];
    const total = Number(row?.total_satang);
    const open = (await paymentsOf(order.id)).filter(
      (p) => p.status === 'pending' || p.status === 'claimed',
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.amount).toBe(total);
    if (e.statusCode === 200) {
      expect(total).toBe(10000);
      expect(c.statusCode).toBe(200);
    } else {
      expect(e.statusCode).toBe(409);
      expect(total).toBe(1000);
      expect(open[0]?.status).toBe('claimed');
    }
  });
});

describe('cancelling', () => {
  test('cancels a new order with reason customer_cancel and withdraws its pending payment', async () => {
    const token = await customer();
    const order = await place(token, water());
    const res = await cancel(token, order);
    expect(res.statusCode).toBe(200);
    const view = res.json() as MyOrder;
    expect(view).toMatchObject({
      status: 'cancelled',
      cancelReason: 'customer_cancel',
      mergedInto: null,
    });
    expect(view.actions).toMatchObject({ edit: false, cancel: false });
    expect((await paymentsOf(order.id)).map((p) => p.status)).toEqual(['cancelled']);
    const reason = await h.client.query<{ cancel_reason: string }>(
      'select cancel_reason from orders where id = $1',
      [order.id],
    );
    expect(reason.rows[0]?.cancel_reason).toBe('customer_cancel');
    expect(
      (await h.auditRows(order.id)).filter((a) => a.action === 'order.customer_cancel'),
    ).toHaveLength(1);
  });

  test('is refused with 409 ORDER_HAS_PAYMENT when a payment is claimed', async () => {
    const token = await customer();
    const order = await place(token, water());
    await claim(token, order);
    const res = await cancel(token, order);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ORDER_HAS_PAYMENT');
    expect((await get(token, order.id)).status).toBe('new');
  });

  test('is refused when a payment is confirmed', async () => {
    const token = await customer();
    const order = await place(token, water());
    await claim(token, order);
    const payment = (await paymentsOf(order.id))[0];
    await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment?.id}/confirm`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { attestedBankCheck: true },
    });
    const res = await cancel(token, order);
    expect(res.statusCode).toBe(409);
  });

  test('a retry with the same key answers 200 again; another key on a cancelled order is a 409', async () => {
    const token = await customer();
    const order = await place(token, water());
    const key = crypto.randomUUID();
    const body = { expectedVersion: await version(order.id) };
    expect(
      (await send('POST', `/v1/app/orders/${order.id}/cancel`, token, body, key)).statusCode,
    ).toBe(200);
    expect(
      (await send('POST', `/v1/app/orders/${order.id}/cancel`, token, body, key)).statusCode,
    ).toBe(200);
    expect((await send('POST', `/v1/app/orders/${order.id}/cancel`, token, body)).statusCode).toBe(
      409,
    );
  });

  test("a stale version is a 409 and another customer's order is a 404", async () => {
    const token = await customer();
    const other = await customer();
    const order = await place(token, water());
    const stale = await send('POST', `/v1/app/orders/${order.id}/cancel`, token, {
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect((await cancel(other, order)).statusCode).toBe(404);
  });

  test('staff free text is never shown as the cancel reason', async () => {
    const token = await customer();
    const order = await place(token, water(), { paymentMethod: 'cash' });
    await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { reason: 'พี่ไม่ชอบหน้า' },
    });
    const view = await get(token, order.id);
    expect(view).toMatchObject({ status: 'cancelled', cancelReason: 'other', mergedInto: null });
    expect(JSON.stringify(view)).not.toContain('พี่ไม่ชอบหน้า');
  });
});

describe('merging', () => {
  test('the target takes the lines and one payment for the sum; the source is cancelled as merged', async () => {
    const token = await customer();
    const a = await place(token, water()); // L-a 10 baht
    const b = await place(token, noodles()); // L-b 50 baht
    const marker = h.events.length;
    const res = await merge(token, a, [b]);
    expect(res.statusCode).toBe(200);
    const view = res.json() as MyOrder;
    expect(view.id).toBe(a.id);
    expect(view.totalSatang).toBe(6000);
    expect(view.items).toHaveLength(2);
    expect(view.payment).toMatchObject({ status: 'pending', amountSatang: 6000 });

    const target = await paymentsOf(a.id);
    expect(target.map((p) => [p.status, p.amount])).toEqual([
      ['cancelled', 1000],
      ['pending', 6000],
    ]);
    const source = await get(token, b.id);
    expect(source).toMatchObject({
      status: 'cancelled',
      cancelReason: 'merged',
      mergedInto: a.orderNo,
    });
    expect((await paymentsOf(b.id)).map((p) => p.status)).toEqual(['cancelled']);
    const stored = await h.client.query<{ cancel_reason: string }>(
      'select cancel_reason from orders where id = $1',
      [b.id],
    );
    expect(stored.rows[0]?.cancel_reason).toBe(mergedReason(a.orderNo));

    // The sum of the live lines is the order total, and the source's own lines stay on the source.
    const lines = await liveLines(a.id);
    expect(lines.reduce((sum, l) => sum + Number(l.line_total_satang), 0)).toBe(6000);
    expect(await liveLines(b.id)).toHaveLength(1);

    expect((await h.auditRows(a.id)).filter((x) => x.action === 'order.merge')).toHaveLength(1);
    expect((await h.auditRows(b.id)).filter((x) => x.action === 'order.merged_into')).toHaveLength(
      1,
    );
    const events = h.events.slice(marker);
    expect(events.filter((e) => e.type === 'order.upserted').length).toBeGreaterThanOrEqual(2);
  });

  test('a retry with the same key merges once', async () => {
    const token = await customer();
    const a = await place(token, water());
    const b = await place(token, water());
    const key = crypto.randomUUID();
    const body = {
      expectedVersion: await version(a.id),
      sourceIds: [b.id],
      expectedVersions: [await version(b.id)],
    };
    expect((await send('POST', `/v1/app/orders/${a.id}/merge`, token, body, key)).statusCode).toBe(
      200,
    );
    const again = await send('POST', `/v1/app/orders/${a.id}/merge`, token, body, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().totalSatang).toBe(2000);
    expect(await paymentsOf(a.id)).toHaveLength(2);
    expect(await liveLines(a.id)).toHaveLength(2);
  });

  test('is refused when the building or the name differs', async () => {
    const token = await customer();
    const a = await place(token, water());
    const otherBuilding = await place(token, water(), { deliveryBuilding: 'B2' });
    const otherName = await place(token, water(), { recipientName: 'คนอื่น' });
    for (const source of [otherBuilding, otherName]) {
      const res = await merge(token, a, [source]);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MERGE_NOT_ALLOWED');
    }
    // Nothing moved.
    expect(await liveLines(a.id)).toHaveLength(1);
    expect((await get(token, otherName.id)).status).toBe('new');
  });

  test('the same name in another case and with spaces still merges', async () => {
    const token = await customer();
    const a = await place(token, water(), { recipientName: 'Fah Test' });
    const b = await place(token, water(), { recipientName: '  fah test ' });
    expect((await merge(token, a, [b])).statusCode).toBe(200);
  });

  test('is refused when either order has a claimed or confirmed payment, and never touches it', async () => {
    const token = await customer();
    const a = await place(token, water());
    const b = await place(token, water());
    await claim(token, b);
    const payment = (await paymentsOf(b.id))[0];
    for (const [target, source] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await merge(token, target, [source]);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MERGE_NOT_ALLOWED');
    }
    await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment?.id}/confirm`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { attestedBankCheck: true },
    });
    expect((await merge(token, a, [b])).statusCode).toBe(409);
    expect((await paymentsOf(b.id)).map((p) => p.status)).toEqual(['confirmed']);
    expect((await get(token, a.id)).status).toBe('new');
  });

  test("another customer's orders are a plain 404, and an order cannot merge into itself", async () => {
    const token = await customer();
    const other = await customer();
    const a = await place(token, water());
    const b = await place(other, water());
    expect((await merge(token, a, [b])).statusCode).toBe(404);
    const self = await send('POST', `/v1/app/orders/${a.id}/merge`, token, {
      expectedVersion: await version(a.id),
      sourceIds: [a.id],
      expectedVersions: [await version(a.id)],
    });
    expect(self.statusCode).toBe(422);
  });

  test('a stale version of any order is a 409 and nothing changes', async () => {
    const token = await customer();
    const a = await place(token, water());
    const b = await place(token, water());
    const res = await send('POST', `/v1/app/orders/${a.id}/merge`, token, {
      expectedVersion: await version(a.id),
      sourceIds: [b.id],
      expectedVersions: [1],
    });
    expect(res.statusCode).toBe(409);
    expect((await get(token, b.id)).status).toBe('new');
  });

  test('the server can merge for a slip from the chat (actor system), with no versions', async () => {
    const token = await customer();
    const a = await place(token, water());
    const b = await place(token, noodles());
    const target = await h.client.query<{ customer_id: string }>(
      'select customer_id from orders where id = $1',
      [a.id],
    );
    expect(target.rows[0]?.customer_id).toBeTruthy();
    const row = await mergeOrders(
      { db: h.db, now: h.clock.now, events: h.bus },
      { kind: 'system' },
      a.id,
      [b.id],
      undefined,
      { paymentRequestId: crypto.randomUUID() },
      { ip: null },
    );
    expect(row.totalSatang).toBe(6000);
    const audit = (await h.auditRows(a.id)).filter((x) => x.action === 'order.merge');
    expect(audit[0]).toMatchObject({ actorType: 'system', actorId: null });
    expect((await paymentsOf(a.id)).map((p) => [p.status, p.amount])).toEqual([
      ['cancelled', 1000],
      ['pending', 6000],
    ]);
  });
});

describe('GET /v1/app/orders/open', () => {
  test("lists the caller's own unpaid orders with their option ids, oldest first, and not claimed ones", async () => {
    const token = await customer();
    const other = await customer();
    const a = await place(token, noodles());
    const b = await place(token, water());
    const claimed = await place(token, water());
    await claim(token, claimed);
    await place(other, water());
    const done = await place(token, water());
    await cancel(token, done);

    const res = await send('GET', '/v1/app/orders/open', token, undefined, null);
    expect(res.statusCode).toBe(200);
    const { orders } = res.json() as {
      orders: { id: string; items: { modifierOptionIds: string[] }[]; version: number }[];
    };
    expect(orders.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(orders[0]?.items[0]?.modifierOptionIds).toEqual([menu.thin]);
    expect(orders[0]?.version).toBe(await version(a.id));
  });
});
