import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { createOrderMovesStore, type OrderMovesDeps } from './order-moves-store.ts';

const ID = uuid(900);
const OTHER = uuid(901);

const order = (rev: number, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(ID, rev, { orderNo: 'S-013', ...over });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const entities = createEntityStore();
  const api = {
    orders: {
      transition: vi.fn<OrderMovesDeps['api']['orders']['transition']>(async () =>
        order(11, { status: 'ready' }),
      ),
      cancel: vi.fn<OrderMovesDeps['api']['orders']['cancel']>(async () =>
        order(12, { status: 'cancelled' }),
      ),
      get: vi.fn<OrderMovesDeps['api']['orders']['get']>(async () => order(20)),
    },
  };
  const store = createOrderMovesStore({ api, entities });
  return { store, api, entities };
}

const preparing = { id: ID, status: 'preparing' } as const;

describe('a status move', () => {
  test('sends the target status and shows what the server answered, never the tap', async () => {
    const { store, api, entities } = setup();
    const pending = store.transition(preparing, 'ready');
    expect(store.getState().pending).toEqual([ID]);
    expect(entities.getState().orders.size).toBe(0);
    expect(await pending).toEqual({ ok: true });
    expect(api.orders.transition).toHaveBeenCalledWith(ID, { to: 'ready' });
    expect(entities.getState().orders.get(ID)?.status).toBe('ready');
    expect(store.getState().pending).toEqual([]);
  });

  test('a double tap sends ONE request', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const { store, api } = setup();
    api.orders.transition.mockReturnValueOnce(first.promise);
    const one = store.transition(preparing, 'ready');
    expect(await store.transition(preparing, 'ready')).toEqual({ ok: false, reason: 'busy' });
    first.resolve(order(11, { status: 'ready' }));
    await one;
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
  });

  test('moves of different orders do not wait for each other', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const { store, api } = setup();
    api.orders.transition.mockReturnValueOnce(first.promise);
    const slow = store.transition(preparing, 'ready');
    const fast = await store.transition({ id: OTHER, status: 'new' }, 'preparing');
    expect(fast.ok).toBe(true);
    expect(store.getState().pending).toEqual([ID]);
    first.resolve(order(11, { status: 'ready' }));
    await slow;
  });

  test('a refusal is kept for that order, with the status it was refused from', async () => {
    const { store, api } = setup();
    api.orders.transition.mockRejectedValueOnce(new ApiClientError('FORBIDDEN', { status: 403 }));
    const outcome = await store.transition({ id: ID, status: 'new' }, 'preparing');
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(store.getState().errors[ID]).toMatchObject({ from: 'new', to: 'preparing' });
    expect(store.getState().errors[ID]?.error.code).toBe('FORBIDDEN');
    expect(api.orders.get).not.toHaveBeenCalled();
    // The next try clears it.
    await store.transition({ id: ID, status: 'new' }, 'preparing');
    expect(store.getState().errors[ID]).toBeUndefined();
  });
});

describe('a lost answer', () => {
  test('the order is read again; if it is already in the target status the move counts as done', async () => {
    const { store, api, entities } = setup();
    api.orders.transition.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    api.orders.get.mockResolvedValueOnce(order(20, { status: 'ready' }));
    expect(await store.transition(preparing, 'ready')).toEqual({ ok: true });
    expect(store.getState().errors[ID]).toBeUndefined();
    expect(entities.getState().orders.get(ID)?.status).toBe('ready');
  });

  test('a retry that meets INVALID_TRANSITION (the first call had worked) is not shown as an error', async () => {
    const { store, api, entities } = setup();
    api.orders.transition.mockRejectedValueOnce(
      new ApiClientError('INVALID_TRANSITION', { status: 409 }),
    );
    api.orders.get.mockResolvedValueOnce(order(20, { status: 'ready' }));
    expect(await store.transition(preparing, 'ready')).toEqual({ ok: true });
    expect(store.getState().errors[ID]).toBeUndefined();
    expect(entities.getState().orders.get(ID)?.status).toBe('ready');
  });

  test('if the order is somewhere else now (someone cancelled it), the refusal is shown and the card is corrected', async () => {
    const { store, api, entities } = setup();
    api.orders.transition.mockRejectedValueOnce(
      new ApiClientError('INVALID_TRANSITION', { status: 409 }),
    );
    api.orders.get.mockResolvedValueOnce(order(20, { status: 'cancelled' }));
    const outcome = await store.transition(preparing, 'ready');
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(store.getState().errors[ID]?.error.code).toBe('INVALID_TRANSITION');
    expect(entities.getState().orders.get(ID)?.status).toBe('cancelled');
  });

  test('a lost answer and an order that still is where it was: the error stays, the same tap can be repeated', async () => {
    const { store, api } = setup();
    api.orders.transition.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    api.orders.get.mockResolvedValueOnce(order(20, { status: 'preparing' }));
    const outcome = await store.transition(preparing, 'ready');
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(store.getState().errors[ID]?.error.code).toBe('NETWORK');
    expect(await store.transition(preparing, 'ready')).toEqual({ ok: true });
  });

  test('when the read fails too the original error is shown and nothing is invented', async () => {
    const { store, api, entities } = setup();
    api.orders.transition.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    api.orders.get.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    const outcome = await store.transition(preparing, 'ready');
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(store.getState().errors[ID]?.error.code).toBe('TIMEOUT');
    expect(entities.getState().orders.size).toBe(0);
  });
});

describe('cancelling', () => {
  test('sends the reason and shows the answer', async () => {
    const { store, api, entities } = setup();
    expect(await store.cancel({ id: ID, status: 'new' }, 'ลูกค้าเปลี่ยนใจ')).toEqual({ ok: true });
    expect(api.orders.cancel).toHaveBeenCalledWith(ID, { reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(entities.getState().orders.get(ID)?.status).toBe('cancelled');
  });

  test('a lost answer that did cancel it is done, not an INVALID_TRANSITION', async () => {
    const { store, api } = setup();
    api.orders.cancel.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    api.orders.get.mockResolvedValueOnce(order(20, { status: 'cancelled' }));
    expect(await store.cancel({ id: ID, status: 'new' }, 'x')).toEqual({ ok: true });
  });

  test('ORDER_HAS_PAYMENT is a refusal like any other, with no reload', async () => {
    const { store, api } = setup();
    api.orders.cancel.mockRejectedValueOnce(
      new ApiClientError('ORDER_HAS_PAYMENT', { status: 409 }),
    );
    const outcome = await store.cancel({ id: ID, status: 'new' }, 'x');
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(api.orders.get).not.toHaveBeenCalled();
  });
});

describe('sign-out (reset)', () => {
  test('an answer that arrives after sign-out puts nothing into the next person’s store', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const { store, api, entities } = setup();
    api.orders.transition.mockReturnValueOnce(first.promise);
    const stale = store.transition(preparing, 'ready');
    store.reset();
    first.resolve(order(11, { status: 'ready' }));
    expect(await stale).toEqual({ ok: false, reason: 'stale' });
    expect(entities.getState().orders.size).toBe(0);
    expect(store.getState().pending).toEqual([]);
  });

  test('a late failure puts no error on the next person’s screen and starts no reload', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const { store, api } = setup();
    api.orders.transition.mockReturnValueOnce(first.promise);
    const stale = store.transition(preparing, 'ready');
    store.reset();
    first.reject(new ApiClientError('NETWORK'));
    expect(await stale).toEqual({ ok: false, reason: 'stale' });
    expect(store.getState().errors).toEqual({});
    expect(api.orders.get).not.toHaveBeenCalled();
  });

  test('the old request does not clear the guard of the next person’s own request for the same order', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const second = deferred<ReturnType<typeof order>>();
    const { store, api } = setup();
    api.orders.transition.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const stale = store.transition(preparing, 'ready');
    store.reset();
    const current = store.transition(preparing, 'ready');
    first.resolve(order(11, { status: 'ready' }));
    await stale;
    expect(await store.transition(preparing, 'ready')).toEqual({ ok: false, reason: 'busy' });
    second.resolve(order(12, { status: 'ready' }));
    expect((await current).ok).toBe(true);
  });

  test('a reload that is still on its way at sign-out is dropped too', async () => {
    const read = deferred<ReturnType<typeof order>>();
    const { store, api, entities } = setup();
    api.orders.transition.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    api.orders.get.mockReturnValueOnce(read.promise);
    const stale = store.transition(preparing, 'ready');
    await vi.waitFor(() => expect(api.orders.get).toHaveBeenCalled());
    store.reset();
    read.resolve(order(20, { status: 'ready' }));
    expect(await stale).toEqual({ ok: false, reason: 'stale' });
    expect(entities.getState().orders.size).toBe(0);
  });
});
