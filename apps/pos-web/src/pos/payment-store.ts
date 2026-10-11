/**
 * The payment calls of the order page. State and rules live here, outside React, so they run (and
 * are tested) without a DOM, and so they survive leaving the page: going to the orders list and
 * back must not lose the request id of a payment whose answer never arrived.
 *
 * Money: no amount is ever sent. The server charges the order total; cash sends only the tender.
 * Nothing is shown as paid, claimed or confirmed from a click: the rows come only from the
 * server's answer (and from realtime frames), applied after the answer.
 *
 * Safely, in the same way as creating an order (cart-store.ts):
 * - one request at a time (`inFlight`, set in the same tick, so two taps before React re-renders
 *   send one call). A second call is refused as `busy`;
 * - `create` and `changeMethod` carry a `clientRequestId` (the idempotency key). It belongs to the
 *   logical attempt, so it is made at the first attempt and kept until the answer is known. When no
 *   answer arrived (network, timeout, a garbled body, a 5xx) the payment MAY exist, the phase is
 *   `unsure`, and a retry with the same body sends the same id: the server then answers the
 *   original. A different body is a different attempt with a new id;
 * - the moves (claim, confirm, cancel-claimed, void, refund) have no id: the server answers 200
 *   without a write when the payment is already in the target status, so pressing the same button
 *   again is safe. They also go `unsure` when the answer is lost, so the screen can say so;
 * - an `unsure` attempt is kept PER ORDER, together with the body that was sent (the cash tender).
 *   A screen that is left and opened again restores the tender from it, so the retry sends the
 *   same body under the same id; and starting a payment on another order does not lose it;
 * - void and refund run through `auth.runSensitive`: the step-up dialog opens first, a cancelled
 *   dialog sends nothing, and a STEP_UP_REQUIRED answer asks again once and retries;
 * - `reset()` (sign-out) bumps an epoch. An answer to a request sent before it touches nothing: no
 *   rows into the store, no `unsure` on the next person's session, no clearing of the guard of
 *   their own request;
 * - the app counts as busy (an update never reloads the page) while a request runs, while the
 *   step-up dialog is open, and while the outcome is unsure.
 */
import type {
  ChangePaymentMethodResult,
  OrderDto,
  PaymentDto,
  PaymentRefundDto,
  PaymentResult,
  RealtimeFrame,
} from '@sds/shared';
import type { ApiClient, ChangePaymentInput, NewPaymentInput } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import type { AuthStore } from '../auth/auth-store.ts';
import type { Activity } from '../lib/activity.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { newUuid } from '../platform/ids.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { mayHaveBeenCreated } from './cart-store.ts';

export type PaymentAction =
  | 'create'
  | 'changeMethod'
  | 'claim'
  | 'confirm'
  | 'cancelClaimed'
  | 'void'
  | 'refund';

/** A call whose answer never arrived: what was asked, and what the person has to wait for. */
export interface UnsureAttempt {
  action: PaymentAction;
  error: ApiClientError;
  /** The body of a create or change-method call (to restore the tender); null for a move. */
  input: NewPaymentInput | ChangePaymentInput | null;
}

/** What the server last said about an order's money beyond its payment rows (never computed here). */
export interface OrderLedger {
  refunds: readonly PaymentRefundDto[];
  netPaidSatang: number | null;
  dueSatang: number | null;
}

export interface PaymentFlowState {
  /** What the server said about each order's refunds, net paid and amount still due. */
  ledger: Readonly<Record<string, OrderLedger>>;
  /** The order the running or last action belongs to. */
  orderId: string | null;
  phase: 'idle' | 'sending' | 'unsure';
  action: PaymentAction | null;
  /** The last failed attempt, until the next one starts. */
  error: ApiClientError | null;
  /** Orders with a lost answer, by order id. Cleared by an answer, `settled` or `reset`. */
  unsure: Readonly<Record<string, UnsureAttempt>>;
}

/** What one order's screen needs to know about the flow (see `flowFor`). */
export interface OrderFlow {
  /** The kind of call that is running for this order, or null. */
  sending: PaymentAction | null;
  /** The answer to a call for this order was lost: it may have been saved. */
  unsure: UnsureAttempt | null;
  /** The server's refusal of the last call for this order, until the next call starts. */
  refused: { action: PaymentAction; error: ApiClientError } | null;
  /** A call for ANOTHER order is running; new calls are refused until it ends. */
  busyElsewhere: boolean;
}

export function flowFor(state: PaymentFlowState, orderId: string): OrderFlow {
  const mine = state.orderId === orderId;
  return {
    sending: mine && state.phase === 'sending' ? state.action : null,
    unsure: state.unsure[orderId] ?? null,
    refused:
      mine && state.phase === 'idle' && state.action !== null && state.error
        ? { action: state.action, error: state.error }
        : null,
    busyElsewhere: !mine && state.phase === 'sending',
  };
}

export type PaymentOutcome =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'stale' | 'cancelled' }
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface PaymentDeps {
  api: {
    payments: Pick<
      ApiClient['payments'],
      'create' | 'changeMethod' | 'claim' | 'confirm' | 'cancelClaimed' | 'void' | 'refund' | 'list'
    >;
    orders: Pick<ApiClient['orders'], 'get'>;
  };
  entities: EntityStore;
  activity: Activity;
  auth: Pick<AuthStore, 'runSensitive'>;
  /** Ids for the request id; tests fix them. */
  newId?: () => string;
}

export interface PaymentStore extends ReadableStore<PaymentFlowState> {
  create(orderId: string, input: NewPaymentInput): Promise<PaymentOutcome>;
  changeMethod(
    orderId: string,
    paymentId: string,
    input: ChangePaymentInput,
  ): Promise<PaymentOutcome>;
  claim(orderId: string, paymentId: string): Promise<PaymentOutcome>;
  confirm(
    orderId: string,
    paymentId: string,
    input: { referenceNote?: string },
  ): Promise<PaymentOutcome>;
  cancelClaimed(orderId: string, paymentId: string, reason: string): Promise<PaymentOutcome>;
  voidPayment(orderId: string, paymentId: string, reason: string): Promise<PaymentOutcome>;
  refundPayment(orderId: string, paymentId: string, reason: string): Promise<PaymentOutcome>;
  /**
   * The payment this order was waiting for has arrived (a realtime frame or a reload): the
   * `unsure` state of that order is over. Other orders are left alone.
   */
  settled(orderId: string): void;
  /** Loads the order and its payments into the store. A failure is silent. */
  refresh(orderId: string): Promise<void>;
  /** Sign-out: forgets the state and every request id. */
  reset(): void;
}

/** A refusal that means "your view of this order or payment is out of date": reload it. */
const STALE_VIEW_CODES: readonly string[] = [
  'PAYMENT_ALREADY_OPEN',
  'ORDER_ALREADY_PAID',
  'PAYMENT_NOT_PENDING',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
];

class StepUpCancelled extends Error {}

const paymentFrame = (p: PaymentDto): RealtimeFrame => ({
  type: 'payment.upserted',
  id: p.id,
  rev: p.rev,
  data: p,
});
const orderFrame = (o: OrderDto): RealtimeFrame => ({
  type: 'order.upserted',
  id: o.id,
  rev: o.rev,
  data: o,
});
export const framesOf = (result: PaymentResult | ChangePaymentMethodResult): RealtimeFrame[] => [
  ...('cancelledPayment' in result ? [paymentFrame(result.cancelledPayment)] : []),
  paymentFrame(result.payment),
  orderFrame(result.order),
];

const initial = (): PaymentFlowState => ({
  ledger: {},
  orderId: null,
  phase: 'idle',
  action: null,
  error: null,
  unsure: {},
});

const without = (map: PaymentFlowState['unsure'], orderId: string): PaymentFlowState['unsure'] => {
  if (!(orderId in map)) return map;
  const { [orderId]: _gone, ...rest } = map;
  return rest;
};

/** The parts of a create body that make it the same attempt: method, tender, reference. */
const bodyKey = (input: NewPaymentInput | ChangePaymentInput) =>
  `${input.method}:${'tendered' in input ? input.tendered : ''}:${input.referenceNote ?? ''}`;

export function createPaymentStore(deps: PaymentDeps): PaymentStore {
  const newId = deps.newId ?? newUuid;
  const store = createStore<PaymentFlowState>(initial());
  /** `orderId|action|body` -> the request id of an attempt whose answer is not known yet. */
  const requestIds = new Map<string, string>();
  let inFlight = false;
  let epoch = 0;
  let endBusy: (() => void) | null = null;

  store.subscribe(() => {
    const state = store.getState();
    const busy = state.phase === 'sending' || Object.keys(state.unsure).length > 0;
    if (busy && !endBusy) endBusy = deps.activity.begin();
    if (!busy && endBusy) {
      endBusy();
      endBusy = null;
    }
  });

  async function refresh(orderId: string): Promise<void> {
    const startedIn = epoch;
    const [payments, order] = await Promise.allSettled([
      deps.api.payments.list(orderId),
      deps.api.orders.get(orderId),
    ]);
    if (epoch !== startedIn) return;
    if (payments.status === 'fulfilled') {
      const { refunds, netPaidSatang, dueSatang } = payments.value;
      store.setState({
        ledger: {
          ...store.getState().ledger,
          [orderId]: {
            refunds: refunds ?? [],
            netPaidSatang: netPaidSatang ?? null,
            dueSatang: dueSatang ?? null,
          },
        },
      });
    }
    deps.entities.applyMany([
      ...(payments.status === 'fulfilled' ? payments.value.payments.map(paymentFrame) : []),
      ...(order.status === 'fulfilled' ? [orderFrame(order.value)] : []),
    ]);
  }

  /**
   * One guarded call. `send` returns the frames to show once the server has answered. `idKey` is
   * set for the calls that carry a request id.
   */
  async function run(
    action: PaymentAction,
    orderId: string,
    idKey: string | null,
    input: UnsureAttempt['input'],
    send: (clientRequestId: string) => Promise<RealtimeFrame[]>,
  ): Promise<PaymentOutcome> {
    if (inFlight) return { ok: false, reason: 'busy' };
    inFlight = true;
    const startedIn = epoch;
    const fullKey = idKey === null ? null : `${orderId}|${action}|${idKey}`;
    let clientRequestId = '';
    if (fullKey !== null) {
      clientRequestId = requestIds.get(fullKey) ?? newId();
      requestIds.set(fullKey, clientRequestId);
    }
    store.setState({ orderId, action, phase: 'sending', error: null });
    try {
      const frames = await send(clientRequestId);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      deps.entities.applyMany(frames);
      if (fullKey !== null) requestIds.delete(fullKey);
      store.setState({
        phase: 'idle',
        action: null,
        error: null,
        unsure: without(store.getState().unsure, orderId),
      });
      return { ok: true };
    } catch (caught) {
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      if (caught instanceof StepUpCancelled) {
        // Nothing was sent, so an earlier unsure attempt (if any) stays exactly as it was.
        store.setState({ phase: 'idle', action: null, error: null });
        return { ok: false, reason: 'cancelled' };
      }
      const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
      const unsure = mayHaveBeenCreated(error);
      // A known refusal means nothing was made: the next attempt is a new one.
      if (!unsure && fullKey !== null) requestIds.delete(fullKey);
      const kept = store.getState().unsure;
      store.setState({
        phase: unsure ? 'unsure' : 'idle',
        error,
        // A definite answer ends the doubt about this order; a lost one starts or renews it.
        unsure: unsure ? { ...kept, [orderId]: { action, error, input } } : without(kept, orderId),
      });
      if (STALE_VIEW_CODES.includes(error.code)) void refresh(orderId);
      return { ok: false, reason: 'error', error };
    } finally {
      // After a sign-out the guard belongs to whoever has sent a request since.
      if (epoch === startedIn) inFlight = false;
    }
  }

  /** Runs a step-up call; a cancelled dialog and a failure both leave through the catch above. */
  const sensitive = (call: () => Promise<PaymentResult>) => async (): Promise<RealtimeFrame[]> => {
    const result = await deps.auth.runSensitive(call);
    if (result.ok) return framesOf(result.value);
    throw result.error ?? new StepUpCancelled();
  };

  const move = (call: () => Promise<PaymentResult>) => async (): Promise<RealtimeFrame[]> =>
    framesOf(await call());

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    create: (orderId, input) =>
      run('create', orderId, bodyKey(input), input, async (clientRequestId) =>
        framesOf((await deps.api.payments.create(orderId, input, { clientRequestId })).result),
      ),

    changeMethod: (orderId, paymentId, input) =>
      run(
        'changeMethod',
        orderId,
        `${paymentId}:${bodyKey(input)}`,
        input,
        async (clientRequestId) =>
          framesOf(
            (await deps.api.payments.changeMethod(paymentId, input, { clientRequestId })).result,
          ),
      ),

    claim: (orderId, paymentId) =>
      run(
        'claim',
        orderId,
        null,
        null,
        move(() => deps.api.payments.claim(paymentId, {})),
      ),

    confirm: (orderId, paymentId, input) =>
      run(
        'confirm',
        orderId,
        null,
        null,
        move(() =>
          deps.api.payments.confirm(
            paymentId,
            input.referenceNote ? { referenceNote: input.referenceNote } : {},
          ),
        ),
      ),

    cancelClaimed: (orderId, paymentId, reason) =>
      run(
        'cancelClaimed',
        orderId,
        null,
        null,
        move(() => deps.api.payments.cancelClaimed(paymentId, { reason })),
      ),

    voidPayment: (orderId, paymentId, reason) =>
      run(
        'void',
        orderId,
        null,
        null,
        sensitive(() => deps.api.payments.void(paymentId, { reason })),
      ),

    refundPayment: (orderId, paymentId, reason) =>
      run(
        'refund',
        orderId,
        null,
        null,
        sensitive(() => deps.api.payments.refund(paymentId, { reason })),
      ),

    settled(orderId) {
      const state = store.getState();
      if (!(orderId in state.unsure)) return;
      for (const key of [...requestIds.keys()]) {
        if (key.startsWith(`${orderId}|`)) requestIds.delete(key);
      }
      const current = state.orderId === orderId && state.phase === 'unsure';
      store.setState({
        unsure: without(state.unsure, orderId),
        ...(current ? { phase: 'idle' as const, action: null, error: null } : {}),
      });
    },

    refresh,

    reset() {
      epoch += 1;
      inFlight = false;
      requestIds.clear();
      store.setState(initial());
    },
  };
}
