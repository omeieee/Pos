import {
  ANONYMIZED_RECIPIENT_NAME,
  anonymizeCustomerResponseSchema,
  orderDtoSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMemorySlipStore } from '../slips/store.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

const slipStore = createMemorySlipStore();
let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness({ slips: slipStore });
  owner = await h.newOwner({ pin: '246810' });
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** A fresh owner session that has stepped up. Moves the clock so the TOTP codes are new. */
async function admin() {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
}

function anonymize(token: string | undefined, id: string, body?: unknown) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/customers/${id}/anonymize`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

// Made-up person only: no real customer data in tests.
const NAME = 'Zzyx-Erase-Me';
const NOTE = 'Zzyx-Erase-Note';

async function seedCustomer(): Promise<string> {
  const rows = await h.client.query<{ id: string }>(
    `insert into customers (line_user_id, display_name, phone, building, recipient_name, delivery_note, recipient_key, order_count)
     values ($1, $2, '0800000000', 'B1', $2, $3, $4, 2) returning id`,
    [`U-test-${crypto.randomUUID()}`, NAME, NOTE, `${NAME.toLowerCase()}-${crypto.randomUUID()}`],
  );
  return String(rows.rows[0]?.id);
}

async function seedEntranceOrder(customerId: string): Promise<string> {
  const rows = await h.client.query<{ id: string }>(
    `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
       delivery_note, customer_id, status, subtotal_satang, total_satang, client_request_id)
     values ($1, '2026-10-02', 'storefront', 'entrance_delivery', 'B1', $2, $3, $4, 'completed', 5000, 5000, gen_random_uuid())
     returning id`,
    [`T-${Math.floor(Math.random() * 1e9)}`, NAME, NOTE, customerId],
  );
  return String(rows.rows[0]?.id);
}

const customerRow = async (id: string) =>
  (await h.client.query<Record<string, unknown>>('select * from customers where id = $1', [id]))
    .rows[0];

describe('who may anonymise a customer', () => {
  test('nobody without a session', async () => {
    expect((await anonymize(undefined, crypto.randomUUID())).statusCode).toBe(401);
  });

  test('not the manager, cashier or kitchen, even after they step up', async () => {
    const id = await seedCustomer();
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const who = await h.newStaff(role, '4821');
      const token = await h.pinSession(device.token, who.id, '4821');
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/step-up',
        headers: { authorization: `Bearer ${token}` },
        payload: { pin: '4821' },
        remoteAddress: h.nextIp(),
      });
      const res = await anonymize(token, id);
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await customerRow(id)).toMatchObject({ anonymized_at: null, display_name: NAME });
  });

  test('the owner needs a fresh step-up: signing in is not enough', async () => {
    h.clock.advanceSeconds(90);
    const token = await h.ownerSession(owner);
    const id = await seedCustomer();
    const res = await anonymize(token, id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await customerRow(id)).toMatchObject({ anonymized_at: null });
  });
});

describe('POST /v1/customers/{id}/anonymize', () => {
  test('erasing a customer also deletes the slip pictures on their orders and clears the keys', async () => {
    const id = await seedCustomer();
    const orderId = await seedEntranceOrder(id);
    const key = 'k'.repeat(32);
    await slipStore.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    await h.client.query(
      `insert into payments (order_id, method, status, amount_satang, client_request_id, slip_image_key)
       values ($1, 'promptpay', 'claimed', 5000, gen_random_uuid(), $2)`,
      [orderId, key],
    );
    const res = await anonymize(await admin(), id);
    expect(res.statusCode).toBe(200);
    expect(
      (await h.client.query('select slip_image_key from payments where order_id = $1', [orderId]))
        .rows,
    ).toEqual([{ slip_image_key: null }]);
    await expect(slipStore.get(key)).resolves.toBeNull();
  });

  test('erases the person, keeps the orders as records, and tells the live feed', async () => {
    const token = await admin();
    const id = await seedCustomer();
    const orderId = await seedEntranceOrder(id);
    const before = h.events.length;

    h.clock.advanceSeconds(5);
    const res = await anonymize(token, id, { reason: 'customer_request' });
    expect(res.statusCode).toBe(200);
    const dto = anonymizeCustomerResponseSchema.parse(res.json());
    expect(dto).toMatchObject({ id, anonymizedAt: h.clock.now().toISOString() });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain(NAME);

    expect(await customerRow(id)).toMatchObject({
      line_user_id: null,
      display_name: null,
      phone: null,
      building: null,
      recipient_name: null,
      delivery_note: null,
      recipient_key: null,
      order_count: 2,
    });

    // The order stays; the person on it is replaced, and the live screens hear about it.
    const order = (
      await h.client.query<Record<string, unknown>>('select * from orders where id = $1', [orderId])
    ).rows[0];
    expect(order).toMatchObject({
      recipient_name: ANONYMIZED_RECIPIENT_NAME,
      delivery_note: null,
      delivery_building: 'B1',
      total_satang: 5000,
    });
    const upserted = h.events
      .slice(before)
      .filter((e) => e.type === 'order.upserted' && e.id === orderId);
    expect(upserted).toHaveLength(1);
    const event = upserted[0];
    if (event?.type !== 'order.upserted') throw new Error('expected order.upserted');
    expect(orderDtoSchema.parse(event.data)).toMatchObject({
      recipientName: ANONYMIZED_RECIPIENT_NAME,
      deliveryNote: null,
    });
    expect(JSON.stringify(h.events.slice(before))).not.toContain(NAME);
    expect(JSON.stringify(h.events.slice(before))).not.toContain(NOTE);
  });

  test('is audited and alerted, with ids and a fixed reason word and no personal data', async () => {
    const token = await admin();
    const id = await seedCustomer();
    await seedEntranceOrder(id);
    const alertsBefore = h.alerts.length;

    const res = await anonymize(token, id, { reason: 'retention' });
    expect(res.statusCode).toBe(200);

    const audit = (await h.auditRows(id)).filter((a) => a.action === 'customer.anonymize');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      entity: 'customers',
      after: { reason: 'retention', orders: 1 },
    });
    expect(JSON.stringify(audit[0])).not.toContain(NAME);
    expect(JSON.stringify(audit[0])).not.toContain(NOTE);

    const alerts = h.alerts.slice(alertsBefore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'customer.anonymized', severity: 'warn' });
    expect(JSON.stringify(alerts)).not.toContain(NAME);
    expect(h.logs()).not.toContain(NAME);
  });

  test('the reason is optional, and the body may be missing altogether', async () => {
    const token = await admin();
    const id = await seedCustomer();
    expect((await anonymize(token, id)).statusCode).toBe(200);
    const audit = (await h.auditRows(id)).filter((a) => a.action === 'customer.anonymize');
    expect(audit[0]).toMatchObject({ after: { orders: 0 } });
    expect(JSON.stringify(audit[0]?.after)).not.toContain('reason');
  });

  test('asking again is a quiet 200: same answer, no second audit row, alert or event', async () => {
    const token = await admin();
    const id = await seedCustomer();
    const first = await anonymize(token, id, { reason: 'customer_request' });
    const eventsBefore = h.events.length;
    const rowBefore = await customerRow(id);

    h.clock.advanceSeconds(30);
    const again = await anonymize(token, id, { reason: 'other' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await customerRow(id)).toEqual(rowBefore);
    expect(h.events.length).toBe(eventsBefore);
    expect((await h.auditRows(id)).filter((a) => a.action === 'customer.anonymize')).toHaveLength(
      1,
    );
  });

  test('an unknown customer is 404, a bad id or reason is 400, and nothing is written', async () => {
    const token = await admin();
    const auditBefore = (await h.client.query('select 1 from audit_log')).rows.length;
    const missing = await anonymize(token, crypto.randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    const badId = await anonymize(token, 'not-a-uuid');
    expect(badId.statusCode).toBe(400);
    const id = await seedCustomer();
    const badReason = await anonymize(token, id, { reason: `Somebody called ${NAME}` });
    expect(badReason.statusCode).toBe(400);
    expect(badReason.body).not.toContain(NAME);
    expect(await customerRow(id)).toMatchObject({ anonymized_at: null });
    expect((await h.client.query('select 1 from audit_log')).rows.length).toBe(auditBefore);
  });

  test('an anonymised customer can no longer be given to a new order', async () => {
    const token = await admin();
    const id = await seedCustomer();
    await anonymize(token, id);
    const staff = await h.newStaff('cashier', '4821');
    const cashier = await h.pinSession(device.token, staff.id, '4821');
    const menu = await h.newMenu();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${cashier}` },
      payload: {
        clientRequestId: crypto.randomUUID(),
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Test Recipient',
        customerId: id,
        items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_CUSTOMER' });
  });
});
