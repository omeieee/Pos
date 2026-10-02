/**
 * The order being rung up. State and rules live here, outside React, so they run (and are tested)
 * without a DOM.
 *
 * Money: nothing here adds prices. The running estimate comes from `priceCart` (the shared pricing
 * rules); the request carries no prices at all; the real total is the server's, shown after the
 * POST from the order it returns.
 *
 * Creating the order, safely:
 * - one request id (`clientRequestId`, the idempotency key) belongs to one logical order. It is
 *   made at the first attempt and kept for retries, so a retry after a lost answer returns the
 *   original order instead of creating a second one;
 * - a second `submit()` while one is running is refused at once, in the same tick (a disabled
 *   button alone loses to two taps that land before React re-renders);
 * - when the answer never arrived (network, timeout, a garbled body, a server error) the order
 *   MAY exist, so the cart locks as `unsure`: it can only be retried (same id, same body) or
 *   cleared. Editing it would send a different body under the same id;
 * - when the server refused the order (a 4xx), nothing was created: the cart stays editable, and
 *   changing it makes a new request id.
 */
import type { OrderDto } from '@sds/shared';
import type { ApiClient, NewOrderInput } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import type { Activity } from '../lib/activity.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { newUuid } from '../platform/ids.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { type CartLine, priceCart } from './cart-pricing.ts';

/** What a counter can offer: pickup is for LINE orders. */
export type CounterFulfillment = 'dine_in' | 'takeaway' | 'room_delivery';
export type CartPhase = 'editing' | 'sending' | 'unsure';

export interface CartState {
  lines: CartLine[];
  fulfillment: CounterFulfillment;
  roomNo: string;
  note: string;
  phase: CartPhase;
  clientRequestId: string | null;
  /** The last failed attempt, until the order changes or a new attempt starts. */
  error: ApiClientError | null;
}

export type SubmitOutcome =
  | { ok: true; order: OrderDto; replay: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'roomRequired' | 'busy' }
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface CartDeps {
  api: { orders: { create: ApiClient['orders']['create'] } };
  entities: EntityStore;
  activity: Activity;
  /** Ids for the request id; tests fix them. */
  newId?: () => string;
}

export interface CartStore extends ReadableStore<CartState> {
  /** Adds a dish (merging with an identical line). Returns the line's key, or '' if refused. */
  addItem(input: {
    itemId: string;
    optionIds?: readonly string[];
    qty?: number;
    note?: string;
  }): string;
  setQty(key: string, qty: number): void;
  updateLine(
    key: string,
    change: { optionIds?: readonly string[]; note?: string; qty?: number },
  ): void;
  removeLine(key: string): void;
  setFulfillment(value: CounterFulfillment): void;
  setRoomNo(value: string): void;
  setNote(value: string): void;
  /** Empties the order (also from `unsure`: the person chose to discard it). */
  clear(): void;
  /** The choices last made for a dish, to repeat them with one tap. */
  lastChoice(itemId: string): readonly string[] | undefined;
  submit(): Promise<SubmitOutcome>;
  /** Sign-out: forgets the order and the remembered choices. */
  reset(): void;
}

const MAX_QTY = 99;
const MAX_LINES = 50;

const sameChoices = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const sameLine = (a: CartLine, b: CartLine) =>
  a.itemId === b.itemId && a.note === b.note && sameChoices(a.optionIds, b.optionIds);

/** The request got no usable answer, so the order may exist. */
function mayHaveBeenCreated(error: ApiClientError): boolean {
  return (
    error.code === 'NETWORK' ||
    error.code === 'TIMEOUT' ||
    error.code === 'RESPONSE_INVALID' ||
    (error.status !== null && error.status >= 500)
  );
}

export function createCartStore(deps: CartDeps): CartStore {
  const newId = deps.newId ?? newUuid;
  const initial = (): CartState => ({
    lines: [],
    fulfillment: 'dine_in',
    roomNo: '',
    note: '',
    phase: 'editing',
    clientRequestId: null,
    error: null,
  });
  const store = createStore<CartState>(initial());
  const lastChoices = new Map<string, readonly string[]>();
  let lineCounter = 0;
  let inFlight = false;
  let endBusy: (() => void) | null = null;

  // The app is busy (no update may reload the page) while an order is being built or sent.
  store.subscribe(() => {
    const { lines, phase } = store.getState();
    const busy = lines.length > 0 || phase !== 'editing';
    if (busy && !endBusy) endBusy = deps.activity.begin();
    if (!busy && endBusy) {
      endBusy();
      endBusy = null;
    }
  });

  const editable = () => store.getState().phase === 'editing';

  /** A change to the order: a new body, so a new request id and no stale error. */
  function edit(patch: Partial<CartState>) {
    if (!editable()) return;
    store.setState({ ...patch, clientRequestId: null, error: null });
  }

  function mergeInto(lines: CartLine[], line: CartLine): CartLine[] {
    const twin = lines.find((l) => l.key !== line.key && sameLine(l, line));
    if (!twin) return lines.map((l) => (l.key === line.key ? line : l));
    return lines
      .filter((l) => l.key !== line.key)
      .map((l) => (l.key === twin.key ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l));
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    addItem({ itemId, optionIds = [], qty = 1, note = '' }) {
      if (!editable()) return '';
      const { lines } = store.getState();
      const wanted: CartLine = { key: '', itemId, qty, optionIds: [...optionIds], note };
      const twin = lines.find((l) => sameLine(l, wanted));
      if (optionIds.length > 0) lastChoices.set(itemId, [...optionIds]);
      if (twin) {
        edit({
          lines: lines.map((l) =>
            l.key === twin.key ? { ...l, qty: Math.min(MAX_QTY, l.qty + qty) } : l,
          ),
        });
        return twin.key;
      }
      if (lines.length >= MAX_LINES) return '';
      const key = `l${++lineCounter}`;
      edit({ lines: [...lines, { ...wanted, key, qty: Math.min(MAX_QTY, qty) }] });
      return key;
    },

    setQty(key, qty) {
      const { lines } = store.getState();
      if (qty <= 0) return edit({ lines: lines.filter((l) => l.key !== key) });
      edit({
        lines: lines.map((l) => (l.key === key ? { ...l, qty: Math.min(MAX_QTY, qty) } : l)),
      });
    },

    updateLine(key, change) {
      if (!editable()) return;
      const { lines } = store.getState();
      const current = lines.find((l) => l.key === key);
      if (!current) return;
      const next: CartLine = {
        ...current,
        ...(change.optionIds ? { optionIds: [...change.optionIds] } : {}),
        ...(change.note === undefined ? {} : { note: change.note }),
        ...(change.qty === undefined ? {} : { qty: Math.min(MAX_QTY, Math.max(1, change.qty)) }),
      };
      if (change.optionIds && change.optionIds.length > 0)
        lastChoices.set(next.itemId, next.optionIds);
      edit({ lines: mergeInto(lines, next) });
    },

    removeLine(key) {
      edit({ lines: store.getState().lines.filter((l) => l.key !== key) });
    },

    setFulfillment: (fulfillment) => edit({ fulfillment }),
    setRoomNo: (roomNo) => edit({ roomNo }),
    setNote: (note) => edit({ note }),

    clear() {
      if (inFlight) return;
      store.setState(initial());
    },

    lastChoice: (itemId) => lastChoices.get(itemId),

    async submit() {
      if (inFlight) return { ok: false, reason: 'busy' };
      const state = store.getState();
      if (state.lines.length === 0) return { ok: false, reason: 'empty' };
      if (state.fulfillment === 'room_delivery' && state.roomNo.trim() === '') {
        return { ok: false, reason: 'roomRequired' };
      }
      if (!priceCart(deps.entities.getState(), state.lines).valid) {
        return { ok: false, reason: 'invalid' };
      }

      inFlight = true;
      const clientRequestId = state.clientRequestId ?? newId();
      store.setState({ phase: 'sending', clientRequestId, error: null });
      const input: NewOrderInput = {
        channel: 'storefront',
        fulfillment: state.fulfillment,
        ...(state.fulfillment === 'room_delivery' ? { roomNo: state.roomNo.trim() } : {}),
        ...(state.note.trim() === '' ? {} : { note: state.note.trim() }),
        items: state.lines.map((l) => ({
          menuItemId: l.itemId,
          qty: l.qty,
          modifierOptionIds: [...l.optionIds],
          ...(l.note.trim() === '' ? {} : { note: l.note.trim() }),
        })),
      };
      try {
        const { order, replay } = await deps.api.orders.create(input, { clientRequestId });
        deps.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
        store.setState({
          ...initial(),
          // The way of serving is a counter habit: keep it for the next order.
          fulfillment: state.fulfillment === 'room_delivery' ? 'dine_in' : state.fulfillment,
        });
        return { ok: true, order, replay };
      } catch (caught) {
        const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
        store.setState({ phase: mayHaveBeenCreated(error) ? 'unsure' : 'editing', error });
        return { ok: false, reason: 'error', error };
      } finally {
        inFlight = false;
      }
    },

    reset() {
      inFlight = false;
      lastChoices.clear();
      store.setState(initial());
    },
  };
}
