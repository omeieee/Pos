import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEntityStore } from '../../realtime/entity-store.ts';
import { orderDto, orderFrame, uuid } from '../../test-support/frames.ts';
import { createOrderMovesStore, type OrderMovesDeps } from '../orders/order-moves-store.ts';
import { createReadyUndoStore, READY_UNDO_SECONDS } from './ready-undo-store.ts';

const A = uuid(910);
const B = uuid(911);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2030-01-01T05:30:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const entities = createEntityStore();
  entities.apply(orderFrame(A, 10, { orderNo: 'S-001', status: 'preparing' }));
  entities.apply(orderFrame(B, 11, { orderNo: 'S-002', status: 'preparing' }));
  const api = {
    orders: {
      transition: vi.fn<OrderMovesDeps['api']['orders']['transition']>(async (id) =>
        orderDto(id, 50, { status: 'ready' }),
      ),
      cancel: vi.fn<OrderMovesDeps['api']['orders']['cancel']>(),
      get: vi.fn<OrderMovesDeps['api']['orders']['get']>(),
    },
  };
  const moves = createOrderMovesStore({ api, entities });
  const undo = createReadyUndoStore({ moves, entities });
  return { entities, api, moves, undo };
}

const cooking = (id: string) => ({ id, status: 'preparing' }) as const;
const left = (undo: ReturnType<typeof setup>['undo'], id: string) =>
  undo.getState().waiting[id]?.secondsLeft;

describe('the 5-second undo of “done”', () => {
  test('is 5 seconds', () => {
    expect(READY_UNDO_SECONDS).toBe(5);
  });

  test('an undo within the 5 seconds sends nothing, ever', async () => {
    const { undo, api } = setup();
    expect(undo.start(cooking(A))).toBe(true);
    await vi.advanceTimersByTimeAsync(4_900);
    undo.undo(A);
    expect(undo.getState().waiting[A]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.orders.transition).not.toHaveBeenCalled();
  });

  test('no undo: exactly one PATCH to ready, only when the 5 seconds are over', async () => {
    const { undo, api, entities } = setup();
    undo.start(cooking(A));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(api.orders.transition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
    expect(api.orders.transition).toHaveBeenCalledWith(A, { to: 'ready' });
    expect(undo.getState().waiting[A]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
    expect(entities.getState().orders.get(A)?.status).toBe('ready');
  });

  test('the countdown goes 5, 4, 3, 2, 1', async () => {
    const { undo } = setup();
    const seen: number[] = [];
    undo.subscribe(() => {
      const s = left(undo, A);
      if (s !== undefined && seen.at(-1) !== s) seen.push(s);
    });
    undo.start(cooking(A));
    expect(left(undo, A)).toBe(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(left(undo, A)).toBe(4);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(left(undo, A)).toBe(1);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  test('a second tap while it counts does not start a second countdown', async () => {
    const { undo, api } = setup();
    expect(undo.start(cooking(A))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(undo.start(cooking(A))).toBe(false);
    expect(left(undo, A)).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
  });

  test('two tickets count on their own: undoing one leaves the other to go', async () => {
    const { undo, api } = setup();
    undo.start(cooking(A));
    await vi.advanceTimersByTimeAsync(2_000);
    undo.start(cooking(B));
    expect(left(undo, A)).toBe(3);
    expect(left(undo, B)).toBe(5);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
    expect(api.orders.transition).toHaveBeenLastCalledWith(A, { to: 'ready' });
    expect(left(undo, B)).toBe(2);
    undo.undo(B);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
  });

  test('a page that was asleep counts from the clock: the move goes out on wake-up, once', async () => {
    const { undo, api } = setup();
    undo.start(cooking(A));
    // Timers held back (iOS in the background), then the clock has jumped on.
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
  });
});

describe('the order changed underneath', () => {
  test('cancelled on another device during the countdown: nothing is sent and the countdown ends', async () => {
    const { undo, api, entities } = setup();
    undo.start(cooking(A));
    await vi.advanceTimersByTimeAsync(2_000);
    entities.apply(orderFrame(A, 60, { orderNo: 'S-001', status: 'cancelled' }));
    expect(undo.getState().waiting[A]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.orders.transition).not.toHaveBeenCalled();
  });

  test('marked ready by another device: no second move (no second LINE push attempt)', async () => {
    const { undo, api, entities } = setup();
    undo.start(cooking(A));
    entities.apply(orderFrame(A, 61, { orderNo: 'S-001', status: 'ready' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.orders.transition).not.toHaveBeenCalled();
  });

  test('a change that leaves it cooking (a payment confirmed) does not stop the countdown', async () => {
    const { undo, api, entities } = setup();
    undo.start(cooking(A));
    entities.apply(
      orderFrame(A, 62, { orderNo: 'S-001', status: 'preparing', paymentStatus: 'paid' }),
    );
    expect(left(undo, A)).toBe(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.orders.transition).toHaveBeenCalledTimes(1);
  });

  test('a start from a status that is not cooking any more is refused', () => {
    const { undo, entities } = setup();
    entities.apply(orderFrame(A, 63, { orderNo: 'S-001', status: 'cancelled' }));
    expect(undo.start(cooking(A))).toBe(false);
    expect(undo.getState().waiting).toEqual({});
  });
});

describe('sign-out (reset)', () => {
  test('a countdown still running at sign-out is dropped and sends nothing', async () => {
    const { undo, api } = setup();
    undo.start(cooking(A));
    undo.start(cooking(B));
    undo.reset();
    expect(undo.getState().waiting).toEqual({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.orders.transition).not.toHaveBeenCalled();
  });
});
