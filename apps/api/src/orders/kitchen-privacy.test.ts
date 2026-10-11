/**
 * The kitchen reads every order but never receives the member's phone number (owner, 2026-10-12):
 * not from the list, one order, a move, the live frame or the catch-up. Roles that take orders keep
 * it. The LINE name and picture travel to everyone.
 */
import { type OrderDto, orderDtoSchema, STAFF_ROLES } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { frameForRole } from '../realtime/frames.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'kitchen', { id: string; pin: string }>;
const tokens = {} as Record<'cashier' | 'kitchen', string>;

// Made-up person and number: no real customer data in tests.
const PHONE = '0812345678';
const LINE = { displayName: 'Tee Test', pictureUrl: 'https://profile.line-scdn.net/test/p' };

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  device = await h.newDevice();
  for (const role of ['cashier', 'kitchen'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }
  h.clock.set('2028-02-01T03:00:00.000Z');
  for (const role of ['cashier', 'kitchen'] as const) {
    tokens[role] = await h.pinSession(device.token, staff[role].id, staff[role].pin);
  }
}, 60_000);
afterAll(async () => {
  await h.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (token: string, url: string) =>
  h.app.inject({ method: 'GET', url, headers: bearer(token) });

async function placeWithMember(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: bearer(tokens.cashier),
    payload: {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
    },
  });
  const order = orderDtoSchema.parse(res.json());
  // The member snapshot and the LINE name come from a customer's own order, so the row is set here.
  await h.client.query(
    `update orders set member_nickname = 'Tee', member_phone = $2,
       line_display_name = $3, line_picture_url = $4 where id = $1`,
    [order.id, PHONE, LINE.displayName, LINE.pictureUrl],
  );
  return order.id;
}

describe('the member phone number', () => {
  test('a cashier reads it; the kitchen does not, on one order and on the list', async () => {
    const id = await placeWithMember();
    const asCashier = orderDtoSchema.parse((await get(tokens.cashier, `/v1/orders/${id}`)).json());
    expect(asCashier.member?.phone).toBe(PHONE);
    expect(asCashier.line).toEqual(LINE);

    const res = await get(tokens.kitchen, `/v1/orders/${id}`);
    const asKitchen = orderDtoSchema.parse(res.json());
    expect(asKitchen.member).toMatchObject({ nickname: 'Tee', phone: null });
    expect(asKitchen.line).toEqual(LINE);
    expect(res.body).not.toContain(PHONE);

    const list = await get(tokens.kitchen, '/v1/orders');
    expect(list.body).not.toContain(PHONE);
    expect((await get(tokens.cashier, '/v1/orders')).body).toContain(PHONE);
  });

  test('a move by the kitchen answers without it, and the catch-up never carries it', async () => {
    const id = await placeWithMember();
    const moved = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${id}/transition`,
      headers: bearer(tokens.kitchen),
      payload: { to: 'ready' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.body).not.toContain(PHONE);

    const sync = await get(tokens.kitchen, '/v1/sync?since=0&limit=500');
    expect(sync.statusCode).toBe(200);
    expect(sync.body).toContain('Tee Test');
    expect(sync.body).not.toContain(PHONE);
    expect((await get(tokens.cashier, '/v1/sync?since=0&limit=500')).body).toContain(PHONE);
  });
});

describe('the live frame', () => {
  const frame = {
    type: 'order.upserted' as const,
    id: '00000000-0000-4000-8000-000000000001',
    rev: 5,
    data: {
      member: { fullName: null, nickname: 'Tee', building: null, phone: PHONE },
      line: LINE,
    } as unknown as OrderDto,
  };

  test('is cut down for the kitchen only', () => {
    for (const role of STAFF_ROLES) {
      const out = frameForRole(role, frame);
      expect(out.data.member?.phone).toBe(role === 'kitchen' ? null : PHONE);
      expect(out.data.line).toEqual(LINE);
    }
    expect(frame.data.member?.phone).toBe(PHONE);
  });

  test('leaves a frame that is not an order alone', () => {
    const other = { type: 'menu.upserted' as const, id: 'x' };
    expect(frameForRole('kitchen', other)).toBe(other);
  });
});
