/**
 * The status moves of an order (start preparing, mark ready, hand over, cancel), shared by the
 * order page and the kitchen view. State and rules live here, outside React, so they run (and are
 * tested) without a DOM.
 *
 * What the server offers: `POST /v1/orders/:id/transition` and `/cancel` have no idempotency key.
 * A repeated move answers 409 INVALID_TRANSITION (the order is no longer in the source status),
 * and an `expectedVersion` is not sent on purpose: a payment on the order bumps the order's
 * version too, so a version check would refuse a kitchen tap whenever the cashier confirmed a
 * payment a moment before. The status check under the server's row lock is the guard that
 * matters. So the client reconciles instead:
 * - when a move gets no answer (network, timeout, a garbled body, a 5xx) or is refused as
 *   INVALID_TRANSITION / VERSION_CONFLICT, the order is read again. If it is already in the
 *   target status the first call worked (or another device made the same move): the move counts as
 *   done and no error is shown. If not, the real order goes into the store (the card corrects
 *   itself) and the original error is shown;
 * - one move per order at a time (`pending`, set in the same tick, so two taps before React
 *   re-renders send one call); moves of other orders do not wait for it;
 * - the order on screen changes only from the server's answer (or a realtime frame), never from
 *   the tap;
 * - `reset()` (sign-out) bumps an epoch. An answer, a failure or a reload that belongs to an
 *   earlier epoch touches nothing: no frame into the next person's store, no error on their
 *   screen, and no clearing of the guard of their own request.
 */
import type { OrderDto, OrderStatus, RealtimeFrame } from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { mayHaveBeenCreated } from './cart-store.ts';
import type { MoveTarget } from './order-board.ts';

export interface MoveFailure {
  error: ApiClientError;
  /** The status the order was in when the move was tried: a later status makes the error stale. */
  from: OrderStatus;
  to: MoveTarget;
}

export interface OrderMovesState {
  /** Orders with a move on its way. */
  pending: readonly string[];
  /** The last refusal per order, until the next move of that order starts. */
  errors: Readonly<Record<string, MoveFailure>>;
}

export type MoveOutcome =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'stale' }
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface OrderMovesDeps {
  api: { orders: Pick<ApiClient['orders'], 'transition' | 'cancel' | 'get'> };
  entities: EntityStore;
}

export interface OrderMovesStore extends ReadableStore<OrderMovesState> {
  transition(order: Pick<OrderDto, 'id' | 'status'>, to: MoveTarget): Promise<MoveOutcome>;
  cancel(order: Pick<OrderDto, 'id' | 'status'>, reason: string): Promise<MoveOutcome>;
  /** Forgets one order's error (a dialog that was closed). */
  dismiss(orderId: string): void;
  /** Sign-out: forgets everything and makes every answer still on its way harmless. */
  reset(): void;
}

/** A refusal that means "the order is not where you thought": read it again. */
const STALE_VIEW_CODES: readonly string[] = ['INVALID_TRANSITION', 'VERSION_CONFLICT'];

const orderFrame = (o: OrderDto): RealtimeFrame => ({
  type: 'order.upserted',
  id: o.id,
  rev: o.rev,
  data: o,
});

const initial = (): OrderMovesState => ({ pending: [], errors: {} });

export function createOrderMovesStore(deps: OrderMovesDeps): OrderMovesStore {
  const store = createStore<OrderMovesState>(initial());
  let epoch = 0;

  const without = <T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> => {
    const { [id]: _gone, ...rest } = record;
    return rest;
  };

  async function run(
    order: Pick<OrderDto, 'id' | 'status'>,
    to: MoveTarget,
    send: () => Promise<OrderDto>,
  ): Promise<MoveOutcome> {
    if (store.getState().pending.includes(order.id)) return { ok: false, reason: 'busy' };
    const startedIn = epoch;
    store.setState({
      pending: [...store.getState().pending, order.id],
      errors: without(store.getState().errors, order.id),
    });
    const finish = (errors?: Record<string, MoveFailure>) =>
      store.setState({
        pending: store.getState().pending.filter((id) => id !== order.id),
        ...(errors ? { errors } : {}),
      });
    try {
      const answer = await send();
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      deps.entities.apply(orderFrame(answer));
      finish();
      return { ok: true };
    } catch (caught) {
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
      if (mayHaveBeenCreated(error) || STALE_VIEW_CODES.includes(error.code)) {
        const current = await deps.api.orders.get(order.id).catch(() => null);
        if (epoch !== startedIn) return { ok: false, reason: 'stale' };
        if (current) {
          deps.entities.apply(orderFrame(current));
          if (current.status === to) {
            finish();
            return { ok: true };
          }
        }
      }
      finish({
        ...store.getState().errors,
        [order.id]: { error, from: order.status, to },
      });
      return { ok: false, reason: 'error', error };
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    transition: (order, to) => run(order, to, () => deps.api.orders.transition(order.id, { to })),
    cancel: (order, reason) =>
      run(order, 'cancelled', () => deps.api.orders.cancel(order.id, { reason })),
    dismiss(orderId) {
      if (orderId in store.getState().errors) {
        store.setState({ errors: without(store.getState().errors, orderId) });
      }
    },
    reset() {
      epoch += 1;
      store.setState(initial());
    },
  };
}
