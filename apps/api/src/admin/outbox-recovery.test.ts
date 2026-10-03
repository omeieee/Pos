/**
 * Owner recovery of another person's offline outbox entries (CLAUDE.md rule 9): the audited,
 * step-up-protected route that records a take-over or clear, and `originalStaffId` on order and
 * cash payment create, which keeps the cashier in the trail when the owner replays their entries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let device: { id: string; token: string };
let cashier: { id: string; pin: string };
beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  owner = await h.newOwner({ pin: '246810' });
  device = await h.newDevice();
  cashier = await h.newStaff('cashier', '4821');
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 0;
beforeEach(() => {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2028, 1, dayNo, 3, 0, 0)).toISOString());
});

async function steppedOwner() {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
}

function call(method: 'GET' | 'POST', url: string, token: string | undefined, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await h.client.query<Record<string, unknown>>(sql, params)).rows;

const recovery = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  action: 'take_over',
  orders: 2,
  payments: 1,
  ...over,
});
const url = () => `/v1/devices/${device.id}/outbox-recovery`;

describe('POST /v1/devices/:id/outbox-recovery: who may call it', () => {
  test('no session is 401; manager, cashier and kitchen are 403 even after step-up', async () => {
    expect((await call('POST', url(), undefined, recovery())).statusCode).toBe(401);
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const who = await h.newStaff(role, '4821');
      const token = await h.pinSession(device.token, who.id, '4821');
      await call('POST', '/v1/auth/step-up', token, { pin: '4821' });
      const res = await call('POST', url(), token, recovery());
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  test('the owner needs a fresh step-up', async () => {
    h.clock.advanceSeconds(90);
    const token = await h.ownerSession(owner);
    const res = await call('POST', url(), token, recovery());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  test('an unknown device is 404, a malformed id and a bad body are 400', async () => {
    const token = await steppedOwner();
    const unknown = await call(
      'POST',
      `/v1/devices/${crypto.randomUUID()}/outbox-recovery`,
      token,
      recovery(),
    );
    expect(unknown.statusCode).toBe(404);
    expect(
      (await call('POST', '/v1/devices/nope/outbox-recovery', token, recovery())).statusCode,
    ).toBe(400);
    for (const bad of [
      recovery({ orders: 0, payments: 0 }),
      recovery({ orders: -1 }),
      recovery({ orders: 1.5 }),
      recovery({ action: 'wipe' }),
      recovery({ clientRequestId: 'x' }),
      recovery({ customerName: 'Somchai' }), // no free text, no contents
    ]) {
      expect((await call('POST', url(), token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('what the route records', () => {
  test('an audit row with a fixed action word and counts only, plus a warn alert', async () => {
    const token = await steppedOwner();
    const alerts = h.alerts.length;
    const body = recovery({ orders: 3, payments: 2 });
    const res = await call('POST', url(), token, body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      deviceId: device.id,
      action: 'take_over',
      orders: 3,
      payments: 2,
    });

    const audit = (await h.auditRows(device.id)).filter(
      (a) => a.action === 'device.outbox_take_over',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      deviceId: device.id,
      entity: 'devices',
    });
    expect(audit[0]?.after).toEqual({
      clientRequestId: body.clientRequestId,
      orders: 3,
      payments: 2,
    });
    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({
        kind: 'device.outbox_recovery',
        severity: 'warn',
        staffId: owner.staffId,
        deviceId: device.id,
      }),
    ]);
  });

  test('clear has its own action word', async () => {
    const token = await steppedOwner();
    const res = await call('POST', url(), token, recovery({ action: 'clear' }));
    expect(res.statusCode).toBe(201);
    const audit = (await h.auditRows(device.id)).filter((a) => a.action === 'device.outbox_clear');
    expect(audit).toHaveLength(1);
  });

  test('a retry with the same key answers 200 and writes and alerts nothing more', async () => {
    const token = await steppedOwner();
    const body = recovery({ action: 'clear', orders: 4, payments: 0 });
    const first = await call('POST', url(), token, body);
    expect(first.statusCode).toBe(201);
    const before = (await h.auditRows(device.id)).length;
    const alerts = h.alerts.length;
    const again = await call('POST', url(), await steppedOwner(), body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await h.auditRows(device.id)).length).toBe(before);
    expect(h.alerts.length).toBe(alerts);
  });

  test('the same key with other counts or another action is refused', async () => {
    const token = await steppedOwner();
    const body = recovery({ orders: 1, payments: 1 });
    expect((await call('POST', url(), token, body)).statusCode).toBe(201);
    for (const other of [{ orders: 2 }, { action: 'clear' }]) {
      const res = await call('POST', url(), await steppedOwner(), { ...body, ...other });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
  });
});

// ---------- originalStaffId ----------

const orderBody = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Test Recipient',
  items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
  ...over,
});

describe('originalStaffId on order create', () => {
  test('the owner may name the cashier who took the order: stored, audited, creator stays the owner', async () => {
    const token = await steppedOwner();
    const body = orderBody({ originalStaffId: cashier.id });
    const res = await call('POST', '/v1/orders', token, body);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const [row] = await rows(
      'select created_by_staff_id, original_staff_id from orders where id = $1',
      [id],
    );
    expect(row).toEqual({ created_by_staff_id: owner.staffId, original_staff_id: cashier.id });
    const audit = (await h.auditRows(id)).find((a) => a.action === 'order.create_on_behalf');
    expect(audit).toMatchObject({ actorId: owner.staffId, entity: 'orders' });
    expect(audit?.after).toEqual({ originalStaffId: cashier.id });
    // The response shape did not change.
    expect(res.json()).not.toHaveProperty('originalStaffId');
  });

  test('without the field nothing is stored or audited', async () => {
    const token = await steppedOwner();
    const res = await call('POST', '/v1/orders', token, orderBody());
    const id = res.json().id as string;
    const [row] = await rows('select original_staff_id from orders where id = $1', [id]);
    expect(row?.original_staff_id).toBeNull();
    expect((await h.auditRows(id)).some((a) => a.action === 'order.create_on_behalf')).toBe(false);
  });

  test('an unknown staff id is 422 UNKNOWN_STAFF and nothing is created', async () => {
    const token = await steppedOwner();
    const body = orderBody({ originalStaffId: crypto.randomUUID() });
    const res = await call('POST', '/v1/orders', token, body);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_STAFF' });
    const [n] = await rows('select count(*)::int as n from orders where client_request_id = $1', [
      body.clientRequestId,
    ]);
    expect(n?.n).toBe(0);
  });

  test('only the owner may use it: a cashier naming a colleague is 403', async () => {
    const token = await h.pinSession(device.token, cashier.id, cashier.pin);
    const other = await h.newStaff('cashier', '4821');
    const res = await call('POST', '/v1/orders', token, orderBody({ originalStaffId: other.id }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  test('a replay returns the order and does not audit twice', async () => {
    const token = await steppedOwner();
    const body = orderBody({ originalStaffId: cashier.id });
    const first = await call('POST', '/v1/orders', token, body);
    const again = await call('POST', '/v1/orders', token, body);
    expect(again.statusCode).toBe(200);
    const id = first.json().id as string;
    expect(
      (await h.auditRows(id)).filter((a) => a.action === 'order.create_on_behalf'),
    ).toHaveLength(1);
  });
});

describe('originalStaffId on cash payment create', () => {
  async function newOrder(token: string) {
    const res = await call('POST', '/v1/orders', token, orderBody());
    return res.json().id as string;
  }
  const cash = (over: Record<string, unknown> = {}) => ({
    clientRequestId: crypto.randomUUID(),
    method: 'cash',
    tendered: 10000,
    ...over,
  });

  test('the owner may name the cashier: stored on the payment and in its audit row', async () => {
    const token = await steppedOwner();
    const orderId = await newOrder(token);
    const res = await call(
      'POST',
      `/v1/orders/${orderId}/payments`,
      token,
      cash({ originalStaffId: cashier.id }),
    );
    expect(res.statusCode).toBe(201);
    const paymentId = res.json().payment.id as string;
    const [row] = await rows(
      'select confirmed_by_staff_id, original_staff_id from payments where id = $1',
      [paymentId],
    );
    expect(row).toEqual({ confirmed_by_staff_id: owner.staffId, original_staff_id: cashier.id });
    const audit = (await h.auditRows(paymentId)).find((a) => a.action === 'payment.confirm');
    expect(audit?.after).toMatchObject({ created: true, originalStaffId: cashier.id });
    expect(res.json().payment).not.toHaveProperty('originalStaffId');
  });

  test('unknown staff 422, cashier caller 403, a non-cash method 400, a replay does not write again', async () => {
    const token = await steppedOwner();
    const orderId = await newOrder(token);
    const unknown = await call(
      'POST',
      `/v1/orders/${orderId}/payments`,
      token,
      cash({ originalStaffId: crypto.randomUUID() }),
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: 'UNKNOWN_STAFF' });

    const nonCash = await call('POST', `/v1/orders/${orderId}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'promptpay',
      originalStaffId: cashier.id,
    });
    expect(nonCash.statusCode).toBe(400);

    const cashierToken = await h.pinSession(device.token, cashier.id, cashier.pin);
    const forbidden = await call(
      'POST',
      `/v1/orders/${orderId}/payments`,
      cashierToken,
      cash({ originalStaffId: cashier.id }),
    );
    expect(forbidden.statusCode).toBe(403);

    const body = cash({ originalStaffId: cashier.id });
    const first = await call('POST', `/v1/orders/${orderId}/payments`, token, body);
    expect(first.statusCode).toBe(201);
    const again = await call('POST', `/v1/orders/${orderId}/payments`, token, body);
    expect(again.statusCode).toBe(200);
    const paymentId = first.json().payment.id as string;
    expect(
      (await h.auditRows(paymentId)).filter((a) => a.action === 'payment.confirm'),
    ).toHaveLength(1);
  });
});
