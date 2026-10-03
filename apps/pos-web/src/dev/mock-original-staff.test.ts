import { orderDtoSchema, type StaffRole } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMockAdmin, type MockDevice, type MockPerson } from './mock-admin.ts';
import { createMockShop } from './mock-shop.ts';

const TEA = '0192f3a0-0000-7000-8000-000000000208';
const OWNER = '0192f3a0-0000-7000-8000-0000000000a1';
const CASHIER = '0192f3a0-0000-7000-8000-0000000000a2';
const STRANGER = '0192f3a0-0000-7000-8000-0000000000a9';
let counter = 0;
const requestId = () => `0192f3a0-0000-7000-9000-${String(++counter).padStart(12, '0')}`;

const known = (id: string) => id === OWNER || id === CASHIER;

function shopSetup() {
  const shop = createMockShop({ now: () => Date.UTC(2030, 9, 15, 5, 0, 0) });
  const call = (
    method: string,
    path: string,
    body: unknown,
    who: { role: StaffRole; stepUpFresh: boolean; staffId?: string },
  ) => {
    const answer = shop.handle(method, path, new URLSearchParams(), body, {
      ...who,
      staffKnown: known,
    });
    if (!answer) throw new Error(`no route: ${method} ${path}`);
    return answer;
  };
  const owner = (stepUpFresh = true) => ({
    role: 'owner' as const,
    stepUpFresh,
    staffId: OWNER,
  });
  const orderBody = (id: string, extra: Record<string, unknown> = {}) => ({
    clientRequestId: id,
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Tester',
    items: [{ menuItemId: TEA, qty: 1, modifierOptionIds: [] }],
    ...extra,
  });
  return { shop, call, owner, orderBody };
}

describe('the dev shop: originalStaffId on an order', () => {
  test('the owner with a fresh step-up may name a known person; the order is theirs, the name is kept', () => {
    const { shop, call, owner, orderBody } = shopSetup();
    const id = requestId();
    const answer = call('POST', '/v1/orders', orderBody(id, { originalStaffId: CASHIER }), owner());
    expect(answer.status).toBe(201);
    expect(orderDtoSchema.parse(answer.body).orderNo).toMatch(/^S-/);
    expect(shop.attributions()).toEqual([{ requestId: id, original: CASHIER, creator: OWNER }]);
  });

  test('anyone but the owner is refused, before anything is read', () => {
    const { call, orderBody } = shopSetup();
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const answer = call(
        'POST',
        '/v1/orders',
        orderBody(requestId(), { originalStaffId: OWNER }),
        {
          role,
          stepUpFresh: true,
          staffId: CASHIER,
        },
      );
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  test('the owner without a fresh step-up gets 403 STEP_UP_REQUIRED, a replay included', () => {
    const { call, owner, orderBody } = shopSetup();
    const id = requestId();
    const stale = call(
      'POST',
      '/v1/orders',
      orderBody(id, { originalStaffId: CASHIER }),
      owner(false),
    );
    expect(stale).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    // Made once with the step-up, then replayed after it lapsed: still asked for.
    call('POST', '/v1/orders', orderBody(id, { originalStaffId: CASHIER }), owner());
    const replay = call(
      'POST',
      '/v1/orders',
      orderBody(id, { originalStaffId: CASHIER }),
      owner(false),
    );
    expect(replay).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
  });

  test('an unknown person is 422 UNKNOWN_STAFF and nothing is made', () => {
    const { shop, call, owner, orderBody } = shopSetup();
    const answer = call(
      'POST',
      '/v1/orders',
      orderBody(requestId(), { originalStaffId: STRANGER }),
      owner(),
    );
    expect(answer).toMatchObject({ status: 422, body: { code: 'UNKNOWN_STAFF' } });
    expect(shop.attributions()).toEqual([]);
  });

  test('a replay answers the same order (200); naming someone else is 409; leaving the name out is fine', () => {
    const { call, owner, orderBody } = shopSetup();
    const id = requestId();
    const first = call('POST', '/v1/orders', orderBody(id, { originalStaffId: CASHIER }), owner());
    const same = call('POST', '/v1/orders', orderBody(id, { originalStaffId: CASHIER }), owner());
    expect(same.status).toBe(200);
    expect(same.body).toEqual(first.body);
    expect(call('POST', '/v1/orders', orderBody(id), owner()).status).toBe(200);
    expect(
      call('POST', '/v1/orders', orderBody(id, { originalStaffId: OWNER }), owner()),
    ).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  test('the cashier’s own order that landed, replayed by the owner naming the cashier, is the same order', () => {
    const { call, owner, orderBody } = shopSetup();
    const id = requestId();
    const landed = call('POST', '/v1/orders', orderBody(id), {
      role: 'cashier',
      stepUpFresh: false,
      staffId: CASHIER,
    });
    expect(landed.status).toBe(201);
    const replay = call('POST', '/v1/orders', orderBody(id, { originalStaffId: CASHIER }), owner());
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(landed.body);
    // Naming anybody else for it is a different story.
    expect(
      call('POST', '/v1/orders', orderBody(id, { originalStaffId: OWNER }), owner()).status,
    ).toBe(409);
  });

  test('another body under the same id is still 409, with or without a name', () => {
    const { call, owner, orderBody } = shopSetup();
    const id = requestId();
    call('POST', '/v1/orders', orderBody(id), owner());
    expect(
      call('POST', '/v1/orders', orderBody(id, { deliveryBuilding: 'B2' }), owner()).status,
    ).toBe(409);
  });
});

describe('the dev shop: originalStaffId on cash', () => {
  function withOrder() {
    const env = shopSetup();
    const order = orderDtoSchema.parse(
      env.call('POST', '/v1/orders', env.orderBody(requestId()), env.owner()).body,
    );
    const pay = (
      extra: Record<string, unknown>,
      who: { role: StaffRole; stepUpFresh: boolean; staffId?: string } = env.owner(),
      id = requestId(),
    ) =>
      env.call(
        'POST',
        `/v1/orders/${order.id}/payments`,
        { clientRequestId: id, method: 'cash', tendered: 100_000, ...extra },
        who,
      );
    return { ...env, order, pay };
  }

  test('cash names the person under the same rules', () => {
    const { shop, pay } = withOrder();
    const id = requestId();
    expect(pay({ originalStaffId: CASHIER }, undefined, id).status).toBe(201);
    expect(shop.attributions().find((a) => a.requestId === id)).toMatchObject({
      original: CASHIER,
      creator: OWNER,
    });
    expect(pay({ originalStaffId: CASHIER }, undefined, id).status).toBe(200);
    expect(pay({ originalStaffId: OWNER }, undefined, id)).toMatchObject({
      status: 409,
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  test('forbidden for others, step-up for a stale owner, unknown person 422', () => {
    const { pay, owner } = withOrder();
    expect(
      pay({ originalStaffId: CASHIER }, { role: 'cashier', stepUpFresh: true, staffId: CASHIER })
        .status,
    ).toBe(403);
    expect(pay({ originalStaffId: CASHIER }, owner(false))).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(pay({ originalStaffId: STRANGER })).toMatchObject({
      status: 422,
      body: { code: 'UNKNOWN_STAFF' },
    });
  });
});

describe('the dev server: POST /v1/devices/:id/outbox-recovery', () => {
  const DEVICE = '0192f3a0-0000-7000-8000-0000000000d1';
  function adminSetup() {
    const people: MockPerson[] = [];
    const devices: MockDevice[] = [
      { id: DEVICE, name: 'iPad', kind: 'ipad', lastSeenAt: null, revokedAt: null, version: 1 },
    ];
    const admin = createMockAdmin({
      now: () => Date.UTC(2030, 9, 15, 5, 0, 0),
      newUuid: () => crypto.randomUUID(),
      people,
      devices,
      lockedUntil: () => 0,
      endSessions: () => undefined,
      revokeDevice: () => undefined,
    });
    const post = (
      body: unknown,
      caller: { role: StaffRole; stepUpFresh: boolean } = { role: 'owner', stepUpFresh: true },
      id = DEVICE,
    ) => admin.handle('POST', `/v1/devices/${id}/outbox-recovery`, body, caller);
    return { admin, post };
  }
  const body = (over: Record<string, unknown> = {}) => ({
    clientRequestId: requestId(),
    action: 'take_over',
    orders: 2,
    payments: 1,
    ...over,
  });

  test('201 the first time with the counts back, 200 for the same request id', () => {
    const { post, admin } = adminSetup();
    const first = body();
    expect(post(first)).toEqual({
      status: 201,
      body: { deviceId: DEVICE, action: 'take_over', orders: 2, payments: 1 },
    });
    expect(post(first)?.status).toBe(200);
    expect(admin.recoveries()).toHaveLength(1);
  });

  test('the same request id with other counts or another action is 409 IDEMPOTENCY_KEY_REUSED', () => {
    const { post } = adminSetup();
    const first = body();
    post(first);
    for (const other of [{ orders: 3 }, { payments: 0 }, { action: 'clear' }]) {
      expect(post({ ...first, ...other })).toMatchObject({
        status: 409,
        body: { code: 'IDEMPOTENCY_KEY_REUSED' },
      });
    }
  });

  test('owner only, with a fresh step-up, a body the shared schema accepts, and a known device', () => {
    const { post } = adminSetup();
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      expect(post(body(), { role, stepUpFresh: true })?.status).toBe(403);
    }
    expect(post(body(), { role: 'owner', stepUpFresh: false })).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(post(body({ orders: 0, payments: 0 }))?.status).toBe(400);
    expect(post(body({ action: 'wipe' }))?.status).toBe(400);
    expect(post(body(), undefined, '0192f3a0-0000-7000-8000-0000000000ff')?.status).toBe(404);
  });
});
