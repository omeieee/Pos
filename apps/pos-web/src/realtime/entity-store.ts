/**
 * The client's copy of the server's rows (D-04, D-05 item 2, 02 §5). Fed by the WebSocket and by
 * `GET /v1/sync`, which send the same frames, so there is one reducer.
 *
 * Rules:
 * - Every entity is keyed by (family, id) and a frame is applied only if `frame.rev` is greater
 *   than the rev stored for that entity. The server hands out one global rev sequence, so a rev is
 *   comparable across entities, but ordering is only ever decided per entity. Replaying frames
 *   (the catch-up rewinds on purpose) is therefore harmless.
 * - `lastRev` is the highest rev APPLIED, plus the final `nextSince` of a finished catch-up
 *   (`advance`). It is never taken from a ping or from `serverRev`: those can include revisions
 *   that were not committed when the client looked.
 * - A group's embedded `options` are a convenience copy. The group is stored without them and each
 *   option is applied by its own rev, so a "sold out" toggle (which bumps only the option) can
 *   never be undone by an older group frame. Join options to groups with `groupsWithOptions` (selectors.ts).
 * - `alert.new_order` is not a row: it goes to `onAlert` listeners (the sound is a later slice),
 *   never into the maps and never moves `lastRev`.
 * - A map that did not change keeps its identity, so a selector on `orders` does not re-run when
 *   only the menu moved.
 *
 * The state is whatever the signed-in role may receive. `reset()` empties it on sign-out, so the
 * next person on the device never sees the previous role's rows.
 */
import type {
  CategoryDto,
  CustomerDto,
  GroupDto,
  ItemDto,
  OptionDto,
  OrderDto,
  PaymentDto,
  RealtimeFrame,
  SyncChange,
} from '@sds/shared';
import { createStore, type ReadableStore } from '../lib/store.ts';

export type GroupEntity = Omit<GroupDto, 'options'>;
export type SettingsEntry = Extract<SyncChange, { type: 'settings.updated' }>;
export type AlertFrame = Extract<RealtimeFrame, { type: 'alert.new_order' }>;

export interface EntityState {
  orders: ReadonlyMap<string, OrderDto>;
  payments: ReadonlyMap<string, PaymentDto>;
  categories: ReadonlyMap<string, CategoryDto>;
  items: ReadonlyMap<string, ItemDto>;
  groups: ReadonlyMap<string, GroupEntity>;
  options: ReadonlyMap<string, OptionDto>;
  customers: ReadonlyMap<string, CustomerDto>;
  /** By setting key (`shop`, `promptpay` ...), not by a UUID. */
  settings: ReadonlyMap<string, SettingsEntry>;
  lastRev: number;
  /**
   * The rev of the newest PromptPay setting frame applied (0: none yet). A QR that was built at an
   * older value must be rebuilt: compare this with the value you saw when you fetched it.
   */
  promptpayRev: number;
  /**
   * The highest rev among the rows put in by `hydrate` (a saved copy of the menu and settings).
   * They are not "caught up to" anything, so `lastRev` is untouched; the connection compares the
   * server's rev with this one too, to notice a server restored from a backup.
   */
  cachedRev: number;
}

type FamilyKey =
  | 'orders'
  | 'payments'
  | 'categories'
  | 'items'
  | 'groups'
  | 'options'
  | 'customers'
  | 'settings';

const emptyState = (): EntityState => ({
  orders: new Map(),
  payments: new Map(),
  categories: new Map(),
  items: new Map(),
  groups: new Map(),
  options: new Map(),
  customers: new Map(),
  settings: new Map(),
  lastRev: 0,
  promptpayRev: 0,
  cachedRev: 0,
});

export interface EntityStore extends ReadableStore<EntityState> {
  /** Applies one frame; true if the stored state changed. */
  apply(frame: RealtimeFrame): boolean;
  /** Applies frames in order and notifies once. */
  applyMany(frames: readonly RealtimeFrame[]): void;
  /**
   * Puts a saved copy of the menu and the settings in (start-up, before the network). Same rev rule
   * as `apply`, but `lastRev` does not move, so the catch-up still starts as for a fresh device and
   * brings in what was never saved (orders and payments are not taken from a saved copy at all).
   */
  hydrate(frames: readonly RealtimeFrame[]): void;
  /** Raises `lastRev` to the final `nextSince` of a catch-up. Never lowers it. */
  advance(rev: number): void;
  /** Forgets everything (sign-out, or a server restored from a backup). Alert listeners stay. */
  reset(): void;
  onAlert(listener: (frame: AlertFrame) => void): () => void;
}

export function createEntityStore(): EntityStore {
  const store = createStore<EntityState>(emptyState());
  /** `family:id` -> the rev applied for it. */
  let revs = new Map<string, number>();
  const alertListeners = new Set<(frame: AlertFrame) => void>();

  interface Draft {
    state: EntityState;
    cloned: Set<FamilyKey>;
    changed: boolean;
    /** A saved copy: record the rev as `cachedRev`, not `lastRev`. */
    saved?: boolean;
  }

  function put(draft: Draft, family: FamilyKey, id: string, entity: unknown, rev: number): boolean {
    const index = `${family}:${id}`;
    const stored = revs.get(index);
    if (stored !== undefined && rev <= stored) return false;
    revs.set(index, rev);
    if (!draft.cloned.has(family)) {
      draft.state = {
        ...draft.state,
        [family]: new Map(draft.state[family] as ReadonlyMap<string, unknown>),
      };
      draft.cloned.add(family);
    }
    (draft.state[family] as Map<string, unknown>).set(id, entity);
    if (draft.saved) {
      if (rev > draft.state.cachedRev) draft.state = { ...draft.state, cachedRev: rev };
    } else if (rev > draft.state.lastRev) {
      draft.state = { ...draft.state, lastRev: rev };
    }
    draft.changed = true;
    return true;
  }

  function alert(frame: AlertFrame): void {
    for (const listener of [...alertListeners]) {
      try {
        listener(frame);
      } catch {
        // one failing listener must not stop the others or the frames that follow
      }
    }
  }

  function applyTo(draft: Draft, frame: RealtimeFrame): boolean {
    switch (frame.type) {
      case 'alert.new_order':
        alert(frame);
        return false;
      case 'order.upserted':
        return put(draft, 'orders', frame.id, frame.data, frame.rev);
      case 'payment.upserted':
        return put(draft, 'payments', frame.id, frame.data, frame.rev);
      case 'customer.upserted':
        return put(draft, 'customers', frame.id, frame.data, frame.rev);
      case 'settings.updated': {
        const applied = put(draft, 'settings', frame.id, frame, frame.rev);
        if (applied && frame.id === 'promptpay') {
          draft.state = { ...draft.state, promptpayRev: frame.rev };
        }
        return applied;
      }
      case 'menu.upserted':
        switch (frame.kind) {
          case 'category':
            return put(draft, 'categories', frame.id, frame.data, frame.rev);
          case 'item':
            return put(draft, 'items', frame.id, frame.data, frame.rev);
          case 'option':
            return put(draft, 'options', frame.id, frame.data, frame.rev);
          case 'group': {
            const { options, ...group } = frame.data;
            const appliedGroup = put(draft, 'groups', frame.id, group, frame.rev);
            let appliedOption = false;
            for (const option of options) {
              appliedOption = put(draft, 'options', option.id, option, option.rev) || appliedOption;
            }
            return appliedGroup || appliedOption;
          }
        }
    }
  }

  function applyMany(frames: readonly RealtimeFrame[]): void {
    const draft: Draft = { state: store.getState(), cloned: new Set(), changed: false };
    for (const frame of frames) applyTo(draft, frame);
    if (draft.changed) store.setState(draft.state);
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    apply(frame) {
      const draft: Draft = { state: store.getState(), cloned: new Set(), changed: false };
      const applied = applyTo(draft, frame);
      if (draft.changed) store.setState(draft.state);
      return applied;
    },
    applyMany,
    hydrate(frames) {
      const draft: Draft = {
        state: store.getState(),
        cloned: new Set(),
        changed: false,
        saved: true,
      };
      for (const frame of frames) {
        if (frame.type === 'menu.upserted' || frame.type === 'settings.updated') {
          applyTo(draft, frame);
        }
      }
      if (draft.changed) store.setState(draft.state);
    },
    advance(rev) {
      if (rev > store.getState().lastRev) store.setState({ lastRev: rev });
    },
    reset() {
      revs = new Map();
      store.setState(emptyState());
    },
    onAlert(listener) {
      alertListeners.add(listener);
      return () => void alertListeners.delete(listener);
    },
  };
}
