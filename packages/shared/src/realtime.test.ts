import { describe, expect, test } from 'vitest';
import {
  FRAME_TYPES,
  newOrderAlertFrameSchema,
  orderUpsertedFrameSchema,
  paymentUpsertedFrameSchema,
  realtimeFrameSchema,
  SYNC_DEFAULT_LIMIT,
  SYNC_MAX_LIMIT,
  settingsUpdatedFrameSchema,
  syncChangeSchema,
  syncQuerySchema,
  syncResponseSchema,
  WS_CLOSE,
  wsClientMessageSchema,
  wsServerMessageSchema,
} from './realtime.ts';

let counter = 0;
const uuid = () => {
  counter += 1;
  return `0192f3a0-0000-7000-8000-${String(counter).padStart(12, '0')}`;
};
const iso = '2026-10-02T03:00:00.000Z';

const orderData = (over: Record<string, unknown> = {}) => ({
  id: uuid(),
  orderNo: 'S-001',
  businessDate: '2026-10-02',
  channel: 'storefront',
  fulfillment: 'takeaway',
  roomNo: null,
  customerId: null,
  status: 'new',
  paymentStatus: 'unpaid',
  subtotalSatang: 5000,
  discountSatang: 0,
  totalSatang: 5000,
  note: null,
  createdByStaffId: null,
  createdOnDeviceId: null,
  placedAt: iso,
  acceptedAt: null,
  readyAt: null,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  rev: 7,
  items: [],
  ...over,
});

const paymentData = (over: Record<string, unknown> = {}) => ({
  id: uuid(),
  orderId: uuid(),
  method: 'promptpay',
  status: 'pending',
  amountSatang: 5000,
  tenderedSatang: null,
  changeSatang: null,
  promptpayTargetMasked: '******4321',
  schemeId: null,
  estGovShareSatang: null,
  estCustomerShareSatang: null,
  referenceNote: null,
  claimedAt: null,
  confirmedByStaffId: null,
  confirmedAt: null,
  reason: null,
  version: 1,
  rev: 8,
  ...over,
});

describe('the auth message (the first thing a socket sends)', () => {
  const token = 'sds_ses_AbCdEfGhIjKlMnOpQrStUv';

  test('takes a session token and an optional device token, nothing else', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'auth', sessionToken: token }).success).toBe(
      true,
    );
    expect(
      wsClientMessageSchema.safeParse({
        type: 'auth',
        sessionToken: token,
        deviceToken: 'sds_dev_AbCdEfGhIjKlMnOpQrStUv',
      }).success,
    ).toBe(true);
    expect(
      wsClientMessageSchema.safeParse({ type: 'auth', sessionToken: token, extra: 1 }).success,
    ).toBe(false);
  });

  test.each([
    ['no token', { type: 'auth' }],
    ['a short token', { type: 'auth', sessionToken: 'abc' }],
    ['a token with spaces', { type: 'auth', sessionToken: `${token} x` }],
    ['an overlong token', { type: 'auth', sessionToken: 'a'.repeat(201) }],
    ['a token that is not a string', { type: 'auth', sessionToken: 1234567890123456 }],
    ['an unknown type', { type: 'subscribe', sessionToken: token }],
    ['a bad device token', { type: 'auth', sessionToken: token, deviceToken: 'no way' }],
  ])('refuses %s', (_name, message) => {
    expect(wsClientMessageSchema.safeParse(message).success).toBe(false);
  });

  test('a pong is the only other message a client may send', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'pong' }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: 'pong', x: 1 }).success).toBe(false);
  });

  test('a refused message never echoes what was sent', () => {
    const result = wsClientMessageSchema.safeParse({ type: 'auth', sessionToken: 'secret value' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('secret value');
  });
});

describe('event frames carry {type, id, rev, data}', () => {
  test('an order frame', () => {
    const data = orderData();
    const frame = { type: 'order.upserted', id: data.id, rev: 7, data };
    expect(orderUpsertedFrameSchema.parse(frame)).toMatchObject({ type: 'order.upserted', rev: 7 });
  });

  test('cost fields inside order lines are stripped, not passed on', () => {
    const data = orderData({
      items: [
        {
          id: uuid(),
          menuItemId: uuid(),
          nameTh: 'ก๋วยเตี๋ยว',
          nameEn: null,
          unitPriceSatang: 5000,
          unitCostSatang: 2200,
          qty: 1,
          modifiers: [
            {
              groupId: uuid(),
              optionId: uuid(),
              nameTh: 'ไข่',
              nameEn: null,
              priceDeltaSatang: 500,
              costDeltaSatang: 300,
            },
          ],
          note: null,
          lineTotalSatang: 5500,
        },
      ],
    });
    const parsed = orderUpsertedFrameSchema.parse({
      type: 'order.upserted',
      id: data.id,
      rev: 7,
      data,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/cost/i);
  });

  test('a payment frame never holds a QR payload, request hash or slip', () => {
    const data = paymentData();
    const parsed = paymentUpsertedFrameSchema.parse({
      type: 'payment.upserted',
      id: data.id,
      rev: 8,
      data: { ...data, qrPayload: '00020101...', requestHash: 'abc', slipImageKey: 'k' },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/qrPayload|requestHash|slip/i);
  });

  test('a frame with a negative or fractional rev is refused', () => {
    const data = orderData();
    for (const rev of [-1, 1.5]) {
      expect(
        orderUpsertedFrameSchema.safeParse({ type: 'order.upserted', id: data.id, rev, data })
          .success,
      ).toBe(false);
    }
  });

  test('the new-order alert has no rev: it is not a stored row', () => {
    const parsed = newOrderAlertFrameSchema.parse({
      type: 'alert.new_order',
      id: uuid(),
      data: { orderNo: 'S-001', channel: 'storefront', status: 'new', createdOnDeviceId: null },
    });
    expect('rev' in parsed).toBe(false);
  });
});

describe('settings frames', () => {
  const frame = (id: string, data: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'settings.updated',
    id,
    rev: 5,
    version: 2,
    data,
    ...extra,
  });

  test('the PromptPay frame carries the masked form only', () => {
    const ok = settingsUpdatedFrameSchema.safeParse(
      frame('promptpay', { idType: 'phone', idMasked: '******4321' }),
    );
    expect(ok.success).toBe(true);
    // The clear ID is refused outright, and if both are present the clear one is dropped.
    expect(
      settingsUpdatedFrameSchema.safeParse(
        frame('promptpay', { idType: 'phone', idValue: '0899994321' }),
      ).success,
    ).toBe(false);
    const both = settingsUpdatedFrameSchema.parse(
      frame('promptpay', { idType: 'phone', idMasked: '******4321', idValue: '0899994321' }),
    );
    expect(JSON.stringify(both)).not.toContain('0899994321');
  });

  test('a key nobody listed is refused (default deny for future settings)', () => {
    expect(
      settingsUpdatedFrameSchema.safeParse(frame('line_channel_secret', { secret: 'x' })).success,
    ).toBe(false);
  });

  test('the known keys parse with their own shapes', () => {
    expect(
      settingsUpdatedFrameSchema.safeParse(
        frame('payment_methods', { cash: true, promptpay: true, platform: true, other: false }),
      ).success,
    ).toBe(true);
    expect(
      settingsUpdatedFrameSchema.safeParse(
        frame('business_day', { cutoffMinutes: 240, timeZone: 'Asia/Bangkok' }),
      ).success,
    ).toBe(true);
    expect(settingsUpdatedFrameSchema.safeParse(frame('shop', { nameTh: 5 })).success).toBe(false);
  });

  test('the delivery buildings travel, so every device learns a change of the list', () => {
    expect(
      settingsUpdatedFrameSchema.safeParse(frame('delivery', { buildings: ['A1', 'B2'] })).success,
    ).toBe(true);
    expect(settingsUpdatedFrameSchema.safeParse(frame('delivery', { buildings: [] })).success).toBe(
      false,
    );
  });
});

describe('the frame list', () => {
  test('every frame type is listed once, so an audience must be chosen for each', () => {
    expect([...FRAME_TYPES].sort()).toEqual(
      [
        'alert.new_order',
        'customer.upserted',
        'menu.upserted',
        'order.upserted',
        'payment.upserted',
        'settings.updated',
      ].sort(),
    );
  });

  test('realtimeFrameSchema accepts each, and the sync change list excludes the alert', () => {
    const data = orderData();
    const order = { type: 'order.upserted', id: data.id, rev: 1, data };
    expect(realtimeFrameSchema.safeParse(order).success).toBe(true);
    expect(syncChangeSchema.safeParse(order).success).toBe(true);
    const alert = {
      type: 'alert.new_order',
      id: uuid(),
      data: { orderNo: 'S-001', channel: 'storefront', status: 'new', createdOnDeviceId: null },
    };
    expect(realtimeFrameSchema.safeParse(alert).success).toBe(true);
    expect(syncChangeSchema.safeParse(alert).success).toBe(false);
  });
});

describe('sync', () => {
  test('the query defaults, coerces strings and bounds the page', () => {
    expect(syncQuerySchema.parse({})).toEqual({ since: 0, limit: SYNC_DEFAULT_LIMIT });
    expect(syncQuerySchema.parse({ since: '41', limit: '10' })).toEqual({ since: 41, limit: 10 });
    for (const bad of [
      { since: '-1' },
      { since: '1.5' },
      { since: 'x' },
      { limit: '0' },
      { limit: String(SYNC_MAX_LIMIT + 1) },
      { surprise: '1' },
    ]) {
      expect(syncQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test('the response holds changes, the cursor, hasMore and the server revision', () => {
    expect(
      syncResponseSchema.safeParse({ changes: [], nextSince: 0, hasMore: false, serverRev: 12 })
        .success,
    ).toBe(true);
    expect(
      syncResponseSchema.safeParse({ changes: [], nextSince: 0, hasMore: false }).success,
    ).toBe(false);
  });
});

describe('server messages and close codes', () => {
  test('ready, ping and frames are server messages', () => {
    expect(
      wsServerMessageSchema.safeParse({ type: 'ready', serverRev: 3, heartbeatSeconds: 25 })
        .success,
    ).toBe(true);
    expect(wsServerMessageSchema.safeParse({ type: 'ping', serverRev: 3 }).success).toBe(true);
    const data = orderData();
    expect(
      wsServerMessageSchema.safeParse({ type: 'order.upserted', id: data.id, rev: 1, data })
        .success,
    ).toBe(true);
  });

  test('close codes are distinct and in the application range (except going away)', () => {
    const codes = Object.values(WS_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(WS_CLOSE.GOING_AWAY).toBe(1001);
    for (const [name, code] of Object.entries(WS_CLOSE)) {
      if (['GOING_AWAY', 'MESSAGE_TOO_BIG', 'INTERNAL'].includes(name)) continue;
      expect(code, name).toBeGreaterThanOrEqual(4000);
      expect(code, name).toBeLessThan(5000);
    }
  });
});
