import type { OrderDto, PaymentResult } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NewOrderInput } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createStore } from '../lib/store.ts';
import {
  createMemoryLocalStore,
  type LocalStore,
  type OutboxEntry,
} from '../platform/localStore.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { FAKE_SESSION_TOKEN } from '../test-support/fixtures.ts';
import { orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { MAX_QUEUE, STUCK_AFTER } from './outbox-model.ts';
import { createOutboxStore, type OutboxDeps } from './outbox-store.ts';

const ME = uuid(1);
const OTHER = uuid(2);
const DEVICE = uuid(3);

const body: NewOrderInput = {
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Fah ตัวอย่าง',
  items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
};
const lines = [
  {
    name: { th: 'ชาเย็น', en: 'Thai iced tea' },
    options: [],
    qty: 1,
    note: '',
    lineTotalSatang: 2500,
  },
];

const network = () => new ApiClientError('NETWORK');
const refused = (code: string, status = 422) => new ApiClientError(code, { status });

type CreateOrder = OutboxDeps['api']['orders']['create'];
type CreatePayment = OutboxDeps['api']['payments']['create'];

const placed = (id: string, rev = 10, over: Partial<OrderDto> = {}) =>
  orderDto(id, rev, { orderNo: 'S-001', totalSatang: 2500 as never, ...over });

const okOrder =
  (orderId = uuid(100)): CreateOrder =>
  async (_input, options) => ({
    order: placed(orderId),
    replay: false,
    clientRequestId: options?.clientRequestId ?? '',
  });

const paidResult = (orderId: string): PaymentResult => ({
  payment: paymentDto(uuid(200), orderId, 11, { method: 'cash', status: 'confirmed' }),
  order: placed(orderId, 12, { paymentStatus: 'paid' }),
});

const okPayment: CreatePayment = async (orderId, _input, options) => ({
  result: paidResult(orderId),
  replay: false,
  clientRequestId: options?.clientRequestId ?? '',
});

/** A store whose rows survive a "reload": the same object is opened again. */
function persistentStore(): LocalStore {
  return { ...createMemoryLocalStore(), persistent: true };
}

function setup(
  options: {
    store?: LocalStore;
    create?: CreateOrder;
    pay?: CreatePayment;
    staff?: string | null;
    online?: boolean;
  } = {},
) {
  const store = options.store ?? persistentStore();
  const entities = createEntityStore();
  const life = createFakeLifecycle({ online: options.online ?? true });
  const auth = createStore<{
    phase: 'booting' | 'unregistered' | 'locked' | 'signedIn';
    session: { staff: { id: string } } | null;
    device: { id: string } | null;
  }>({
    phase: options.staff === null ? 'locked' : 'signedIn',
    session: options.staff === null ? null : { staff: { id: options.staff ?? ME } },
    device: { id: DEVICE },
  });
  const connection = createStore<{
    status: 'idle' | 'online' | 'connecting' | 'reconnecting' | 'offline';
  }>({
    status: 'online',
  });
  const create = vi.fn<CreateOrder>(options.create ?? okOrder());
  const pay = vi.fn<CreatePayment>(options.pay ?? okPayment);
  const outbox = createOutboxStore({
    api: { orders: { create }, payments: { create: pay } },
    entities,
    auth,
    lifecycle: life.lifecycle,
    connection,
    localStore: async () => store,
    now: () => Date.now(),
    random: () => 0.5,
  });
  const unbind = outbox.bind();
  const signInAs = (staff: string | null) =>
    auth.setState(
      staff === null
        ? { phase: 'locked', session: null }
        : { phase: 'signedIn', session: { staff: { id: staff } } },
    );
  return { outbox, store, entities, life, auth, connection, create, pay, unbind, signInAs };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
};

async function queueOrder(
  outbox: ReturnType<typeof setup>['outbox'],
  id: string,
  over: Partial<NewOrderInput> = {},
) {
  return outbox.enqueueOrder({
    clientRequestId: id,
    body: { ...body, ...over },
    lines,
    estimateSatang: 2500,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('saving an order to the outbox', () => {
  test('writes the entry before it says so, with the owner, the provisional label and the exact body', async () => {
    const { outbox, store } = setup({ online: false });
    await settle();
    const result = await queueOrder(outbox, uuid(10));
    expect(result).toMatchObject({ ok: true, id: uuid(10) });
    const [row] = await store.outbox.list();
    expect(row).toMatchObject({
      id: uuid(10),
      kind: 'order.create',
      staffId: ME,
      deviceId: DEVICE,
      state: 'queued',
    });
    expect((row?.payload as { body: unknown } | undefined)?.body).toEqual(body);
    expect(outbox.getState().items).toHaveLength(1);
    expect(outbox.getState().items[0]).toMatchObject({ kind: 'order', state: 'queued' });
  });

  test('the provisional label counts up on this device and keeps counting after a reload', async () => {
    const store = persistentStore();
    const first = setup({ store, online: false });
    await settle();
    const a = await queueOrder(first.outbox, uuid(10));
    const b = await queueOrder(first.outbox, uuid(11));
    first.unbind();
    const second = setup({ store, online: false });
    await settle();
    const c = await queueOrder(second.outbox, uuid(12));
    const labels = [a, b, c].map((r) => (r.ok ? r.label : ''));
    expect(labels.map((l) => l.slice(-2))).toEqual(['01', '02', '03']);
    expect(new Set(labels.map((l) => l.slice(0, 2))).size).toBe(1);
  });

  test('a store that is not persistent (private mode) refuses: nothing is pretended', async () => {
    const { outbox } = setup({ store: createMemoryLocalStore(), online: false });
    await settle();
    expect(await queueOrder(outbox, uuid(10))).toEqual({ ok: false, reason: 'storage' });
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('a write that fails (quota) refuses and leaves nothing in the queue', async () => {
    const store = persistentStore();
    store.outbox.put = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const { outbox } = setup({ store, online: false });
    await settle();
    expect(await queueOrder(outbox, uuid(10))).toEqual({ ok: false, reason: 'storage' });
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('a full queue refuses', async () => {
    const { outbox } = setup({ online: false });
    await settle();
    for (let i = 0; i < MAX_QUEUE; i += 1) {
      expect((await queueOrder(outbox, uuid(1000 + i))).ok).toBe(true);
    }
    expect(await queueOrder(outbox, uuid(5000))).toEqual({ ok: false, reason: 'full' });
  });

  test('without a signed-in person nothing is saved', async () => {
    const { outbox } = setup({ staff: null });
    await settle();
    expect(await queueOrder(outbox, uuid(10))).toEqual({ ok: false, reason: 'noSession' });
  });

  test('saving the same request id twice keeps one entry', async () => {
    const { outbox, store } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    await queueOrder(outbox, uuid(10));
    expect(await store.outbox.count()).toBe(1);
  });

  test('keeps no token in the stored row', async () => {
    const { outbox, store } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    expect(JSON.stringify(await store.outbox.list())).not.toContain(FAKE_SESSION_TOKEN);
  });
});

describe('replaying an order', () => {
  test('sends the same request id and body, shows the server order and removes the entry', async () => {
    const { outbox, store, create, entities } = setup({ create: okOrder(uuid(100)) });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(body, { clientRequestId: uuid(10) });
    expect(entities.getState().orders.get(uuid(100))?.orderNo).toBe('S-001');
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
    expect(outbox.getState().synced[uuid(10)]).toBe(uuid(100));
  });

  test('a lost connection keeps it, and the retries send the very same id and body', async () => {
    let calls = 0;
    const { outbox, store, create } = setup({
      create: async (input, options) => {
        calls += 1;
        if (calls < 3) throw network();
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(outbox.getState().items[0]).toMatchObject({ state: 'queued', attempts: 1 });
    expect(await store.outbox.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(create).toHaveBeenCalledTimes(3);
    for (const call of create.mock.calls) {
      expect(call).toEqual([body, { clientRequestId: uuid(10) }]);
    }
    expect(await store.outbox.count()).toBe(0);
  });

  test('backs off between tries instead of hammering', async () => {
    const { outbox, create } = setup({
      create: async () => {
        throw network();
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('while the device is offline it does not even try, and `online` replays at once', async () => {
    const { outbox, create, life } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(create).not.toHaveBeenCalled();
    life.goOnline();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('coming back to the front does not skip an entry’s backoff, but `online` does', async () => {
    let fail = true;
    const { outbox, create, life } = setup({
      create: async (input, options) => {
        if (fail) throw network();
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    fail = false;
    life.show();
    await settle();
    expect(create).toHaveBeenCalledTimes(1); // still waiting out its backoff
    life.goOnline();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('saving another order does not make the others skip their backoff', async () => {
    const fail = true;
    const { outbox, create } = setup({
      create: async (input, options) => {
        if (fail && options?.clientRequestId === uuid(10)) throw network();
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    await queueOrder(outbox, uuid(11));
    await settle();
    // The new order went; the one in backoff did not.
    expect(create.mock.calls.map((c) => c[1]?.clientRequestId)).toEqual([uuid(10), uuid(11)]);
  });

  test('"send now" is a person asking: it tries again at once', async () => {
    let fail = true;
    const { outbox, create } = setup({
      create: async (input, options) => {
        if (fail) throw network();
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    fail = false;
    outbox.kick();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('sends the entries oldest first, one at a time', async () => {
    const releases: (() => void)[] = [];
    const sent: string[] = [];
    const { outbox, life } = setup({
      create: (_input, options) =>
        new Promise((resolve) => {
          const id = options?.clientRequestId ?? '';
          sent.push(id);
          releases.push(() =>
            resolve({ order: placed(uuid(100 + sent.length)), replay: false, clientRequestId: id }),
          );
        }),
      online: false,
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await vi.advanceTimersByTimeAsync(5);
    await queueOrder(outbox, uuid(11));
    await vi.advanceTimersByTimeAsync(5);
    await queueOrder(outbox, uuid(12));
    life.goOnline();
    await settle();
    expect(sent).toEqual([uuid(10)]);
    releases[0]?.();
    await settle();
    expect(sent).toEqual([uuid(10), uuid(11)]);
    releases[1]?.();
    await settle();
    expect(sent).toEqual([uuid(10), uuid(11), uuid(12)]);
  });

  test('an answer of 200 (a replay of an order the server already has) is the same as a success', async () => {
    const { outbox, store, entities } = setup({
      create: async (_i, options) => ({
        order: placed(uuid(100)),
        replay: true,
        clientRequestId: options?.clientRequestId ?? '',
      }),
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(entities.getState().orders.size).toBe(1);
    expect(await store.outbox.count()).toBe(0);
  });
});

describe('an entry the server refuses', () => {
  test('409 IDEMPOTENCY_KEY_REUSED stops that entry, keeps it visible, offers discard only', async () => {
    const { outbox, store, create } = setup({
      create: async () => {
        throw refused('IDEMPOTENCY_KEY_REUSED', 409);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(outbox.getState().items[0]).toMatchObject({
      state: 'attention',
      error: 'IDEMPOTENCY_KEY_REUSED',
      canRetry: false,
    });
    expect(await store.outbox.count()).toBe(1);
    expect((await store.outbox.list())[0]).toMatchObject({
      state: 'attention',
      lastError: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  test('a refusal does not hold back the entries after it', async () => {
    let n = 0;
    const { outbox, create, store } = setup({
      create: async (input, options) => {
        n += 1;
        if (n === 1) throw refused('ORDER_INVALID');
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await queueOrder(outbox, uuid(11));
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(outbox.getState().items.map((i) => [i.id, i.state])).toEqual([[uuid(10), 'attention']]);
    expect(await store.outbox.count()).toBe(1);
  });

  test('retry sends it again under the same id; discard removes it', async () => {
    let refuse = true;
    const { outbox, store, create } = setup({
      create: async (input, options) => {
        if (refuse) throw refused('ORDER_INVALID');
        return okOrder()(input, options);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(outbox.getState().items[0]).toMatchObject({ state: 'attention', canRetry: true });
    refuse = false;
    await outbox.retry(uuid(10));
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual([body, { clientRequestId: uuid(10) }]);
    expect(await store.outbox.count()).toBe(0);
  });

  test('discard removes a refused entry for good', async () => {
    const { outbox, store } = setup({
      create: async () => {
        throw refused('ORDER_INVALID');
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    await outbox.discard(uuid(10));
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('only an entry that needs attention can be discarded', async () => {
    const { outbox, store } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.discard(uuid(10));
    expect(await store.outbox.count()).toBe(1);
  });
});

describe('a 429 from the server', () => {
  const limited = (seconds: number | null) =>
    new ApiClientError('RATE_LIMITED', { status: 429, retryAfterSeconds: seconds });

  test('is waited out for as long as the server says, for the whole queue, even after `online`', async () => {
    let limit = true;
    const { outbox, create, life } = setup({
      create: async (input, options) => {
        if (limit) throw limited(20);
        return okOrder()(input, options);
      },
      online: false,
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await queueOrder(outbox, uuid(11));
    life.goOnline();
    await settle();
    expect(create).toHaveBeenCalledTimes(1); // the pass ended: the second would be limited too
    limit = false;
    await vi.advanceTimersByTimeAsync(10_000);
    life.goOnline();
    life.show();
    outbox.kick();
    await settle();
    expect(create).toHaveBeenCalledTimes(1); // 10 s of the 20 s have passed
    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(create.mock.calls.length).toBe(3); // the first again, then the second
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('without a wait time the usual backoff applies and the entry is not refused', async () => {
    const { outbox, create } = setup({
      create: async () => {
        throw limited(null);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(outbox.getState().items[0]).toMatchObject({ state: 'queued', attempts: 1 });
  });
});

describe('an entry that is stuck', () => {
  test('can be removed after many tries, though the server never refused it', async () => {
    const { outbox, store } = setup({
      create: async () => {
        throw new ApiClientError('INTERNAL', { status: 500 });
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.enqueueCash({
      target: { entryId: uuid(10) },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: 'XK-01',
    });
    await outbox.discard(uuid(10)); // not stuck yet: refused
    expect(await store.outbox.count()).toBe(2);
    for (let i = 0; i < STUCK_AFTER + 1; i += 1) await vi.advanceTimersByTimeAsync(70_000);
    expect(outbox.getState().items[0]).toMatchObject({ state: 'queued', stuck: true });
    await outbox.discard(uuid(10));
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
  });
});

describe('a server fault or a lost session', () => {
  test('a 5xx is retried and shown as stuck after many tries, never refused', async () => {
    const { outbox } = setup({
      create: async () => {
        throw new ApiClientError('INTERNAL', { status: 500 });
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    for (let i = 0; i < STUCK_AFTER + 1; i += 1) await vi.advanceTimersByTimeAsync(70_000);
    expect(outbox.getState().items[0]).toMatchObject({ state: 'queued', stuck: true });
  });

  test('an expired session pauses the queue and keeps the entry untouched', async () => {
    const { outbox, store, create } = setup({
      create: async () => {
        throw refused('UNAUTHENTICATED', 401);
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect(outbox.getState().items[0]).toMatchObject({ state: 'queued' });
    expect((await store.outbox.list())[0]?.state).toBe('queued');
    expect(create.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('cash on a queued order', () => {
  test('waits for its order, then goes to the server order under its own request id', async () => {
    const { outbox, store, pay, create, life } = setup({
      create: okOrder(uuid(100)),
      online: false,
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    const queuedPay = await outbox.enqueueCash({
      target: { entryId: uuid(10) },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: 'XK-01',
    });
    expect(queuedPay.ok).toBe(true);
    expect(outbox.getState().items.map((i) => i.kind)).toEqual(['order', 'payment']);
    expect(pay).not.toHaveBeenCalled();
    life.goOnline();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledTimes(1);
    const [orderId, input, options] = pay.mock.calls[0] ?? [];
    expect(orderId).toBe(uuid(100));
    expect(input).toEqual({ method: 'cash', tendered: 10000 });
    expect(options?.clientRequestId).toBe(queuedPay.ok ? queuedPay.id : '');
    expect(options?.clientRequestId).not.toBe(uuid(10));
    expect(await store.outbox.count()).toBe(0);
  });

  test('a cash payment on an order the server already has is queued with the order id', async () => {
    const { outbox, store, pay, life } = setup({ online: false });
    await settle();
    const result = await outbox.enqueueCash({
      target: { orderId: uuid(100) },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: 'S-001',
    });
    expect(result.ok).toBe(true);
    expect((await store.outbox.list())[0]?.kind).toBe('payment.cash');
    life.goOnline();
    await settle();
    expect(pay).toHaveBeenCalledWith(
      uuid(100),
      { method: 'cash', tendered: 10000 },
      { clientRequestId: result.ok ? result.id : '' },
    );
  });

  test('the server may refuse it (tender below the real total): kept as needing attention', async () => {
    const { outbox, store } = setup({
      pay: async () => {
        throw refused('TENDERED_BELOW_TOTAL');
      },
    });
    await settle();
    await outbox.enqueueCash({
      target: { orderId: uuid(100) },
      tenderedSatang: 2500,
      totalSatang: 2500,
      label: 'S-001',
    });
    await settle();
    // A retry would send the same tender and be refused again: only discard and re-key online.
    expect(outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      state: 'attention',
      error: 'TENDERED_BELOW_TOTAL',
      canRetry: false,
    });
    expect((await store.outbox.list())[0]?.lastError).toBe('TENDERED_BELOW_TOTAL');
  });

  test('a refused order blocks its payment, and discarding the order discards the payment too', async () => {
    const { outbox, store, pay } = setup({
      create: async () => {
        throw refused('ORDER_INVALID');
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.enqueueCash({
      target: { entryId: uuid(10) },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: 'XK-01',
    });
    await settle();
    expect(outbox.getState().items.map((i) => i.state)).toEqual(['attention', 'blocked']);
    expect(pay).not.toHaveBeenCalled();
    await outbox.discard(uuid(10));
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('the payment is rewritten with the server order id before the order entry is removed', async () => {
    const store = persistentStore();
    const realRemove = store.outbox.remove;
    const seen: unknown[] = [];
    store.outbox.remove = async (id) => {
      seen.push(JSON.stringify(await store.outbox.list()));
      return realRemove(id);
    };
    const { outbox, life } = setup({ store, online: false, create: okOrder(uuid(100)) });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.enqueueCash({
      target: { entryId: uuid(10) },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: 'XK-01',
    });
    life.goOnline();
    await settle();
    expect(String(seen[0])).toContain(uuid(100));
  });
});

describe('whose entries they are', () => {
  test('another person sees only a count and their session never replays them', async () => {
    const { outbox, create, signInAs, life } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    signInAs(null);
    await settle();
    expect(outbox.getState().items).toHaveLength(0);
    signInAs(OTHER);
    await settle();
    expect(outbox.getState().items).toHaveLength(0);
    expect(outbox.getState().othersCount).toBe(1);
    life.goOnline();
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  test('signing out keeps the rows; the same person signing in again gets them and they replay', async () => {
    const { outbox, store, create, signInAs, life } = setup({ online: false });
    await settle();
    await queueOrder(outbox, uuid(10));
    signInAs(null);
    await settle();
    expect(await store.outbox.count()).toBe(1);
    signInAs(ME);
    await settle();
    expect(outbox.getState().items).toHaveLength(1);
    life.goOnline();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('an answer that arrives after sign-out still clears its row but never touches the next person', async () => {
    let release: () => void = () => undefined;
    const { outbox, store, entities, signInAs } = setup({
      create: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ order: placed(uuid(100)), replay: false, clientRequestId: uuid(10) });
        }),
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    signInAs(null);
    await settle();
    release();
    await settle();
    expect(await store.outbox.count()).toBe(0);
    expect(entities.getState().orders.size).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
  });
});

describe('knowing that it is offline', () => {
  test('the device being offline, or the connection being down, says so', async () => {
    const { outbox, life, connection } = setup();
    await settle();
    expect(outbox.isOffline()).toBe(false);
    life.goOffline();
    expect(outbox.isOffline()).toBe(true);
    life.goOnline();
    expect(outbox.isOffline()).toBe(false);
    connection.setState({ status: 'reconnecting' });
    expect(outbox.isOffline()).toBe(true);
    connection.setState({ status: 'online' });
    expect(outbox.getState().offline).toBe(false);
  });
});

describe('entries that never sync', () => {
  const DAY = 86_400_000;
  const row = (id: string, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id,
    kind: 'order.create',
    payload: { body, label: 'XK-01', lines, estimateSatang: 2500 },
    createdAt: Date.now(),
    attempts: 0,
    state: 'queued',
    staffId: OTHER,
    deviceId: DEVICE,
    ...over,
  });
  const cashRow = (id: string, entryId: string, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id,
    kind: 'payment.cash',
    payload: { target: { entryId }, tenderedSatang: 10000, label: 'XK-01', totalSatang: 2500 },
    createdAt: Date.now(),
    attempts: 0,
    state: 'queued',
    staffId: OTHER,
    deviceId: DEVICE,
    ...over,
  });

  test("on sign-in, other people's entries older than 14 days are purged, with only a count", async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { createdAt: Date.now() - 15 * DAY }));
    await store.outbox.put(row(uuid(11), { createdAt: Date.now() - 13 * DAY }));
    const { outbox } = setup({ store, online: false });
    await settle();
    expect((await store.outbox.list()).map((r) => r.id)).toEqual([uuid(11)]);
    expect(outbox.getState().purgedCount).toBe(1);
    expect(outbox.getState().othersCount).toBe(1);
  });

  test('the signed-in person’s own entries are never purged, however old', async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { staffId: ME, createdAt: Date.now() - 40 * DAY }));
    const { outbox } = setup({ store, online: false });
    await settle();
    expect(await store.outbox.count()).toBe(1);
    expect(outbox.getState().purgedCount).toBe(0);
    expect(outbox.getState().items).toHaveLength(1);
  });

  test('the same person on an old device id counts as someone else and is purged when old', async () => {
    const store = persistentStore();
    await store.outbox.put(
      row(uuid(10), { staffId: ME, deviceId: uuid(99), createdAt: Date.now() - 20 * DAY }),
    );
    const { outbox } = setup({ store, online: false });
    await settle();
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().purgedCount).toBe(1);
  });

  test('the cash that waits for a purged order goes with it', async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { createdAt: Date.now() - 20 * DAY }));
    await store.outbox.put(cashRow(uuid(11), uuid(10), { createdAt: Date.now() - 2 * DAY }));
    const { outbox } = setup({ store, online: false });
    await settle();
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().purgedCount).toBe(2);
  });

  test('with nobody signed in nothing is purged (whose entries are they?)', async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { staffId: ME, createdAt: Date.now() - 40 * DAY }));
    setup({ store, staff: null, online: false });
    await settle();
    expect(await store.outbox.count()).toBe(1);
  });

  test('signing in as someone else later purges the old rows then', async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { staffId: ME, createdAt: Date.now() - 40 * DAY }));
    const { signInAs, outbox } = setup({ store, staff: null, online: false });
    await settle();
    signInAs(OTHER);
    await settle();
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().purgedCount).toBe(1);
  });

  test('a row that cannot be removed stays and is not counted as purged', async () => {
    const store = persistentStore();
    await store.outbox.put(row(uuid(10), { createdAt: Date.now() - 20 * DAY }));
    store.outbox.remove = async () => {
      throw new Error('blocked');
    };
    const { outbox } = setup({ store, online: false });
    await settle();
    expect(await store.outbox.count()).toBe(1);
    expect(outbox.getState().purgedCount).toBe(0);
    expect(outbox.getState().othersCount).toBe(1);
  });
});

describe('a second cash tender for the same order', () => {
  const cash = (tendered: number) => ({
    target: { orderId: uuid(100) },
    tenderedSatang: tendered,
    totalSatang: 2500,
    label: 'S-001',
  });

  test('replaces the waiting tender while it has not been sent, and says so', async () => {
    const { outbox, store, pay, life } = setup({ online: false });
    await settle();
    const first = await outbox.enqueueCash(cash(10000));
    const second = await outbox.enqueueCash(cash(20000));
    expect(second).toMatchObject({ ok: true, replaced: true });
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
    expect(await store.outbox.count()).toBe(1);
    expect(outbox.getState().items[0]).toMatchObject({
      tenderedSatang: 20000,
      tenderChanged: true,
    });
    life.goOnline();
    await settle();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls[0]?.[1]).toEqual({ method: 'cash', tendered: 20000 });
  });

  test('the same tender again is the same entry and changes nothing', async () => {
    const { outbox } = setup({ online: false });
    await settle();
    await outbox.enqueueCash(cash(10000));
    const again = await outbox.enqueueCash(cash(10000));
    expect(again).toMatchObject({ ok: true });
    expect('replaced' in again).toBe(false);
    expect(outbox.getState().items[0]).toMatchObject({ tenderChanged: false });
  });

  test('the new tender is on the device before it is acknowledged; a failed write changes nothing', async () => {
    const store = persistentStore();
    const { outbox } = setup({ store, online: false });
    await settle();
    await outbox.enqueueCash(cash(10000));
    const realPut = store.outbox.put.bind(store.outbox);
    store.outbox.put = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    expect(await outbox.enqueueCash(cash(20000))).toEqual({ ok: false, reason: 'storage' });
    expect(outbox.getState().items[0]).toMatchObject({ tenderedSatang: 10000 });
    store.outbox.put = realPut;
    expect((await store.outbox.list())[0]?.payload).toMatchObject({ tenderedSatang: 10000 });
  });

  test('marks the entry as sent on the device BEFORE the request leaves', async () => {
    const store = persistentStore();
    let markedWhenSent: unknown;
    const { outbox, life } = setup({
      store,
      online: false,
      pay: async (orderId, input, options) => {
        markedWhenSent = (await store.outbox.list())[0]?.sentAt;
        return okPayment(orderId, input, options);
      },
    });
    await settle();
    await outbox.enqueueCash(cash(10000));
    life.goOnline();
    await settle();
    expect(typeof markedWhenSent).toBe('number');
  });

  test('once a send was tried (no answer), a different tender is refused: the first may have landed', async () => {
    const { outbox, pay, life } = setup({
      online: false,
      pay: async () => {
        throw network();
      },
    });
    await settle();
    await outbox.enqueueCash(cash(10000));
    life.goOnline();
    await settle();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await outbox.enqueueCash(cash(20000))).toEqual({ ok: false, reason: 'busy' });
    expect(outbox.getState().items[0]).toMatchObject({ tenderedSatang: 10000 });
    // The same tender is still just the same entry.
    expect((await outbox.enqueueCash(cash(10000))).ok).toBe(true);
  });

  test('while the request is on its way, a different tender is refused and the sent one stands', async () => {
    let release: () => void = () => undefined;
    const { outbox, store, pay } = setup({
      pay: (orderId, _input, options) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              result: paidResult(orderId),
              replay: false,
              clientRequestId: options?.clientRequestId ?? '',
            });
        }),
    });
    await settle();
    await outbox.enqueueCash(cash(10000));
    await settle();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await outbox.enqueueCash(cash(20000))).toEqual({ ok: false, reason: 'busy' });
    release();
    await settle();
    expect(await store.outbox.count()).toBe(0);
    expect(pay.mock.calls[0]?.[1]).toEqual({ method: 'cash', tendered: 10000 });
  });

  test('a refused entry cannot be edited either (send again or remove it)', async () => {
    const { outbox } = setup({
      pay: async () => {
        throw refused('PAYMENT_NOT_ALLOWED');
      },
    });
    await settle();
    await outbox.enqueueCash(cash(10000));
    await settle();
    expect(await outbox.enqueueCash(cash(20000))).toEqual({ ok: false, reason: 'busy' });
  });
});

describe('a payment never loses its order (the order syncs while cash is being saved)', () => {
  const cashFor = (entryId: string, tendered = 10000) => ({
    target: { entryId },
    tenderedSatang: tendered,
    totalSatang: 2500,
    label: 'XK-01',
  });

  /** A gate: while armed, the next `list` waits for `release()`. */
  function gatedList(store: LocalStore) {
    const realList = store.outbox.list.bind(store.outbox);
    let release: (() => void) | null = null;
    let armed = false;
    store.outbox.list = async () => {
      if (armed) {
        armed = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realList();
    };
    return {
      arm: () => {
        armed = true;
      },
      release: () => release?.(),
    };
  }

  test('cash asked for while the order is being linked goes to the server order, once', async () => {
    const store = persistentStore();
    const gate = gatedList(store);
    const { outbox, pay, life } = setup({ store, online: false, create: okOrder(uuid(100)) });
    await settle();
    await queueOrder(outbox, uuid(10));
    gate.arm();
    life.goOnline();
    await settle(); // the order was created; its bookkeeping waits on the gated list
    const late = outbox.enqueueCash(cashFor(uuid(10)));
    await settle();
    gate.release();
    const result = await late;
    await settle();
    expect(result.ok).toBe(true);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls[0]?.[0]).toBe(uuid(100));
    expect(await store.outbox.count()).toBe(0);
  });

  test('cash saved while the order is on its way is linked by the order sync', async () => {
    let release: () => void = () => undefined;
    const { outbox, pay, store } = setup({
      create: (_input, options) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              order: placed(uuid(100)),
              replay: false,
              clientRequestId: options?.clientRequestId ?? '',
            });
        }),
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await settle();
    expect((await outbox.enqueueCash(cashFor(uuid(10)))).ok).toBe(true);
    release();
    await settle();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls[0]?.[0]).toBe(uuid(100));
    expect(await store.outbox.count()).toBe(0);
  });

  test('cash for an order entry that is gone and was never synced here is refused', async () => {
    const { outbox, store } = setup({ online: false });
    await settle();
    expect(await outbox.enqueueCash(cashFor(uuid(10)))).toEqual({
      ok: false,
      reason: 'orderGone',
    });
    expect(await store.outbox.count()).toBe(0);
  });

  test('asking again for an order that synced meanwhile does not make a second cash entry', async () => {
    const { outbox, store, life } = setup({
      online: false,
      create: okOrder(uuid(100)),
      pay: async () => {
        throw network();
      },
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    const first = await outbox.enqueueCash(cashFor(uuid(10)));
    life.goOnline();
    await settle();
    // The order is on the server and its cash still waits (now pointed at the server order).
    // A late second tap with the old order entry id finds that cash instead of making another.
    const second = await outbox.enqueueCash(cashFor(uuid(10)));
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
    expect(await store.outbox.count()).toBe(1);
  });

  test('a failed read keeps the order entry (nothing is removed) and the retry links the payment', async () => {
    const store = persistentStore();
    const { outbox, pay, create, life } = setup({
      store,
      online: false,
      create: okOrder(uuid(100)),
    });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.enqueueCash(cashFor(uuid(10)));
    const realList = store.outbox.list.bind(store.outbox);
    let fail = true;
    store.outbox.list = async () => {
      if (fail) throw new Error('read failed');
      return realList();
    };
    life.goOnline();
    await settle();
    expect(await store.outbox.count()).toBe(2); // order and cash still there
    expect(pay).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1); // backs off: no hot loop
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(create).toHaveBeenCalledTimes(2); // an idempotent replay of the same order
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls[0]?.[0]).toBe(uuid(100));
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
  });

  test('a failed rewrite of the payment keeps the order entry, and nothing shows as missing', async () => {
    const store = persistentStore();
    const { outbox, pay, life } = setup({ store, online: false, create: okOrder(uuid(100)) });
    await settle();
    await queueOrder(outbox, uuid(10));
    await outbox.enqueueCash(cashFor(uuid(10)));
    const realPut = store.outbox.put.bind(store.outbox);
    let fail = true;
    store.outbox.put = async (entry) => {
      if (fail && entry.kind === 'payment.cash') {
        throw new DOMException('full', 'QuotaExceededError');
      }
      return realPut(entry);
    };
    life.goOnline();
    await settle();
    expect(await store.outbox.count()).toBe(2);
    expect(outbox.getState().items.map((i) => i.state)).toEqual(['queued', 'queued']);
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await store.outbox.count()).toBe(0);
  });
});
