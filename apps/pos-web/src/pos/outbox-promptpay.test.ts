import type { OrderDto, PaymentResult } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NewOrderInput } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createStore } from '../lib/store.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { MAX_QUEUE } from './outbox-model.ts';
import { createOutboxStore, type NewQueuedPromptpay, type OutboxDeps } from './outbox-store.ts';

const ME = uuid(1);
const DEVICE = uuid(3);
const SERVER_ORDER = uuid(100);
const PAYMENT = uuid(200);
/** Made-up number: it must never appear in a stored row. */
const ID = '0812345678';
const MASKED = '******5678';

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

type CreateOrder = OutboxDeps['api']['orders']['create'];
type CreatePayment = OutboxDeps['api']['payments']['create'];
type Confirm = OutboxDeps['api']['payments']['confirm'];

const placed = (id: string, rev = 10, over: Partial<OrderDto> = {}) =>
  orderDto(id, rev, { orderNo: 'S-001', totalSatang: 2500 as never, ...over });

const pending = (orderId: string, over = {}) =>
  paymentDto(PAYMENT, orderId, 11, {
    method: 'promptpay',
    status: 'pending',
    amountSatang: 2500 as never,
    promptpayTargetMasked: MASKED,
    ...over,
  });

const okOrder: CreateOrder = async (_input, options) => ({
  order: placed(SERVER_ORDER),
  replay: false,
  clientRequestId: options?.clientRequestId ?? '',
});

const okCreate =
  (over = {}): CreatePayment =>
  async (orderId, _input, options) => ({
    result: { payment: pending(orderId, over), order: placed(orderId, 12) } satisfies PaymentResult,
    replay: false,
    clientRequestId: options?.clientRequestId ?? '',
  });

const okConfirm: Confirm = async (paymentId) => ({
  payment: pending(SERVER_ORDER, { id: paymentId, status: 'confirmed', rev: 13 }),
  order: placed(SERVER_ORDER, 14, { paymentStatus: 'paid' }),
});

const refused = (code: string, status = 409) => new ApiClientError(code, { status });
const network = () => new ApiClientError('NETWORK');

const persistentStore = (): LocalStore => ({ ...createMemoryLocalStore(), persistent: true });

function setup(
  options: {
    store?: LocalStore;
    online?: boolean;
    createOrder?: CreateOrder;
    createPayment?: CreatePayment;
    confirm?: Confirm;
  } = {},
) {
  const store = options.store ?? persistentStore();
  const entities = createEntityStore();
  const life = createFakeLifecycle({ online: options.online ?? true });
  const auth = createStore({
    phase: 'signedIn' as const,
    session: { staff: { id: ME } },
    device: { id: DEVICE },
  });
  const connection = createStore({ status: 'online' as const });
  const createOrder = vi.fn<CreateOrder>(options.createOrder ?? okOrder);
  const createPayment = vi.fn<CreatePayment>(options.createPayment ?? okCreate());
  const confirm = vi.fn<Confirm>(options.confirm ?? okConfirm);
  const outbox = createOutboxStore({
    api: {
      orders: { create: createOrder },
      payments: { create: createPayment, confirm },
      devices: {
        outboxRecovery: async () => {
          throw new Error('outbox recovery was not expected');
        },
      },
    },
    entities,
    auth,
    lifecycle: life.lifecycle,
    connection,
    localStore: async () => store,
    now: () => Date.now(),
    random: () => 0.5,
  });
  const unbind = outbox.bind();
  return { outbox, store, entities, life, createOrder, createPayment, confirm, unbind };
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const queueOrder = (outbox: ReturnType<typeof setup>['outbox'], id: string) =>
  outbox.enqueueOrder({
    clientRequestId: id,
    body,
    lines,
    estimateSatang: 2500,
  });

const pp = (over: Partial<NewQueuedPromptpay> = {}): NewQueuedPromptpay => ({
  target: { entryId: uuid(10) },
  qrAmountSatang: 2500,
  amountKind: 'estimate',
  qrTargetMasked: MASKED,
  label: 'XA-01',
  ...over,
});

/** An offline device with an order entry (uuid 10) and the PromptPay payment saved behind it. */
async function offlineWithPromptpay(over: Parameters<typeof setup>[0] = {}) {
  const made = setup({ online: false, ...over });
  await settle();
  await queueOrder(made.outbox, uuid(10));
  const saved = await made.outbox.enqueuePromptpay(pp());
  return { ...made, saved };
}

describe('saving an offline PromptPay payment', () => {
  test('writes the create and the confirm behind the order, sends nothing, and shows ONE waiting item', async () => {
    const { outbox, store, saved, createOrder, createPayment, confirm } =
      await offlineWithPromptpay();
    expect(saved).toMatchObject({ ok: true });
    const rows = await store.outbox.list();
    expect(rows.map((r) => r.kind).sort()).toEqual([
      'order.create',
      'payment.promptpay.confirm',
      'payment.promptpay.create',
    ]);
    for (const row of rows)
      expect(row).toMatchObject({ staffId: ME, deviceId: DEVICE, state: 'queued' });
    const item = outbox.getState().items.find((i) => i.kind === 'payment');
    expect(item).toMatchObject({
      kind: 'payment',
      method: 'promptpay',
      state: 'queued',
      dependsOn: uuid(10),
      qrAmountSatang: 2500,
      amountKind: 'estimate',
      confirmOnly: false,
    });
    expect(outbox.getState().items.filter((i) => i.kind === 'payment')).toHaveLength(1);
    expect(createOrder).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  test('the stored rows hold the masked account and the amount, never the ID or the QR payload', async () => {
    const { store } = await offlineWithPromptpay();
    const text = JSON.stringify(await store.outbox.list());
    expect(text).toContain(MASKED);
    expect(text).not.toContain(ID);
    // The masked form is the only place any digit of the account appears.
    expect(text.replaceAll(MASKED, '')).not.toContain('5678');
    expect(text).not.toContain('000201');
    expect(text).not.toContain('A000000677010111');
  });

  test('asking again for the same order is the same entry; cash for it, or the other way round, is refused', async () => {
    const { outbox, store } = await offlineWithPromptpay();
    const again = await outbox.enqueuePromptpay(pp());
    expect(again).toMatchObject({ ok: true });
    expect(await store.outbox.count()).toBe(3);
    expect(
      await outbox.enqueueCash({
        target: { entryId: uuid(10) },
        tenderedSatang: 5000,
        totalSatang: 2500,
        label: 'XA-01',
      }),
    ).toEqual({ ok: false, reason: 'busy' });

    const other = setup({ online: false });
    await settle();
    await queueOrder(other.outbox, uuid(10));
    await other.outbox.enqueueCash({
      target: { entryId: uuid(10) },
      tenderedSatang: 5000,
      totalSatang: 2500,
      label: 'XA-01',
    });
    expect(await other.outbox.enqueuePromptpay(pp())).toEqual({ ok: false, reason: 'busy' });
  });

  test('both entries need a place: one free slot is not enough', async () => {
    const made = setup({ online: false });
    await settle();
    for (let i = 0; i < MAX_QUEUE - 2; i += 1) await queueOrder(made.outbox, uuid(1000 + i));
    await queueOrder(made.outbox, uuid(10));
    expect(await made.store.outbox.count()).toBe(MAX_QUEUE - 1);
    expect(await made.outbox.enqueuePromptpay(pp())).toEqual({ ok: false, reason: 'full' });
    expect(await made.store.outbox.count()).toBe(MAX_QUEUE - 1);
  });

  test('if the second write fails the first is removed: never a create without its confirm', async () => {
    const store = persistentStore();
    const made = setup({ store, online: false });
    await settle();
    await queueOrder(made.outbox, uuid(10));
    const realPut = store.outbox.put;
    let puts = 0;
    store.outbox.put = async (entry) => {
      puts += 1;
      if (puts === 2) throw new DOMException('full', 'QuotaExceededError');
      return realPut(entry);
    };
    expect(await made.outbox.enqueuePromptpay(pp())).toEqual({ ok: false, reason: 'storage' });
    expect((await store.outbox.list()).map((r) => r.kind)).toEqual(['order.create']);
  });

  test('refuses when the order entry is gone', async () => {
    const made = setup({ online: false });
    await settle();
    expect(await made.outbox.enqueuePromptpay(pp())).toEqual({ ok: false, reason: 'orderGone' });
  });
});

describe('replaying it', () => {
  test('after the order: the create (own request id), then the confirm, once each, and the entries go', async () => {
    const { outbox, store, life, createOrder, createPayment, confirm, entities } =
      await offlineWithPromptpay();
    const rows = await store.outbox.list();
    const createId = rows.find((r) => r.kind === 'payment.promptpay.create')?.id;
    life.goOnline();
    await settle();
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(createPayment).toHaveBeenCalledWith(
      SERVER_ORDER,
      { method: 'promptpay' },
      { clientRequestId: createId },
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(PAYMENT, {});
    // The order, then the payment, then its confirmation: in that order.
    expect(createOrder.mock.invocationCallOrder[0]).toBeLessThan(
      createPayment.mock.invocationCallOrder[0] ?? 0,
    );
    expect(createPayment.mock.invocationCallOrder[0]).toBeLessThan(
      confirm.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await store.outbox.count()).toBe(0);
    expect(outbox.getState().items).toHaveLength(0);
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('confirmed');
  });

  test('the confirm never carries an ID, a QR or an amount: only the payment id', async () => {
    const { life, confirm } = await offlineWithPromptpay();
    life.goOnline();
    await settle();
    expect(JSON.stringify(confirm.mock.calls)).not.toContain(ID);
    expect(confirm.mock.calls[0]).toEqual([PAYMENT, {}]);
  });

  test('an order the server already has: the create goes as soon as the device is back', async () => {
    const made = setup({ online: false });
    await settle();
    await made.outbox.enqueuePromptpay(
      pp({ target: { orderId: SERVER_ORDER }, amountKind: 'server' }),
    );
    expect(made.createPayment).not.toHaveBeenCalled();
    made.life.goOnline();
    await settle();
    expect(made.createPayment).toHaveBeenCalledWith(
      SERVER_ORDER,
      { method: 'promptpay' },
      { clientRequestId: expect.any(String) },
    );
    expect(made.confirm).toHaveBeenCalledTimes(1);
    expect(await made.store.outbox.count()).toBe(0);
  });

  test('a lost answer to the create sends the same request id again, and no confirm goes before it', async () => {
    let calls = 0;
    const made = await offlineWithPromptpay({
      createPayment: async (orderId, input, options) => {
        calls += 1;
        if (calls === 1) throw network();
        return okCreate()(orderId, input, options);
      },
    });
    made.life.goOnline();
    await settle();
    expect(made.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(made.createPayment).toHaveBeenCalledTimes(2);
    expect(made.createPayment.mock.calls[0]?.[2]).toEqual(made.createPayment.mock.calls[1]?.[2]);
    expect(made.confirm).toHaveBeenCalledTimes(1);
    expect(await made.store.outbox.count()).toBe(0);
  });

  test('a lost answer to the confirm: it is sent again, and the payment is not created twice', async () => {
    let calls = 0;
    const made = await offlineWithPromptpay({
      confirm: async (paymentId, input) => {
        calls += 1;
        if (calls === 1) throw network();
        return okConfirm(paymentId, input);
      },
    });
    made.life.goOnline();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(made.createPayment).toHaveBeenCalledTimes(1);
    expect(made.confirm).toHaveBeenCalledTimes(2);
    expect(await made.store.outbox.count()).toBe(0);
  });

  test('the server saying the payment is already confirmed (200) just clears the entry', async () => {
    const made = await offlineWithPromptpay({
      confirm: async (paymentId) => ({
        payment: pending(SERVER_ORDER, { id: paymentId, status: 'confirmed', rev: 20 }),
        order: placed(SERVER_ORDER, 21, { paymentStatus: 'paid' }),
      }),
    });
    made.life.goOnline();
    await settle();
    expect(await made.store.outbox.count()).toBe(0);
    expect(made.outbox.getState().items).toHaveLength(0);
  });

  test('a restart between the create and the confirm resumes at the confirm', async () => {
    const store = persistentStore();
    const first = await offlineWithPromptpay({
      store,
      confirm: async () => {
        throw network();
      },
    });
    first.life.goOnline();
    await settle();
    first.unbind();
    const rows = await store.outbox.list();
    expect(rows.map((r) => r.kind)).toEqual(['payment.promptpay.confirm']);
    const second = setup({ store });
    await settle();
    expect(second.createPayment).not.toHaveBeenCalled();
    expect(second.confirm).toHaveBeenCalledTimes(1);
    expect(await store.outbox.count()).toBe(0);
  });
});

describe('what the server may answer differently from the QR', () => {
  test('another amount than the QR: the payment is made but NOT confirmed; a person must reconcile', async () => {
    const made = await offlineWithPromptpay({
      createPayment: okCreate({ amountSatang: 2700 }),
    });
    made.life.goOnline();
    await settle();
    expect(made.createPayment).toHaveBeenCalledTimes(1);
    expect(made.confirm).not.toHaveBeenCalled();
    const item = made.outbox.getState().items[0];
    expect(item).toMatchObject({
      kind: 'payment',
      method: 'promptpay',
      state: 'attention',
      error: 'QR_AMOUNT_DIFFERS',
      canRetry: false,
      confirmOnly: true,
      qrAmountSatang: 2500,
      serverAmountSatang: 2700,
    });
    // The pending payment is on screen for the order page, still unconfirmed.
    expect(made.entities.getState().payments.get(PAYMENT)?.status).toBe('pending');
  });

  test('removing that entry leaves the pending payment on the server and sends nothing more', async () => {
    const made = await offlineWithPromptpay({ createPayment: okCreate({ amountSatang: 2700 }) });
    made.life.goOnline();
    await settle();
    const id = made.outbox.getState().items[0]?.id ?? '';
    await made.outbox.discard(id);
    expect(await made.store.outbox.count()).toBe(0);
    expect(made.confirm).not.toHaveBeenCalled();
  });

  test('the shop changed its PromptPay ID after the QR was drawn: not confirmed, with its own reason', async () => {
    const made = await offlineWithPromptpay({
      createPayment: okCreate({ promptpayTargetMasked: '******9999' }),
    });
    made.life.goOnline();
    await settle();
    expect(made.confirm).not.toHaveBeenCalled();
    expect(made.outbox.getState().items[0]).toMatchObject({
      state: 'attention',
      error: 'QR_ID_CHANGED',
      canRetry: false,
    });
  });

  test.each(['ORDER_ALREADY_PAID', 'PAYMENT_ALREADY_OPEN'])(
    'the create answered %s: it needs a person (the money may be there twice) and nothing is confirmed',
    async (code) => {
      const made = await offlineWithPromptpay({
        createPayment: async () => {
          throw refused(code);
        },
      });
      made.life.goOnline();
      await settle();
      expect(made.confirm).not.toHaveBeenCalled();
      const item = made.outbox.getState().items[0];
      expect(item).toMatchObject({ state: 'attention', error: code, canRetry: false });
      // Removing it removes the confirm that waited behind it too.
      await made.outbox.discard(item?.id ?? '');
      expect(await made.store.outbox.count()).toBe(0);
    },
  );

  test('a confirm the server refuses needs a person, and can be tried again', async () => {
    let calls = 0;
    const made = await offlineWithPromptpay({
      confirm: async (paymentId, input) => {
        calls += 1;
        if (calls === 1) throw refused('INVALID_TRANSITION');
        return okConfirm(paymentId, input);
      },
    });
    made.life.goOnline();
    await settle();
    const item = made.outbox.getState().items[0];
    expect(item).toMatchObject({ state: 'attention', error: 'INVALID_TRANSITION', canRetry: true });
    await made.outbox.retry(item?.id ?? '');
    await settle();
    expect(made.confirm).toHaveBeenCalledTimes(2);
    expect(await made.store.outbox.count()).toBe(0);
  });
});

describe('removing an order entry and what waits behind it', () => {
  test('the order, the create and the confirm go together', async () => {
    const made = await offlineWithPromptpay({
      createOrder: async () => {
        throw refused('ITEM_UNAVAILABLE', 422);
      },
    });
    made.life.goOnline();
    await settle();
    expect(made.outbox.getState().items.find((i) => i.kind === 'order')?.state).toBe('attention');
    await made.outbox.discard(uuid(10));
    expect(await made.store.outbox.count()).toBe(0);
  });

  test('while its order needs attention the payment is blocked, not sent', async () => {
    const made = await offlineWithPromptpay({
      createOrder: async () => {
        throw refused('ITEM_UNAVAILABLE', 422);
      },
    });
    made.life.goOnline();
    await settle();
    expect(made.outbox.getState().items.find((i) => i.kind === 'payment')).toMatchObject({
      state: 'blocked',
    });
    expect(made.createPayment).not.toHaveBeenCalled();
  });
});

describe('after a reload', () => {
  test('the saved payment is still one item, waiting for its order', async () => {
    const store = persistentStore();
    const first = await offlineWithPromptpay({ store });
    first.unbind();
    const second = setup({ store, online: false });
    await settle();
    const items = second.outbox.getState().items;
    expect(items.map((i) => i.kind).sort()).toEqual(['order', 'payment']);
    expect(items.find((i) => i.kind === 'payment')).toMatchObject({
      method: 'promptpay',
      dependsOn: uuid(10),
    });
  });
});
