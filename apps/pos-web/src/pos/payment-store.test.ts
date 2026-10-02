import type { PaymentDto } from '@sds/shared';
import { satang } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createActivity } from '../lib/activity.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { createPaymentStore, type PaymentDeps } from './payment-store.ts';

const ORDER = uuid(900);
const PAYMENT = uuid(500);
const TOTAL = satang(7500);

const order = (rev: number, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(ORDER, rev, { totalSatang: TOTAL, ...over });
const payment = (rev: number, over: Partial<PaymentDto> = {}) =>
  paymentDto(PAYMENT, ORDER, rev, { amountSatang: TOTAL, ...over });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: { auth?: PaymentDeps['auth'] } = {}) {
  const entities = createEntityStore();
  const activity = createActivity();
  const created = { payment: payment(101), order: order(11, { paymentStatus: 'paid' }) };
  const api = {
    payments: {
      create: vi.fn<PaymentDeps['api']['payments']['create']>(async (_o, _i, options) => ({
        result: created,
        replay: false,
        clientRequestId: options?.clientRequestId ?? '',
      })),
      changeMethod: vi.fn<PaymentDeps['api']['payments']['changeMethod']>(
        async (_p, _i, options) => ({
          result: {
            payment: payment(103, { id: uuid(501), method: 'promptpay', status: 'pending' }),
            cancelledPayment: payment(102, { status: 'cancelled' }),
            order: order(12),
          },
          replay: false,
          clientRequestId: options?.clientRequestId ?? '',
        }),
      ),
      claim: vi.fn<PaymentDeps['api']['payments']['claim']>(async () => ({
        payment: payment(104, { status: 'claimed' }),
        order: order(13, { paymentStatus: 'awaiting_confirmation' }),
      })),
      confirm: vi.fn<PaymentDeps['api']['payments']['confirm']>(async () => ({
        payment: payment(105, { status: 'confirmed' }),
        order: order(14, { paymentStatus: 'paid' }),
      })),
      cancelClaimed: vi.fn<PaymentDeps['api']['payments']['cancelClaimed']>(async () => ({
        payment: payment(106, { status: 'cancelled' }),
        order: order(15),
      })),
      void: vi.fn<PaymentDeps['api']['payments']['void']>(async () => ({
        payment: payment(107, { status: 'voided' }),
        order: order(16, { paymentStatus: 'unpaid' }),
      })),
      refund: vi.fn<PaymentDeps['api']['payments']['refund']>(async () => ({
        payment: payment(108, { status: 'refunded' }),
        order: order(17, { paymentStatus: 'refunded' }),
      })),
      list: vi.fn<PaymentDeps['api']['payments']['list']>(async () => ({
        payments: [payment(110, { status: 'pending', method: 'promptpay' })],
      })),
    },
    orders: { get: vi.fn<PaymentDeps['api']['orders']['get']>(async () => order(20)) },
  };
  let n = 0;
  const auth: PaymentDeps['auth'] = overrides.auth ?? {
    runSensitive: async (call) => {
      try {
        return { ok: true as const, value: await call() };
      } catch (error) {
        return { ok: false as const, error: error as ApiClientError };
      }
    },
  };
  const store = createPaymentStore({
    api,
    entities,
    activity,
    auth,
    newId: () => uuid(2000 + ++n),
  });
  return { store, api, entities, activity };
}

const cash = { method: 'cash' as const, tendered: satang(10000) };

describe('creating a payment', () => {
  test('sends the method and the tender (never an amount) with a request id, and shows what the server answered', async () => {
    const { store, api, entities } = setup();
    const outcome = await store.create(ORDER, cash);
    expect(outcome.ok).toBe(true);
    expect(api.payments.create).toHaveBeenCalledTimes(1);
    const [orderId, input, options] = api.payments.create.mock.calls[0] ?? [];
    expect(orderId).toBe(ORDER);
    expect(input).toEqual(cash);
    expect(options?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    // Both rows come from the answer; nothing was shown before it.
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('confirmed');
    expect(entities.getState().orders.get(ORDER)?.paymentStatus).toBe('paid');
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null });
  });

  test('a double tap sends ONE request: the second call is refused at once', async () => {
    const gate = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['create']>>>();
    const { store, api } = setup();
    api.payments.create.mockReturnValueOnce(gate.promise);
    const first = store.create(ORDER, cash);
    expect(await store.create(ORDER, cash)).toEqual({ ok: false, reason: 'busy' });
    expect(api.payments.create).toHaveBeenCalledTimes(1);
    expect(store.getState().phase).toBe('sending');
    gate.resolve({
      result: { payment: payment(101), order: order(11, { paymentStatus: 'paid' }) },
      replay: false,
      clientRequestId: '',
    });
    expect((await first).ok).toBe(true);
  });

  test('a refusal by the server is shown, nothing is pending, and the next attempt has a new id', async () => {
    const { store, api } = setup();
    const refusal = new ApiClientError('TENDERED_BELOW_TOTAL', { status: 422 });
    api.payments.create.mockRejectedValueOnce(refusal);
    expect(await store.create(ORDER, cash)).toEqual({ ok: false, reason: 'error', error: refusal });
    expect(store.getState()).toMatchObject({ phase: 'idle', error: refusal, orderId: ORDER });
    await store.create(ORDER, cash);
    const ids = api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(new Set(ids).size).toBe(2);
    expect(store.getState().error).toBeNull();
  });

  test('an unanswered request may have created the payment: it is "unsure" and a retry sends the SAME id', async () => {
    const { store, api } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.create(ORDER, cash);
    expect(store.getState()).toMatchObject({ phase: 'unsure', action: 'create', orderId: ORDER });
    await store.create(ORDER, cash);
    const [first, second] = api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(second).toBe(first);
    expect(store.getState().phase).toBe('idle');
  });

  test('a different body after an unsure attempt is a different payment: it gets a new id', async () => {
    const { store, api } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.create(ORDER, cash);
    await store.create(ORDER, { method: 'cash', tendered: satang(50000) });
    const [first, second] = api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(second).not.toBe(first);
  });

  test('a garbled answer or a server error is also unsure', async () => {
    for (const error of [
      new ApiClientError('RESPONSE_INVALID', { status: 201 }),
      new ApiClientError('INTERNAL', { status: 500 }),
    ]) {
      const { store, api } = setup();
      api.payments.create.mockRejectedValueOnce(error);
      await store.create(ORDER, cash);
      expect(store.getState().phase).toBe('unsure');
    }
  });

  test('"already open" or "already paid" reloads the order and its payments, to show what is really there', async () => {
    for (const code of ['PAYMENT_ALREADY_OPEN', 'ORDER_ALREADY_PAID']) {
      const { store, api, entities } = setup();
      api.payments.create.mockRejectedValueOnce(new ApiClientError(code, { status: 409 }));
      await store.create(ORDER, { method: 'promptpay' });
      await vi.waitFor(() => expect(api.payments.list).toHaveBeenCalledWith(ORDER));
      await vi.waitFor(() => expect(api.orders.get).toHaveBeenCalledWith(ORDER));
      await vi.waitFor(() => expect(entities.getState().payments.size).toBe(1));
      expect(store.getState().phase).toBe('idle');
    }
  });

  test('the first call after a payment arrived through realtime clears the unsure state', async () => {
    const { store, api } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.create(ORDER, cash);
    store.settled(ORDER);
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null });
    await store.create(ORDER, cash);
    const ids = api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(new Set(ids).size).toBe(2);
  });

  test('another order is not touched by settled()', async () => {
    const { store, api } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.create(ORDER, cash);
    store.settled(uuid(901));
    expect(store.getState().phase).toBe('unsure');
  });
});

describe('changing the method', () => {
  test('sends the new choice with a request id, and shows both payments and the order', async () => {
    const { store, api, entities } = setup();
    const outcome = await store.changeMethod(ORDER, uuid(501), { method: 'promptpay' });
    expect(outcome.ok).toBe(true);
    expect(api.payments.changeMethod.mock.calls[0]?.[0]).toBe(uuid(501));
    expect(api.payments.changeMethod.mock.calls[0]?.[1]).toEqual({ method: 'promptpay' });
    expect(entities.getState().payments.size).toBe(2);
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('cancelled');
  });

  test('an unanswered change is retried with the same id', async () => {
    const { store, api } = setup();
    api.payments.changeMethod.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.changeMethod(ORDER, uuid(501), { method: 'promptpay' });
    expect(store.getState()).toMatchObject({ phase: 'unsure', action: 'changeMethod' });
    await store.changeMethod(ORDER, uuid(501), { method: 'promptpay' });
    const [a, b] = api.payments.changeMethod.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(b).toBe(a);
  });
});

describe('moving a payment', () => {
  test('claim, confirm (with the reference) and cancel-claimed go to the API and update the store', async () => {
    const { store, api, entities } = setup();
    await store.claim(ORDER, PAYMENT);
    expect(api.payments.claim).toHaveBeenCalledWith(PAYMENT, {});
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('claimed');

    await store.confirm(ORDER, PAYMENT, { referenceNote: 'A1234' });
    expect(api.payments.confirm).toHaveBeenCalledWith(PAYMENT, { referenceNote: 'A1234' });
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('confirmed');

    await store.cancelClaimed(ORDER, PAYMENT, 'ไม่พบยอดเข้า');
    expect(api.payments.cancelClaimed).toHaveBeenCalledWith(PAYMENT, { reason: 'ไม่พบยอดเข้า' });
  });

  test('confirm without a reference sends no reference', async () => {
    const { store, api } = setup();
    await store.confirm(ORDER, PAYMENT, {});
    expect(api.payments.confirm).toHaveBeenCalledWith(PAYMENT, {});
  });

  test('nothing is shown as paid until the server answers', async () => {
    const gate = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['confirm']>>>();
    const { store, api, entities } = setup();
    api.payments.confirm.mockReturnValueOnce(gate.promise);
    const pending = store.confirm(ORDER, PAYMENT, {});
    expect(entities.getState().orders.size).toBe(0);
    expect(entities.getState().payments.size).toBe(0);
    expect(store.getState().phase).toBe('sending');
    gate.reject(new ApiClientError('FORBIDDEN', { status: 403 }));
    await pending;
    expect(entities.getState().orders.size).toBe(0);
  });

  test('a lost answer is unsure, and the same button can simply be pressed again', async () => {
    const { store, api } = setup();
    api.payments.confirm.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.confirm(ORDER, PAYMENT, {});
    expect(store.getState()).toMatchObject({ phase: 'unsure', action: 'confirm' });
    expect((await store.confirm(ORDER, PAYMENT, {})).ok).toBe(true);
    expect(store.getState().phase).toBe('idle');
  });

  test('a double tap on confirm sends one request', async () => {
    const gate = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['confirm']>>>();
    const { store, api } = setup();
    api.payments.confirm.mockReturnValueOnce(gate.promise);
    const first = store.confirm(ORDER, PAYMENT, {});
    expect(await store.confirm(ORDER, PAYMENT, {})).toEqual({ ok: false, reason: 'busy' });
    gate.resolve({
      payment: payment(105, { status: 'confirmed' }),
      order: order(14, { paymentStatus: 'paid' }),
    });
    await first;
    expect(api.payments.confirm).toHaveBeenCalledTimes(1);
  });

  test('a stale-state refusal reloads the payments of the order', async () => {
    const { store, api } = setup();
    api.payments.confirm.mockRejectedValueOnce(
      new ApiClientError('INVALID_TRANSITION', { status: 409 }),
    );
    await store.confirm(ORDER, PAYMENT, {});
    await vi.waitFor(() => expect(api.payments.list).toHaveBeenCalledWith(ORDER));
  });
});

describe('void and refund (sensitive)', () => {
  test('run through the step-up wrapper with the reason, and show the result', async () => {
    let asked = 0;
    const runSensitive: PaymentDeps['auth']['runSensitive'] = async (call) => {
      asked += 1;
      return { ok: true, value: await call() };
    };
    const { store, api, entities } = setup({ auth: { runSensitive } });
    const outcome = await store.voidPayment(ORDER, PAYMENT, 'คิดเงินผิด');
    expect(outcome.ok).toBe(true);
    expect(asked).toBe(1);
    expect(api.payments.void).toHaveBeenCalledWith(PAYMENT, { reason: 'คิดเงินผิด' });
    expect(entities.getState().payments.get(PAYMENT)?.status).toBe('voided');
    await store.refundPayment(ORDER, PAYMENT, 'ลูกค้าขอคืน');
    expect(api.payments.refund).toHaveBeenCalledWith(PAYMENT, { reason: 'ลูกค้าขอคืน' });
  });

  test('cancelling the step-up sends nothing and says it was cancelled', async () => {
    const { store, api } = setup({
      auth: { runSensitive: async () => ({ ok: false as const, error: null }) },
    });
    expect(await store.voidPayment(ORDER, PAYMENT, 'x')).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(api.payments.void).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null });
  });

  test('a refusal after the step-up is shown', async () => {
    const refusal = new ApiClientError('FORBIDDEN', { status: 403 });
    const { store } = setup({
      auth: { runSensitive: async () => ({ ok: false as const, error: refusal }) },
    });
    expect(await store.voidPayment(ORDER, PAYMENT, 'x')).toEqual({
      ok: false,
      reason: 'error',
      error: refusal,
    });
    expect(store.getState().error).toBe(refusal);
  });

  test('the app stays busy during the step-up, so an update cannot reload under the dialog', async () => {
    const gate = deferred<{ ok: false; error: null }>();
    const { store, activity } = setup({ auth: { runSensitive: () => gate.promise } });
    const pending = store.voidPayment(ORDER, PAYMENT, 'x');
    expect(activity.isBusy()).toBe(true);
    gate.resolve({ ok: false, error: null });
    await pending;
    expect(activity.isBusy()).toBe(false);
  });
});

describe('work a page reload would lose', () => {
  test('the app is busy while a request runs and while its outcome is unsure, and idle afterwards', async () => {
    const { store, api, activity } = setup();
    expect(activity.isBusy()).toBe(false);
    api.payments.create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.create(ORDER, cash);
    expect(activity.isBusy()).toBe(true);
    await store.create(ORDER, cash);
    expect(activity.isBusy()).toBe(false);
  });

  test('a refusal leaves the app idle', async () => {
    const { store, api, activity } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('FORBIDDEN', { status: 403 }));
    await store.create(ORDER, cash);
    expect(activity.isBusy()).toBe(false);
  });
});

describe('reset (sign-out)', () => {
  test('forgets the state and the request ids of the person who left', async () => {
    const { store, api, activity } = setup();
    api.payments.create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    await store.create(ORDER, cash);
    store.reset();
    expect(store.getState()).toMatchObject({ phase: 'idle', orderId: null, error: null });
    expect(activity.isBusy()).toBe(false);
    await store.create(ORDER, cash);
    const ids = api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(new Set(ids).size).toBe(2);
  });

  test('an answer to a request sent before the person left is dropped, and its guard is not cleared', async () => {
    const first = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['create']>>>();
    const second = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['create']>>>();
    const { store, api, entities } = setup();
    api.payments.create.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const stale = store.create(ORDER, cash);
    store.reset();
    const current = store.create(uuid(901), cash);
    first.resolve({
      result: { payment: payment(101), order: order(11, { paymentStatus: 'paid' }) },
      replay: false,
      clientRequestId: '',
    });
    expect(await stale).toEqual({ ok: false, reason: 'stale' });
    expect(entities.getState().payments.size).toBe(0);
    expect(await store.create(uuid(901), cash)).toEqual({ ok: false, reason: 'busy' });
    second.resolve({
      result: { payment: payment(102), order: order(12) },
      replay: false,
      clientRequestId: '',
    });
    expect((await current).ok).toBe(true);
  });

  test('a late failure of a request sent before sign-out does not mark the next session unsure', async () => {
    const first = deferred<Awaited<ReturnType<PaymentDeps['api']['payments']['create']>>>();
    const { store, api } = setup();
    api.payments.create.mockReturnValueOnce(first.promise);
    const stale = store.create(ORDER, cash);
    store.reset();
    first.reject(new ApiClientError('NETWORK'));
    expect(await stale).toEqual({ ok: false, reason: 'stale' });
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null });
  });
});

describe('refresh', () => {
  test('loads the order and its payments into the store', async () => {
    const { store, api, entities } = setup();
    await store.refresh(ORDER);
    expect(api.payments.list).toHaveBeenCalledWith(ORDER);
    expect(entities.getState().payments.size).toBe(1);
  });

  test('a failed refresh is silent: the screen keeps what it has', async () => {
    const { store, api } = setup();
    api.payments.list.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await expect(store.refresh(ORDER)).resolves.toBeUndefined();
  });
});
