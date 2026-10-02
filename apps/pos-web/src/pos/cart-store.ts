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
 *
 * Offline (the outbox, 02 §8): when the device is known to be offline, or the request got no
 * answer, the order is saved to the outbox with the SAME request id and body and the cart is free
 * again; the outbox replays it, and the server's idempotency makes a duplicate impossible even if
 * the first attempt did arrive. "Saved" is only said once the device has written it. When it
 * cannot be written (storage refused, queue full) nothing is pretended: an unsent order stays
 * editable on screen, and an order that may exist stays locked as `unsure`, as before.
 *
 * Two stores are made from this file: the counter's (storefront entrance deliveries) and the
 * platform one (Grab and LINE MAN orders keyed in by hand: no recipient, the platform's order code
 * and channel instead). They share every rule above and nothing else.
 */
import {
  buildingNameSchema,
  type OrderChannel,
  type OrderDto,
  type RecipientDto,
  recipientKey,
  recipientNameSchema,
} from '@sds/shared';
import type { ApiClient, NewOrderInput } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import type { Activity } from '../lib/activity.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { newUuid } from '../platform/ids.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { type CartLine, priceCart } from './cart-pricing.ts';
import { deliveryBuildings } from './delivery-model.ts';
import { snapshotOrder } from './outbox-model.ts';
import type { EnqueueResult, OutboxStore } from './outbox-store.ts';
import {
  PLATFORM_NOTE_MAX,
  type PlatformChannel,
  platformNote,
  platformRefSchema,
} from './platform-model.ts';

export type CartPhase = 'editing' | 'sending' | 'unsure';

/** Which kind of order this cart makes. */
export type CartMode = 'storefront' | 'platform';

/** Why an order could not be saved to the outbox. */
export type SaveError = Extract<EnqueueResult, { ok: false }>['reason'];

/**
 * A remembered recipient the staff tapped. It is only a link: the server finds or creates the
 * customer by building + name, and given an id it would RENAME that customer to whatever the order
 * says, so the id is sent only while the building and the name still match what was chosen.
 */
interface ChosenRecipient {
  customerId: string;
  building: string;
  nameKey: string;
}

export interface CartState {
  lines: CartLine[];
  /** Every order is an entrance delivery (owner, 2026-10-02): where, to whom, and other details. */
  deliveryBuilding: string;
  recipientName: string;
  deliveryNote: string;
  chosen: ChosenRecipient | null;
  /** The kitchen note, apart from the delivery details. */
  note: string;
  /** `storefront` at the counter; `grab` or `lineman` in the platform cart. */
  channel: OrderChannel;
  /** The platform's own order code (platform cart only). */
  platformRef: string;
  phase: CartPhase;
  clientRequestId: string | null;
  /** The last failed attempt, until the order changes or a new attempt starts. */
  error: ApiClientError | null;
  /** The order could not be written to the device's outbox, until it changes or is tried again. */
  saveError: SaveError | null;
}

export type SubmitOutcome =
  | { ok: true; order: OrderDto; replay: boolean }
  /** Saved on this device and waiting to be sent: `id` is the id its page uses until it syncs. */
  | { ok: true; queued: { id: string; label: string } }
  | { ok: false; reason: 'empty' | 'invalid' | 'deliveryRequired' | 'refRequired' | 'busy' }
  /** Not sent, or sent without an answer, and could not be saved either: see `cause`. */
  | { ok: false; reason: 'notSaved'; cause: SaveError }
  /** The person signed out while the request ran: its answer belongs to nobody and was dropped. */
  | { ok: false; reason: 'stale' }
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface CartDeps {
  api: { orders: { create: ApiClient['orders']['create'] } };
  entities: EntityStore;
  activity: Activity;
  /** Where an order goes when it cannot be sent; without one the cart behaves as before. */
  outbox?: Pick<OutboxStore, 'enqueueOrder' | 'isOffline'>;
  mode?: CartMode;
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
  setBuilding(value: string): void;
  setRecipientName(value: string): void;
  setDeliveryNote(value: string): void;
  /** Prefills building, name and details from a remembered recipient (all stay editable). */
  chooseRecipient(recipient: RecipientDto): void;
  setNote(value: string): void;
  /** Platform cart: Grab or LINE MAN. Another channel is another body, so another request id. */
  setChannel(channel: PlatformChannel): void;
  setPlatformRef(value: string): void;
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

const deliveryFilled = (state: Pick<CartState, 'deliveryBuilding' | 'recipientName'>) =>
  buildingNameSchema.safeParse(state.deliveryBuilding).success &&
  recipientNameSchema.safeParse(state.recipientName).success;

/** The chosen customer's id, while building and name still match what was chosen. */
function linkedCustomerId(
  state: Pick<CartState, 'chosen' | 'deliveryBuilding' | 'recipientName'>,
): string | undefined {
  const { chosen } = state;
  if (!chosen) return undefined;
  return state.deliveryBuilding.trim() === chosen.building &&
    recipientKey(state.recipientName) === chosen.nameKey
    ? chosen.customerId
    : undefined;
}

/** The request got no usable answer, so what it asked for (an order, a payment) may exist. */
export function mayHaveBeenCreated(error: ApiClientError): boolean {
  return (
    error.code === 'NETWORK' ||
    error.code === 'TIMEOUT' ||
    error.code === 'RESPONSE_INVALID' ||
    (error.status !== null && error.status >= 500)
  );
}

export function createCartStore(deps: CartDeps): CartStore {
  const newId = deps.newId ?? newUuid;
  const platform = deps.mode === 'platform';
  const initial = (channel: OrderChannel = platform ? 'grab' : 'storefront'): CartState => ({
    lines: [],
    deliveryBuilding: '',
    recipientName: '',
    deliveryNote: '',
    chosen: null,
    note: '',
    channel,
    platformRef: '',
    phase: 'editing',
    clientRequestId: null,
    error: null,
    saveError: null,
  });
  /** The next order after this one: nothing carried over, but the platform stays chosen. */
  const next = (): CartState => initial(platform ? store.getState().channel : undefined);
  const store = createStore<CartState>(initial());
  const lastChoices = new Map<string, readonly string[]>();
  let lineCounter = 0;
  let inFlight = false;
  /**
   * Bumped by `reset()` (sign-out). A request remembers the epoch it started in and, if it has
   * changed when the answer arrives, touches nothing: no order into the store, no `unsure` on the
   * next person's cart, and no clearing of the next request's `inFlight` guard.
   */
  let epoch = 0;
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
    store.setState({ ...patch, clientRequestId: null, error: null, saveError: null });
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

    setBuilding: (deliveryBuilding) => edit({ deliveryBuilding }),
    setRecipientName: (recipientName) => edit({ recipientName }),
    setDeliveryNote: (deliveryNote) => edit({ deliveryNote }),
    chooseRecipient(recipient) {
      // A building the shop no longer delivers to is not selected for the staff.
      const offered = deliveryBuildings(deps.entities.getState().settings);
      edit({
        deliveryBuilding:
          offered === null || offered.includes(recipient.building) ? recipient.building : '',
        recipientName: recipient.recipientName,
        deliveryNote: recipient.deliveryNote ?? '',
        chosen: {
          customerId: recipient.id,
          building: recipient.building,
          nameKey: recipientKey(recipient.recipientName),
        },
      });
    },
    setNote: (note) => edit({ note: platform ? note.slice(0, PLATFORM_NOTE_MAX) : note }),
    setChannel: (channel) => {
      if (platform) edit({ channel });
    },
    setPlatformRef: (platformRef) => edit({ platformRef }),

    clear() {
      if (inFlight) return;
      store.setState(next());
    },

    lastChoice: (itemId) => lastChoices.get(itemId),

    async submit() {
      if (inFlight) return { ok: false, reason: 'busy' };
      const state = store.getState();
      if (state.lines.length === 0) return { ok: false, reason: 'empty' };
      // An `unsure` order was already sent, so it may exist: it is retried exactly as it was
      // (same body, same id) even if the menu has changed since. A refusal then comes from the
      // server, which answers the original order for a known id.
      if (state.phase !== 'unsure') {
        if (platform) {
          if (!platformRefSchema.safeParse(state.platformRef).success) {
            return { ok: false, reason: 'refRequired' };
          }
        } else if (!deliveryFilled(state)) {
          // The server owns the list of buildings; the screen offers only that list.
          return { ok: false, reason: 'deliveryRequired' };
        }
        if (!priceCart(deps.entities.getState(), state.lines, state.channel).valid) {
          return { ok: false, reason: 'invalid' };
        }
      }

      inFlight = true;
      const clientRequestId = state.clientRequestId ?? newId();
      store.setState({ phase: 'sending', clientRequestId, error: null, saveError: null });
      const itemsOf = () =>
        state.lines.map((l) => ({
          menuItemId: l.itemId,
          qty: l.qty,
          modifierOptionIds: [...l.optionIds],
          ...(l.note.trim() === '' ? {} : { note: l.note.trim() }),
        }));
      const input: NewOrderInput = platform
        ? {
            channel: state.channel,
            fulfillment: 'platform_delivery',
            note: platformNote(state.channel as PlatformChannel, state.platformRef, state.note),
            items: itemsOf(),
          }
        : {
            channel: 'storefront',
            fulfillment: 'entrance_delivery',
            deliveryBuilding: state.deliveryBuilding.trim(),
            recipientName: state.recipientName.trim(),
            ...(state.deliveryNote.trim() === ''
              ? {}
              : { deliveryNote: state.deliveryNote.trim() }),
            ...(linkedCustomerId(state) ? { customerId: linkedCustomerId(state) } : {}),
            ...(state.note.trim() === '' ? {} : { note: state.note.trim() }),
            items: itemsOf(),
          };
      const startedIn = epoch;

      /**
       * Saves the order to the outbox under the same id and body. `sent`: a request already went
       * out and got no answer, so if saving fails the order stays locked as `unsure`; otherwise
       * nothing went out and it stays editable.
       */
      async function save(sent: ApiClientError | null): Promise<SubmitOutcome> {
        const outbox = deps.outbox;
        if (!outbox) {
          return { ok: false, reason: 'error', error: sent ?? new ApiClientError('NETWORK') };
        }
        const snapshot = snapshotOrder(deps.entities.getState(), state.lines, state.channel);
        const saved = await outbox.enqueueOrder({
          clientRequestId,
          body: input,
          lines: snapshot.lines,
          estimateSatang: snapshot.estimateSatang,
        });
        if (epoch !== startedIn) return { ok: false, reason: 'stale' };
        if (saved.ok) {
          store.setState(next());
          return { ok: true, queued: { id: saved.id, label: saved.label } };
        }
        store.setState({
          phase: sent ? 'unsure' : 'editing',
          error: sent,
          saveError: saved.reason,
        });
        return { ok: false, reason: 'notSaved', cause: saved.reason };
      }

      try {
        // Known offline: do not make the person wait for a timeout.
        // An order that was sent once and got no answer may exist: it stays `unsure` if the save fails.
        if (deps.outbox?.isOffline()) {
          return await save(
            state.phase === 'unsure' ? (state.error ?? new ApiClientError('NETWORK')) : null,
          );
        }
        const { order, replay } = await deps.api.orders.create(input, { clientRequestId });
        if (epoch !== startedIn) return { ok: false, reason: 'stale' };
        deps.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
        // The next order is somebody else's: the recipient is not carried over.
        store.setState(next());
        return { ok: true, order, replay };
      } catch (caught) {
        if (epoch !== startedIn) return { ok: false, reason: 'stale' };
        const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
        if (mayHaveBeenCreated(error) && deps.outbox) return await save(error);
        store.setState({ phase: mayHaveBeenCreated(error) ? 'unsure' : 'editing', error });
        return { ok: false, reason: 'error', error };
      } finally {
        // After a sign-out the guard belongs to whoever has sent a request since.
        if (epoch === startedIn) inFlight = false;
      }
    },

    reset() {
      epoch += 1;
      inFlight = false;
      lastChoices.clear();
      store.setState(initial());
    },
  };
}
