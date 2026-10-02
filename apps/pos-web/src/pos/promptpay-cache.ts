/**
 * The shop's PromptPay ID, saved on the device so a QR can be drawn with no connection (D-20).
 *
 * Where it lives: ONE record of the local store (`PROMPTPAY_CACHE_KEY`) and this closure. Never the
 * catalogue copy (its allow-list refuses `promptpay`), never the token store, never the outbox. The
 * reactive state holds only the last four digits and the times, so a component, a devtools view or
 * a log of the state cannot show the ID. It is not logged here, not put in an error and not part
 * of any address; the one place it leaves this file is `qr()`, which hands back the payload to
 * draw (see `offlineQr`).
 *
 * Fetched from `GET /v1/settings/promptpay` (a role with `settings.view`):
 * - after every sign-in or restored session, when the device can reach the server;
 * - when the connection comes back (this also renews the saved-at time the 24 hours count from);
 * - when a `settings.updated` frame for `promptpay` carries a rev newer than the saved one. The
 *   frame holds only the masked value, so it is a TRIGGER: the saved copy is marked stale at once
 *   (the old account must not be shown again) and stays stale until a fetch succeeds. A frame that
 *   is not newer is a catch-up replaying an old notice and changes nothing.
 *
 * Removed when: another person signs in (a record belongs to the person whose session fetched it),
 * the device is removed (`unregistered`), the record is damaged or from another schema, the server
 * answers 403 or says there is no ID any more, and on an explicit `clear()`. Signing out keeps the
 * record on the device for the same person, but nobody can draw from it while signed out.
 */
import type { Permission } from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { isApiClientError } from '../api/errors.ts';
import type { AuthPhase } from '../auth/auth-store.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import type { LocalStore } from '../platform/localStore.ts';
import type { ConnectionStatus } from '../realtime/connection.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import {
  type OfflineQr,
  offlineQr,
  PROMPTPAY_CACHE_KEY,
  PROMPTPAY_CACHE_SCHEMA,
  readSavedPromptpay,
  type SavedPromptpay,
  savedIdRefusal,
} from './offline-promptpay-model.ts';

export interface PromptpayCacheState {
  /** `none`: nothing usable saved; `stale`: a change notice arrived and is not confirmed yet. */
  phase: 'none' | 'ready' | 'stale';
  /** The last four characters of the saved ID, for the banner. */
  last4: string | null;
  /** When the server last confirmed the ID (epoch ms). */
  savedAt: number | null;
}

export interface PromptpayCacheDeps {
  api: { settings: Pick<ApiClient['settings'], 'promptpay'> };
  entities: Pick<EntityStore, 'getState' | 'subscribe'>;
  auth: ReadableStore<{
    phase: AuthPhase;
    session: { staff: { id: string }; permissions: readonly Permission[] } | null;
    device: { id: string } | null;
  }>;
  connection: ReadableStore<{ status: ConnectionStatus }>;
  lifecycle: Pick<Lifecycle, 'subscribe' | 'isOnline'>;
  localStore: () => Promise<LocalStore>;
  now?: () => number;
}

export interface PromptpayCache extends ReadableStore<PromptpayCacheState> {
  /** Follows sign-in, the connection and the change notices; returns the unbinder. */
  bind(): () => void;
  /** The QR for an amount (satang), or why none may be shown. Reads the clock every call. */
  qr(amountSatang: number | null): OfflineQr;
  /**
   * Whether this device may draw a QR at all right now, whatever the amount. `forbidden`: the
   * signed-in role may not read the ID (or nobody is signed in), so the offline QR does not exist
   * for it and screens must not promise it.
   */
  idStatus(): 'ok' | 'none' | 'stale' | 'tooOld' | 'forbidden';
  /** Removes the saved ID from the device and from memory. */
  clear(): Promise<void>;
}

const EMPTY: PromptpayCacheState = { phase: 'none', last4: null, savedAt: null };
/** A fetch that finds a newer notice behind it goes round again, at most this many times in a row. */
const MAX_ROUNDS = 3;

export function createPromptpayCache(deps: PromptpayCacheDeps): PromptpayCache {
  const now = deps.now ?? Date.now;
  const store = createStore<PromptpayCacheState>(EMPTY);

  let who: string | null = null;
  /** Bumped on every sign-in, sign-out and clear: work started in an older epoch touches nothing. */
  let epoch = 0;
  let allowed = false;
  let record: SavedPromptpay | null = null;
  let fetching = false;
  let again = false;

  const mayView = () =>
    deps.auth.getState().session?.permissions.includes('settings.view') ?? false;

  function publish() {
    store.setState(
      record === null
        ? EMPTY
        : {
            phase: record.stale ? 'stale' : 'ready',
            last4: record.target.idValue.slice(-4),
            savedAt: record.savedAt,
          },
    );
  }

  async function write(next: SavedPromptpay | null): Promise<void> {
    try {
      const opened = await deps.localStore();
      if (!opened.persistent) return;
      if (next === null) await opened.kv.remove(PROMPTPAY_CACHE_KEY);
      else await opened.kv.set(PROMPTPAY_CACHE_KEY, next);
    } catch {
      // The device refused: the copy in memory still serves this session.
    }
  }

  const online = () =>
    deps.lifecycle.isOnline() &&
    deps.connection.getState().status !== 'offline' &&
    deps.connection.getState().status !== 'reconnecting';

  /**
   * Is there a change notice newer than the saved copy? If so the copy is marked stale at once, on
   * the device too (the old account must not be shown again), and stays so until a fetch succeeds.
   */
  async function noteNewer(): Promise<boolean> {
    if (deps.entities.getState().promptpayRev <= (record?.rev ?? 0)) return false;
    if (record !== null && !record.stale) {
      record = { ...record, stale: true };
      publish();
      await write(record);
    }
    return true;
  }

  async function fetchNow(): Promise<void> {
    if (who === null || !allowed) return;
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    const startedIn = epoch;
    const person = who;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        again = false;
        let answer: Awaited<ReturnType<PromptpayCacheDeps['api']['settings']['promptpay']>>;
        try {
          answer = await deps.api.settings.promptpay();
        } catch (error) {
          if (epoch !== startedIn) return;
          // A refusal of the right to see it removes the copy; any other failure keeps it as it is.
          if (isApiClientError(error) && error.status === 403) await drop();
          return;
        }
        if (epoch !== startedIn) return;
        if (answer.value === null) {
          await drop();
          return;
        }
        record = {
          v: PROMPTPAY_CACHE_SCHEMA,
          staffId: person,
          savedAt: now(),
          rev: answer.rev,
          stale: false,
          target: answer.value,
        };
        publish();
        await write(record);
        if (epoch !== startedIn) return;
        // A change notice that arrived while this answer was on its way is newer than it.
        if (await noteNewer()) continue;
        if (!again) return;
      }
    } finally {
      fetching = false;
    }
  }

  async function drop(): Promise<void> {
    record = null;
    publish();
    await write(null);
  }

  async function begin(person: string, startedIn: number): Promise<void> {
    let found: SavedPromptpay | null = null;
    try {
      const opened = await deps.localStore();
      if (opened.persistent) {
        const raw = await opened.kv.get(PROMPTPAY_CACHE_KEY);
        if (raw !== undefined) {
          const parsed = readSavedPromptpay(raw);
          if (parsed && parsed.staffId === person) found = parsed;
          else await opened.kv.remove(PROMPTPAY_CACHE_KEY);
        }
      }
    } catch {
      // Nothing saved this time; the network brings it if it can.
    }
    if (epoch !== startedIn) return;
    record = found;
    publish();
    await noteNewer();
    if (epoch !== startedIn) return;
    if (online()) void fetchNow();
  }

  function stop() {
    epoch += 1;
    who = null;
    allowed = false;
    record = null;
    again = false;
    fetching = false;
    publish();
  }

  function follow() {
    const { phase, session } = deps.auth.getState();
    if (phase === 'unregistered') {
      // The device was removed: what it saved goes with it.
      stop();
      void write(null);
      return;
    }
    const person = phase === 'signedIn' && session ? session.staff.id : null;
    if (person === null) {
      if (who !== null) stop();
      return;
    }
    if (who === person) {
      allowed = mayView();
      if (allowed && record === null && online()) void fetchNow();
      return;
    }
    stop();
    who = person;
    allowed = mayView();
    if (!allowed) {
      // Still remove what another person saved, so it cannot be left for the next one.
      const startedIn = epoch;
      void deps.localStore().then(
        async (opened) => {
          const parsed = readSavedPromptpay(await opened.kv.get(PROMPTPAY_CACHE_KEY));
          if (epoch === startedIn && parsed && parsed.staffId !== person) await write(null);
        },
        () => undefined,
      );
      return;
    }
    void begin(person, epoch);
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    qr: (amountSatang) => offlineQr(allowed ? record : null, now(), amountSatang),
    idStatus: () => (allowed ? (savedIdRefusal(record, now()) ?? 'ok') : 'forbidden'),
    async clear() {
      epoch += 1;
      record = null;
      fetching = false;
      publish();
      await write(null);
    },
    bind() {
      let lastStatus = deps.connection.getState().status;
      const unsubscribeAuth = deps.auth.subscribe(follow);
      const unsubscribeConnection = deps.connection.subscribe(() => {
        const status = deps.connection.getState().status;
        if (status === 'online' && lastStatus !== 'online') void fetchNow();
        lastStatus = status;
      });
      // Only a CHANGE of the notice counts: every other row that arrives must not cost a request.
      let seenRev = deps.entities.getState().promptpayRev;
      const unsubscribeEntities = deps.entities.subscribe(() => {
        const rev = deps.entities.getState().promptpayRev;
        if (rev === seenRev) return;
        seenRev = rev;
        if (who === null || !allowed) return;
        const startedIn = epoch;
        void noteNewer().then((newer) => {
          if (newer && epoch === startedIn && online()) void fetchNow();
        });
      });
      const unsubscribeLifecycle = deps.lifecycle.subscribe({ online: () => void fetchNow() });
      follow();
      return () => {
        unsubscribeAuth();
        unsubscribeConnection();
        unsubscribeEntities();
        unsubscribeLifecycle();
        stop();
      };
    },
  };
}
