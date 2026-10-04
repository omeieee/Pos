/**
 * The state and rules of the devices and staff screens (owner only), outside React.
 *
 * - Every call here asks for a fresh step-up, the lists included, so each goes through
 *   `auth.runSensitive`. A step-up the person closes is not an error: a list reads as `locked` and
 *   the screen offers to ask again; a change is `cancelled`.
 * - Online only, like the other settings: nothing is queued.
 * - The staff routes take no idempotency key (the API refuses extra fields), so a create is never
 *   retried by itself. When its answer is lost (network or timeout) the outcome is `uncertain`, the
 *   list is read again, and the person sees whether the person was added.
 * - A staff change names the version the row had (`expectedVersion`); on VERSION_CONFLICT the list
 *   is read again and the person is told.
 * - An invite (D-23): the API answers the token once. It goes to the caller (the dialog that shows
 *   the link) and is never put in the state; the list keeps the row without it. A lost answer to a
 *   create is settled by reading the open invites again.
 * - One request per row at a time (the key is set in the same tick, so a double tap sends one).
 * - A PIN is passed through to the one call and kept nowhere. `reset()` (sign-out) bumps an epoch:
 *   an answer that belongs to an earlier epoch changes nothing.
 */
import type { CreateInviteResponse, DeviceDto, InviteDto, StaffDto, StaffRole } from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import type { ApiClientError } from '../api/errors.ts';
import type { Result } from '../auth/auth-store.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';

export interface ListSlot<T> {
  /** `locked`: the step-up was closed, nothing was asked of the server yet. */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'locked';
  error: ApiClientError | null;
  items: readonly T[];
}

/** The rows of each list the store reads. */
interface Rows {
  devices: DeviceDto;
  staff: StaffDto;
  invites: InviteDto;
}
type ListKind = keyof Rows;

export interface AdminState {
  devices: ListSlot<DeviceDto>;
  staff: ListSlot<StaffDto>;
  /** The open (and expired, not yet cleared) invites, without their tokens. */
  invites: ListSlot<InviteDto>;
  /** Keys of the rows (or the "add" action) with a request on its way. */
  pending: readonly string[];
}

export type AdminOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'offline' | 'busy' | 'stale' | 'cancelled' }
  | {
      ok: false;
      reason: 'error';
      error: ApiClientError;
      /** The list was read again because the row had changed on another device. */
      refreshed: boolean;
      /** The answer was lost, so the change may or may not have happened: look at the list. */
      uncertain: boolean;
    };

export interface AdminDeps {
  api: { admin: ApiClient['admin'] };
  lifecycle: Pick<Lifecycle, 'isOnline'>;
  auth: { runSensitive<T>(call: () => Promise<T>): Promise<Result<T>> };
}

export interface AdminStore extends ReadableStore<AdminState> {
  loadDevices(): Promise<void>;
  loadStaff(): Promise<void>;
  loadInvites(): Promise<void>;
  /**
   * The staff screen's two lists, one after the other so the owner confirms once: the invites are
   * only asked for after the staff list was read.
   */
  loadStaffScreen(): Promise<void>;
  revokeDevice(id: string): Promise<AdminOutcome<DeviceDto>>;
  createStaff(
    input: Parameters<ApiClient['admin']['createStaff']>[0],
  ): Promise<AdminOutcome<StaffDto>>;
  /** A name or active change, with the version the row had. */
  patchStaff(
    person: Pick<StaffDto, 'id' | 'version'>,
    change: { displayName?: string; active?: boolean },
  ): Promise<AdminOutcome<StaffDto>>;
  setStaffPin(id: string, pin: string): Promise<AdminOutcome<StaffDto>>;
  /** A role change; `pin` only when the new role needs one (`roleChangeNeedsPin`). */
  changeRole(
    person: Pick<StaffDto, 'id' | 'version'>,
    role: StaffRole,
    pin?: string,
  ): Promise<AdminOutcome<StaffDto>>;
  /** Makes an invite link. The `token` in the answer is shown once and not kept here. */
  createInvite(
    input: Parameters<ApiClient['admin']['createInvite']>[0],
  ): Promise<AdminOutcome<CreateInviteResponse>>;
  revokeInvite(id: string): Promise<AdminOutcome<void>>;
  reset(): void;
}

/** The `pending` keys: a row, or the "add a person" action. */
export const deviceKey = (id: string) => `device:${id}`;
export const staffKey = (id: string) => `staff:${id}`;
export const ADD_STAFF_KEY = 'staff:add';
export const ADD_INVITE_KEY = 'invite:add';
export const inviteKey = (id: string) => `invite:${id}`;

const emptyList = <T>(): ListSlot<T> => ({ status: 'idle', error: null, items: [] });
const initial = (): AdminState => ({
  devices: emptyList(),
  staff: emptyList(),
  invites: emptyList(),
  pending: [],
});

/** The answer to the request never came: it may have been processed. */
const answerLost = (error: ApiClientError) => error.code === 'NETWORK' || error.code === 'TIMEOUT';

const replaceRow = <T extends { id: string }>(items: readonly T[], row: T): T[] =>
  items.map((item) => (item.id === row.id ? row : item));

export function createAdminStore(deps: AdminDeps): AdminStore {
  const store = createStore<AdminState>(initial());
  let epoch = 0;
  const reading = new Map<ListKind, Promise<void>>();

  async function readList<K extends ListKind>(
    kind: K,
    fetchRows: () => Promise<readonly Rows[K][]>,
  ): Promise<void> {
    const startedIn = epoch;
    const put = (slot: AdminState[K]) => store.setState({ [kind]: slot } as Partial<AdminState>);
    const result = await deps.auth.runSensitive(fetchRows);
    if (epoch !== startedIn) return;
    const current = store.getState()[kind] as ListSlot<unknown>;
    if (result.ok) {
      put({ status: 'ready', error: null, items: result.value } as AdminState[K]);
    } else if (current.status !== 'ready') {
      // Rows already on screen stay; a first read that failed or was never confirmed shows why.
      put(
        (result.error === null
          ? { status: 'locked', error: null, items: [] }
          : { status: 'error', error: result.error, items: [] }) as AdminState[K],
      );
    }
  }

  function load<K extends ListKind>(
    kind: K,
    fetchRows: () => Promise<readonly Rows[K][]>,
  ): Promise<void> {
    if (!deps.lifecycle.isOnline()) return Promise.resolve();
    const running = reading.get(kind);
    if (running) return running;
    const current = store.getState()[kind] as ListSlot<unknown>;
    if (current.status !== 'ready') {
      store.setState({
        [kind]: { ...current, status: 'loading', error: null },
      } as Partial<AdminState>);
    }
    const started = readList(kind, fetchRows).finally(() => {
      reading.delete(kind);
    });
    reading.set(kind, started);
    return started;
  }

  const loadDevices = () => load('devices', async () => (await deps.api.admin.devices()).devices);
  const loadStaff = () => load('staff', async () => (await deps.api.admin.staff()).staff);
  const loadInvites = () => load('invites', async () => (await deps.api.admin.invites()).invites);
  async function loadStaffScreen(): Promise<void> {
    await loadStaff();
    if (store.getState().staff.status === 'ready') await loadInvites();
  }

  const pendingNow = () => store.getState().pending;

  /** One write: online, one at a time per key, inside the step-up, epoch-safe. */
  async function write<T>(
    key: string,
    send: () => Promise<T>,
    done: (value: T) => void,
    options: {
      /** Read this list again when the answer is one of these codes (the row changed meanwhile). */
      rereadOn?: { list: 'staff' | 'invites'; codes: readonly string[] };
      /** Read this list again when the answer was lost. */
      retryRead?: 'staff' | 'invites';
    } = {},
  ): Promise<AdminOutcome<T>> {
    if (!deps.lifecycle.isOnline()) return { ok: false, reason: 'offline' };
    if (pendingNow().includes(key)) return { ok: false, reason: 'busy' };
    const startedIn = epoch;
    store.setState({ pending: [...pendingNow(), key] });
    try {
      const result = await deps.auth.runSensitive(send);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      if (result.ok) {
        done(result.value);
        return { ok: true, value: result.value };
      }
      if (result.error === null) return { ok: false, reason: 'cancelled' };
      const error = result.error;
      const refreshed = options.rereadOn?.codes.includes(error.code) === true;
      const uncertain = options.retryRead !== undefined && answerLost(error);
      if (refreshed && options.rereadOn) await loadAgain(options.rereadOn.list);
      else if (uncertain && options.retryRead) await loadAgain(options.retryRead);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      return { ok: false, reason: 'error', error, refreshed, uncertain };
    } finally {
      if (epoch === startedIn) store.setState({ pending: pendingNow().filter((k) => k !== key) });
    }
  }

  /** Reads a list again after a conflict or a lost answer (the step-up is fresh by now). */
  async function loadAgain(list: 'staff' | 'invites'): Promise<void> {
    reading.delete(list);
    await (list === 'staff' ? loadStaff() : loadInvites());
  }

  const putStaff = (row: StaffDto) =>
    store.setState({
      staff: { ...store.getState().staff, items: replaceRow(store.getState().staff.items, row) },
    });

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    loadDevices,
    loadStaff,
    loadInvites,
    loadStaffScreen,

    revokeDevice: (id) =>
      write(
        deviceKey(id),
        () => deps.api.admin.revokeDevice(id),
        (row) =>
          store.setState({
            devices: {
              ...store.getState().devices,
              items: replaceRow(store.getState().devices.items, row),
            },
          }),
      ),

    createStaff: (input) =>
      write(
        ADD_STAFF_KEY,
        () => deps.api.admin.createStaff(input),
        (row) =>
          store.setState({
            staff: { ...store.getState().staff, items: [...store.getState().staff.items, row] },
          }),
        { retryRead: 'staff' },
      ),

    patchStaff: (person, change) =>
      write(
        staffKey(person.id),
        () => deps.api.admin.patchStaff(person.id, { expectedVersion: person.version, ...change }),
        putStaff,
        { rereadOn: { list: 'staff', codes: ['VERSION_CONFLICT'] } },
      ),

    // Not retried and not "uncertain": setting the same PIN again is harmless, the screen says so.
    setStaffPin: (id, pin) =>
      write(staffKey(id), () => deps.api.admin.setStaffPin(id, { pin }), putStaff),

    changeRole: (person, role, pin) =>
      write(
        staffKey(person.id),
        () =>
          deps.api.admin.changeStaffRole(person.id, {
            expectedVersion: person.version,
            role,
            ...(pin === undefined ? {} : { pin }),
          }),
        putStaff,
        { rereadOn: { list: 'staff', codes: ['VERSION_CONFLICT'] } },
      ),

    createInvite: (input) =>
      write(
        ADD_INVITE_KEY,
        () => deps.api.admin.createInvite(input),
        (answer) => {
          // The token stays out of the state: only the row is listed.
          const { token: _token, ...row } = answer;
          const current = store.getState().invites;
          store.setState({ invites: { ...current, items: [...current.items, row] } });
        },
        { retryRead: 'invites' },
      ),

    revokeInvite: (id) =>
      write(
        inviteKey(id),
        () => deps.api.admin.revokeInvite(id),
        () => {
          const current = store.getState().invites;
          store.setState({
            invites: { ...current, items: current.items.filter((i) => i.id !== id) },
          });
        },
        { rereadOn: { list: 'invites', codes: ['INVITE_ACCEPTED', 'NOT_FOUND'] } },
      ),

    reset() {
      epoch += 1;
      reading.clear();
      store.setState(initial());
    },
  };
}
