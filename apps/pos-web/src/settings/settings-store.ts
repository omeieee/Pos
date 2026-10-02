/**
 * The state and rules of the settings screens, outside React so they run (and are tested) without
 * a DOM.
 *
 * - Online only. Every write checks the device is online first and answers `offline` without
 *   calling the server; nothing is queued (a setting that lands hours late would overwrite a newer
 *   one, and a price or an opening hour is not something to apply behind the person's back).
 * - Every write carries the version the screen was built on (`expectedVersion`). On
 *   VERSION_CONFLICT the setting is read again and the person is told; nothing is retried by
 *   itself.
 * - One write per setting at a time (`pending`, set in the same tick, so a double tap sends one).
 * - A sensitive resource goes through `auth.runSensitive`: the step-up dialog opens first and a
 *   cancelled one is the outcome `cancelled`, not an error.
 * - `reset()` (sign-out) bumps an epoch: an answer that belongs to an earlier epoch changes nothing.
 */
import type {
  BusinessDaySettings,
  DeliveryPatchInput,
  DeliverySettings,
  NumberingPatchInput,
  OpeningHours,
  OpeningHoursPatchInput,
  PaymentsPatchInput,
  PaymentsSettings,
  PromptpayMasked,
  PromptpayPatchInput,
  ShopPatchInput,
  ShopSettings,
} from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import type { Result } from '../auth/auth-store.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';

/** What each setting holds and what a change to it looks like. */
export interface SettingsResources {
  shop: { value: ShopSettings; input: ShopPatchInput };
  hours: { value: OpeningHours; input: OpeningHoursPatchInput };
  numbering: { value: BusinessDaySettings; input: NumberingPatchInput };
  payments: { value: PaymentsSettings; input: PaymentsPatchInput };
  delivery: { value: DeliverySettings; input: DeliveryPatchInput };
  /** Masked, always: the ID in clear never reaches the store (the client reduces it). */
  promptpay: { value: PromptpayMasked | null; input: PromptpayPatchInput };
}
export type ResourceName = keyof SettingsResources;
export type ValueOf<K extends ResourceName> = SettingsResources[K]['value'];
export type InputOf<K extends ResourceName> = SettingsResources[K]['input'];

export interface Loaded<V> {
  value: V;
  /** 0: never saved, `value` is the default. */
  version: number;
}

export interface Slot<V> {
  /** `loading` only before the first answer; later reads keep `ready` so the screen does not blink. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: ApiClientError | null;
  loaded: Loaded<V> | null;
}

export type Slots = { [K in ResourceName]: Slot<ValueOf<K>> };

export interface SettingsState {
  slots: Slots;
  /** Settings with a write on its way. */
  pending: readonly ResourceName[];
}

export type SaveOutcome<V> =
  | { ok: true; value: Loaded<V> }
  | { ok: false; reason: 'offline' | 'busy' | 'stale' | 'cancelled' }
  | {
      ok: false;
      reason: 'error';
      error: ApiClientError;
      /** The setting was read again because it had changed on another device. */
      refreshed: boolean;
    };

export interface SettingsDeps {
  api: { settings: ApiClient['settings'] };
  lifecycle: Pick<Lifecycle, 'isOnline'>;
  auth: { runSensitive<T>(call: () => Promise<T>): Promise<Result<T>> };
}

export interface SettingsStore extends ReadableStore<SettingsState> {
  /** Reads one setting (a read already on its way is shared). */
  load(name: ResourceName): Promise<void>;
  /** Changes one setting with the version the screen saw. */
  save<K extends ResourceName>(name: K, input: InputOf<K>): Promise<SaveOutcome<ValueOf<K>>>;
  /** Sign-out: forgets everything and makes every answer still on its way harmless. */
  reset(): void;
}

interface Table<K extends ResourceName> {
  read(): Promise<Loaded<ValueOf<K>>>;
  save(input: InputOf<K>): Promise<Loaded<ValueOf<K>>>;
  /** Owner-only, step-up first. */
  sensitive: boolean;
}

const emptySlot = <V>(): Slot<V> => ({ status: 'idle', error: null, loaded: null });

const initial = (): SettingsState => ({
  slots: {
    shop: emptySlot(),
    hours: emptySlot(),
    numbering: emptySlot(),
    payments: emptySlot(),
    delivery: emptySlot(),
    promptpay: emptySlot(),
  },
  pending: [],
});

const toApiError = (caught: unknown): ApiClientError =>
  isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');

export function createSettingsStore(deps: SettingsDeps): SettingsStore {
  const store = createStore<SettingsState>(initial());
  let epoch = 0;
  const reading = new Map<ResourceName, Promise<void>>();

  /** Wraps one client resource: only the value and its version are kept. */
  const resource = <V, I>(
    api: {
      read(): Promise<{ value: V; version: number }>;
      save(input: I): Promise<{ value: V; version: number }>;
    },
    sensitive = false,
  ) => ({
    read: async () => {
      const { value, version } = await api.read();
      return { value, version };
    },
    save: async (input: I) => {
      const { value, version } = await api.save(input);
      return { value, version };
    },
    sensitive,
  });

  const s = deps.api.settings;
  const table: { [K in ResourceName]: Table<K> } = {
    shop: resource(s.shop),
    hours: resource(s.openingHours),
    numbering: resource(s.numbering),
    payments: resource(s.payments),
    delivery: resource(s.deliveryList),
    // Owner only, and the step-up comes first.
    promptpay: resource(s.promptpayMasked, true),
  };

  const putSlot = <K extends ResourceName>(name: K, slot: Slot<ValueOf<K>>) =>
    store.setState({ slots: { ...store.getState().slots, [name]: slot } });
  const slotOf = <K extends ResourceName>(name: K) =>
    store.getState().slots[name] as Slot<ValueOf<K>>;

  async function read<K extends ResourceName>(name: K): Promise<void> {
    const startedIn = epoch;
    try {
      const loaded = await (table[name] as Table<K>).read();
      if (epoch !== startedIn) return;
      putSlot(name, { status: 'ready', error: null, loaded });
    } catch (caught) {
      if (epoch !== startedIn) return;
      // What is already on screen stays; only a first read that failed becomes an error.
      const slot = slotOf(name);
      if (slot.status !== 'ready') {
        putSlot(name, { status: 'error', error: toApiError(caught), loaded: null });
      }
    }
  }

  function load(name: ResourceName): Promise<void> {
    const running = reading.get(name);
    if (running) return running;
    if (slotOf(name).status !== 'ready') {
      putSlot(name, { status: 'loading', error: null, loaded: slotOf(name).loaded as never });
    }
    const started = read(name).finally(() => {
      reading.delete(name);
    });
    reading.set(name, started);
    return started;
  }

  const pendingNow = () => store.getState().pending;

  async function save<K extends ResourceName>(
    name: K,
    input: InputOf<K>,
  ): Promise<SaveOutcome<ValueOf<K>>> {
    if (!deps.lifecycle.isOnline()) return { ok: false, reason: 'offline' };
    if (pendingNow().includes(name)) return { ok: false, reason: 'busy' };
    const startedIn = epoch;
    store.setState({ pending: [...pendingNow(), name] });
    try {
      const entry = table[name] as Table<K>;
      const call = () => entry.save(input);
      const result: Result<Loaded<ValueOf<K>>> = entry.sensitive
        ? await deps.auth.runSensitive(call)
        : await call().then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error: toApiError(error) }),
          );
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      if (result.ok) {
        putSlot(name, { status: 'ready', error: null, loaded: result.value });
        return { ok: true, value: result.value };
      }
      if (result.error === null) return { ok: false, reason: 'cancelled' };
      const refreshed = result.error.code === 'VERSION_CONFLICT';
      if (refreshed) await read(name);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      return { ok: false, reason: 'error', error: result.error, refreshed };
    } finally {
      if (epoch === startedIn) {
        store.setState({ pending: pendingNow().filter((key) => key !== name) });
      }
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    load,
    save,
    reset() {
      epoch += 1;
      reading.clear();
      store.setState(initial());
    },
  };
}
