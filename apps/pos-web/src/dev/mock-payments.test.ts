import {
  orderDtoSchema,
  paymentQrUrlResponseSchema,
  paymentResultSchema,
  type StaffRole,
  syncResponseSchema,
} from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMockShop } from './mock-shop.ts';

const TEA = '0192f3a0-0000-7000-8000-000000000208';
let counter = 0;
const requestId = () => `0192f3a0-0000-7000-9000-${String(++counter).padStart(12, '0')}`;

function setup() {
  const shop = createMockShop({ now: () => Date.UTC(2030, 9, 15, 5, 0, 0) });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    role: StaffRole = 'cashier',
    stepUpFresh = false,
  ) => {
    const answer = shop.handle(method, path, new URLSearchParams(), body, { role, stepUpFresh });
    if (!answer) throw new Error(`no route: ${method} ${path}`);
    return answer;
  };
  const newOrder = (fulfillment = 'dine_in', channel = 'storefront') => {
    const answer = call('POST', '/v1/orders', {
      clientRequestId: requestId(),
      channel,
      fulfillment,
      ...(fulfillment === 'room_delivery' ? { roomNo: '1204' } : {}),
      items: [{ menuItemId: TEA, qty: 1, modifierOptionIds: [] }],
    });
    return orderDtoSchema.parse(answer.body);
  };
  return { shop, call, newOrder };
}

describe('the dev shop: orders', () => {
  test('a counter order starts in preparing, like the real server, and is listed for today', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    expect(order.status).toBe('preparing');
    const listed = call('GET', '/v1/orders').body as { orders: { id: string }[] };
    expect(listed.orders.map((o) => o.id)).toEqual([order.id]);
  });

  test('moves follow the shared order machine and the role', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    expect(
      call('POST', `/v1/orders/${order.id}/transition`, { to: 'ready' }, 'kitchen').status,
    ).toBe(200);
    expect(call('POST', `/v1/orders/${order.id}/cancel`, { reason: 'x' }, 'kitchen').status).toBe(
      403,
    );
    expect(call('POST', `/v1/orders/${order.id}/cancel`, { reason: 'x' }, 'manager').status).toBe(
      200,
    );
  });

  test('a claimed or confirmed payment blocks the cancel', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'promptpay',
    });
    // Pending: the cancel cancels it too.
    const refused = newOrder();
    const created = paymentResultSchema.parse(
      call('POST', `/v1/orders/${refused.id}/payments`, {
        clientRequestId: requestId(),
        method: 'promptpay',
      }).body,
    );
    call('POST', `/v1/payments/${created.payment.id}/claim`, {});
    const blocked = call('POST', `/v1/orders/${refused.id}/cancel`, { reason: 'x' }, 'manager');
    expect(blocked.status).toBe(409);
    expect((blocked.body as { code: string }).code).toBe('ORDER_HAS_PAYMENT');
  });
});

describe('the dev shop: payments', () => {
  test('cash: a tender below the total is refused, enough is confirmed at once and the order is paid', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const low = call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'cash',
      tendered: 1000,
    });
    expect((low.body as { code: string }).code).toBe('TENDERED_BELOW_TOTAL');
    const ok = call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'cash',
      tendered: 5000,
    });
    const result = paymentResultSchema.parse(ok.body);
    expect(ok.status).toBe(201);
    expect(result.payment).toMatchObject({
      status: 'confirmed',
      amountSatang: 2500,
      changeSatang: 2500,
    });
    expect(result.order.paymentStatus).toBe('paid');
  });

  test('a request id that was already used answers the original (200), not a second payment', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const body = { clientRequestId: requestId(), method: 'cash', tendered: 5000 };
    const first = call('POST', `/v1/orders/${order.id}/payments`, body);
    const second = call('POST', `/v1/orders/${order.id}/payments`, body);
    expect(second.status).toBe(200);
    expect(paymentResultSchema.parse(second.body).payment.id).toBe(
      paymentResultSchema.parse(first.body).payment.id,
    );
  });

  test('one open payment per order, and a paid order cannot be paid again', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'promptpay',
    });
    const again = call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'cash',
      tendered: 5000,
    });
    expect((again.body as { code: string }).code).toBe('PAYMENT_ALREADY_OPEN');
  });

  test('PromptPay: pending, a QR link with the masked target, claim, then staff confirm', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const made = paymentResultSchema.parse(
      call('POST', `/v1/orders/${order.id}/payments`, {
        clientRequestId: requestId(),
        method: 'promptpay',
      }).body,
    );
    expect(made.payment.status).toBe('pending');
    const link = paymentQrUrlResponseSchema.parse(
      call('GET', `/v1/payments/${made.payment.id}/qr-url`).body,
    );
    expect(link.url.startsWith(`/v1/payments/${made.payment.id}/qr.png?`)).toBe(true);
    const claimed = paymentResultSchema.parse(
      call('POST', `/v1/payments/${made.payment.id}/claim`, {}).body,
    );
    expect(claimed.order.paymentStatus).toBe('awaiting_confirmation');
    const confirmed = paymentResultSchema.parse(
      call('POST', `/v1/payments/${made.payment.id}/confirm`, { referenceNote: '7731' }).body,
    );
    expect(confirmed.payment).toMatchObject({ status: 'confirmed', referenceNote: '7731' });
    expect(confirmed.order.paymentStatus).toBe('paid');
  });

  test('"money not found" needs a reason and puts the order back to unpaid', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const made = paymentResultSchema.parse(
      call('POST', `/v1/orders/${order.id}/payments`, {
        clientRequestId: requestId(),
        method: 'promptpay',
      }).body,
    );
    call('POST', `/v1/payments/${made.payment.id}/claim`, {});
    expect(call('POST', `/v1/payments/${made.payment.id}/cancel-claimed`, {}).status).toBe(422);
    const done = paymentResultSchema.parse(
      call('POST', `/v1/payments/${made.payment.id}/cancel-claimed`, { reason: 'ไม่พบยอด' }).body,
    );
    expect(done.order.paymentStatus).toBe('unpaid');
  });

  test('ไทยช่วยไทย: an estimate on the payment for a counter order, refused for room delivery', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const made = paymentResultSchema.parse(
      call('POST', `/v1/orders/${order.id}/payments`, {
        clientRequestId: requestId(),
        method: 'gov_copay',
      }).body,
    );
    expect(made.payment.estGovShareSatang).toBe(1500);
    expect(made.payment.estCustomerShareSatang).toBe(1000);
    const room = newOrder('room_delivery');
    const refused = call('POST', `/v1/orders/${room.id}/payments`, {
      clientRequestId: requestId(),
      method: 'gov_copay',
    });
    expect((refused.body as { code: string }).code).toBe('GOV_COPAY_UNAVAILABLE');
  });

  test('change method: one call, the same method is refused, a claimed payment is not pending', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const made = paymentResultSchema.parse(
      call('POST', `/v1/orders/${order.id}/payments`, {
        clientRequestId: requestId(),
        method: 'promptpay',
      }).body,
    );
    const same = call('POST', `/v1/payments/${made.payment.id}/change-method`, {
      clientRequestId: requestId(),
      method: 'promptpay',
    });
    expect((same.body as { code: string }).code).toBe('METHOD_UNCHANGED');
    const changed = call('POST', `/v1/payments/${made.payment.id}/change-method`, {
      clientRequestId: requestId(),
      method: 'cash',
      tendered: 5000,
    });
    expect(changed.status).toBe(201);
    expect((changed.body as { cancelledPayment: { status: string } }).cancelledPayment.status).toBe(
      'cancelled',
    );
    const other = newOrder();
    const claimed = paymentResultSchema.parse(
      call('POST', `/v1/orders/${other.id}/payments`, {
        clientRequestId: requestId(),
        method: 'promptpay',
      }).body,
    );
    call('POST', `/v1/payments/${claimed.payment.id}/claim`, {});
    const blocked = call('POST', `/v1/payments/${claimed.payment.id}/change-method`, {
      clientRequestId: requestId(),
      method: 'cash',
      tendered: 5000,
    });
    expect((blocked.body as { code: string }).code).toBe('PAYMENT_NOT_PENDING');
  });

  test('void: only a manager, and only after a step-up; the order goes back to unpaid', () => {
    const { call, newOrder } = setup();
    const order = newOrder();
    const made = paymentResultSchema.parse(
      call('POST', `/v1/orders/${order.id}/payments`, {
        clientRequestId: requestId(),
        method: 'cash',
        tendered: 5000,
      }).body,
    );
    const path = `/v1/payments/${made.payment.id}/void`;
    expect(call('POST', path, { reason: 'x' }, 'cashier', true).status).toBe(403);
    const needsStepUp = call('POST', path, { reason: 'x' }, 'manager', false);
    expect((needsStepUp.body as { code: string }).code).toBe('STEP_UP_REQUIRED');
    const done = paymentResultSchema.parse(
      call('POST', path, { reason: 'x' }, 'manager', true).body,
    );
    expect(done.payment.status).toBe('voided');
    expect(done.order.paymentStatus).toBe('unpaid');
  });

  test('the sync feed carries the payment settings and every frame parses with the shared schema', () => {
    const { shop, call, newOrder } = setup();
    const order = newOrder();
    call('POST', `/v1/orders/${order.id}/payments`, {
      clientRequestId: requestId(),
      method: 'promptpay',
    });
    const feed = shop.handle(
      'GET',
      '/v1/sync',
      new URLSearchParams({ since: '0', limit: '500' }),
      undefined,
    );
    const parsed = syncResponseSchema.parse(feed?.body);
    const settings = parsed.changes.filter((c) => c.type === 'settings.updated').map((c) => c.id);
    expect(settings).toEqual(expect.arrayContaining(['payment_methods', 'promptpay', 'gov_copay']));
    expect(parsed.changes.some((c) => c.type === 'payment.upserted')).toBe(true);
  });
});
