import { describe, expect, test } from 'vitest';
import type { NewOrderInput } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { uuid } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import {
  backoffMs,
  cashEntry,
  classifyReplayError,
  deviceCode,
  ERROR_PARENT_MISSING,
  orderEntry,
  ownsEntry,
  provisionalLabel,
  STUCK_AFTER,
  snapshotOrder,
  toQueueItems,
} from './outbox-model.ts';

const OWNER = { staffId: uuid(1), deviceId: uuid(2) };
const body: NewOrderInput = {
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Fah ตัวอย่าง',
  items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
};
const payload = (label = 'XK-01') => ({
  body: { ...body },
  label,
  lines: [
    {
      name: { th: 'ชาเย็น', en: 'Thai iced tea' },
      options: [],
      qty: 1,
      note: '',
      lineTotalSatang: 2500,
    },
  ],
  estimateSatang: 2500,
});

describe('the provisional label', () => {
  test('is the device code and a counter of at least two digits', () => {
    expect(provisionalLabel(uuid(2), 7)).toBe(`${deviceCode(uuid(2))}-07`);
    expect(provisionalLabel(uuid(2), 123)).toBe(`${deviceCode(uuid(2))}-123`);
    expect(deviceCode(uuid(2))).toMatch(/^X[1-9A-Z]$/);
  });
});

describe('who may see and replay an entry', () => {
  test('only its creator, on the device it was made on', () => {
    const entry = orderEntry(uuid(10), payload(), OWNER, 1);
    expect(ownsEntry(entry, OWNER)).toBe(true);
    expect(ownsEntry(entry, { ...OWNER, staffId: uuid(3) })).toBe(false);
    expect(ownsEntry(entry, { ...OWNER, deviceId: uuid(4) })).toBe(false);
    expect(ownsEntry({}, OWNER)).toBe(false);
  });
});

describe('classifying a failed replay', () => {
  const classify = (code: string, status: number | null = null) =>
    classifyReplayError(new ApiClientError(code, { status }));
  test('no answer is unreachable', () => {
    expect(classify('NETWORK')).toBe('unreachable');
    expect(classify('TIMEOUT')).toBe('unreachable');
  });
  test('a server fault is transient', () => {
    expect(classify('INTERNAL', 500)).toBe('transient');
    expect(classify('X', 503)).toBe('transient');
    expect(classify('RESPONSE_INVALID', 200)).toBe('transient');
    expect(classify('RATE_LIMITED', 429)).toBe('transient');
  });
  test('a lost session pauses the queue', () => {
    for (const code of ['UNAUTHENTICATED', 'DEVICE_UNREGISTERED', 'DEVICE_MISMATCH']) {
      expect(classify(code, 401)).toBe('pause');
    }
  });
  test('every other answer is a refusal', () => {
    for (const [code, status] of [
      ['IDEMPOTENCY_KEY_REUSED', 409],
      ['TENDERED_BELOW_TOTAL', 422],
      ['ORDER_INVALID', 422],
      ['FORBIDDEN', 403],
      ['REQUEST_INVALID', null],
    ] as const) {
      expect(classify(code, status)).toBe('refused');
    }
  });
});

describe('the backoff', () => {
  test('doubles, is capped and is jittered between half and one and a half', () => {
    expect(backoffMs(1, () => 0.5)).toBe(2000);
    expect(backoffMs(2, () => 0.5)).toBe(4000);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(3, () => 0.999)).toBe(Math.round(8000 * 1.499));
    expect(backoffMs(40, () => 0.5)).toBe(60_000);
  });
});

describe('the entries as items', () => {
  test('an order shows its recipient, lines and estimate', () => {
    const [item] = toQueueItems([orderEntry(uuid(10), payload(), OWNER, 1)]);
    expect(item).toMatchObject({
      kind: 'order',
      state: 'queued',
      label: 'XK-01',
      estimateSatang: 2500,
      recipient: { building: 'B1', name: 'Fah ตัวอย่าง', note: null },
    });
  });

  test('a refused order needs attention and can be retried, but a reused id only discarded', () => {
    const refused = {
      ...orderEntry(uuid(10), payload(), OWNER, 1),
      state: 'attention' as const,
      lastError: 'ORDER_INVALID',
    };
    const reused = { ...refused, id: uuid(11), lastError: 'IDEMPOTENCY_KEY_REUSED' };
    const [a, b] = toQueueItems([refused, reused]);
    expect(a).toMatchObject({ state: 'attention', error: 'ORDER_INVALID', canRetry: true });
    expect(b).toMatchObject({ state: 'attention', canRetry: false });
  });

  test('a payment waits behind its order and is blocked while that order needs attention', () => {
    const order = orderEntry(uuid(10), payload(), OWNER, 1);
    const pay = cashEntry(
      uuid(20),
      { target: { entryId: uuid(10) }, tenderedSatang: 10000, label: 'XK-01', totalSatang: 2500 },
      OWNER,
      2,
    );
    expect(toQueueItems([order, pay])[1]).toMatchObject({
      kind: 'payment',
      state: 'queued',
      dependsOn: uuid(10),
      orderId: null,
    });
    const refused = { ...order, state: 'attention' as const, lastError: 'ORDER_INVALID' };
    expect(toQueueItems([refused, pay])[1]).toMatchObject({ state: 'blocked' });
  });

  test('a payment whose order entry is gone needs attention and cannot be retried', () => {
    const pay = cashEntry(
      uuid(20),
      { target: { entryId: uuid(10) }, tenderedSatang: 10000, label: 'XK-01', totalSatang: 2500 },
      OWNER,
      2,
    );
    expect(toQueueItems([pay])[0]).toMatchObject({
      state: 'attention',
      error: ERROR_PARENT_MISSING,
      canRetry: false,
    });
  });

  test('a payment for a synced order carries the server order id', () => {
    const pay = cashEntry(
      uuid(20),
      { target: { orderId: uuid(30) }, tenderedSatang: 10000, label: 'S-001', totalSatang: 2500 },
      OWNER,
      2,
    );
    expect(toQueueItems([pay])[0]).toMatchObject({ orderId: uuid(30), dependsOn: null });
  });

  test('an unreadable row is shown as needing attention, never dropped', () => {
    const [item] = toQueueItems([
      { id: uuid(9), kind: 'order.create', payload: 5, createdAt: 1, attempts: 0 },
    ]);
    expect(item).toMatchObject({ state: 'attention', canRetry: false });
  });

  test('many failed tries make an entry stuck, not refused', () => {
    const order = orderEntry(uuid(10), payload(), OWNER, 1);
    const [item] = toQueueItems([order], new Map([[uuid(10), STUCK_AFTER]]));
    expect(item).toMatchObject({ state: 'queued', stuck: true });
  });
});

describe('the snapshot of an order', () => {
  test('keeps names and the shared estimate so the order shows without the menu', () => {
    const entities = createEntityStore();
    seedMenu(entities);
    const snap = snapshotOrder(
      entities.getState(),
      [{ key: 'l1', itemId: MENU.tea, qty: 2, optionIds: [], note: ' เย็นมาก ' }],
      'storefront',
    );
    expect(snap.lines).toEqual([
      {
        name: { th: 'ชาเย็น', en: 'Thai iced tea' },
        options: [],
        qty: 2,
        note: 'เย็นมาก',
        lineTotalSatang: 5000,
      },
    ]);
    expect(snap.estimateSatang).toBe(5000);
  });

  test('has no estimate when a line cannot be priced', () => {
    const entities = createEntityStore();
    seedMenu(entities);
    const snap = snapshotOrder(
      entities.getState(),
      [{ key: 'l1', itemId: MENU.seafood, qty: 1, optionIds: [], note: '' }],
      'storefront',
    );
    expect(snap.estimateSatang).toBeNull();
  });
});
