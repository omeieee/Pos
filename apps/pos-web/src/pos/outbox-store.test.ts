import type { OrderDto, PaymentResult } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NewOrderInput } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createStore } from '../lib/store.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
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

  test('coming back to the front replays an entry that is waiting for its backoff', async () => {
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
    expect(create).toHaveBeenCalledTimes(2);
    expect(outbox.getState().items).toHaveLength(0);
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
    expect(outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      state: 'attention',
      error: 'TENDERED_BELOW_TOTAL',
      canRetry: true,
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
