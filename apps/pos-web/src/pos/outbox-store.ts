/**
 * The offline outbox (02 §8): an order, or the cash taken for it, that could not reach the server
 * is kept on the device and sent when the connection returns. State and rules live here, outside
 * React, so they run (and are tested) without a DOM.
 *
 * Safe replay:
 * - an entry holds the exact request body and the `clientRequestId` of the first attempt. A replay
 *   sends those and nothing rebuilt, so the server (idempotent by that id and a hash of the body)
 *   answers the original order instead of making a second one. Even when the first attempt DID
 *   reach the server and only the answer was lost, the replay cannot duplicate;
 * - entries go oldest first and one at a time. A payment waits for its order: when the order
 *   syncs, the payment entry is rewritten with the server order id BEFORE the order entry is
 *   removed, so a crash in between replays the order (harmless) and never loses the link;
 * - the verdict of a failed replay decides what happens (see `classifyReplayError`): no answer or a
 *   server fault keeps the entry and backs off with jitter; a lost session pauses the queue; any
 *   other answer is the server refusing THIS entry, which then needs a person: it stays visible
 *   with its error code, with retry (not for a reused request id) and discard. Nothing is dropped
 *   silently, and a refusal never holds back unrelated entries (only its own payment is blocked);
 * - "saved" means the write to the device has completed and the store is persistent. A store that
 *   is the in-memory fallback, a write that fails (quota, private mode) and a full queue all say
 *   so, and the caller keeps the order on screen instead of pretending.
 *
 * Whose entries: see `ownsEntry`. Entries of another person are counted, never shown or sent.
 * Sign-out (`stop`) drops the in-memory view and bumps an epoch; the rows stay. A replay still in
 * flight when that happens still finishes its bookkeeping on the device but touches neither the
 * view nor the entity store of whoever signs in next.
 *
 * Offline PromptPay (D-20) is two dependent entries on the same chain: `create` (the pending
 * payment, sent once its order is on the server) and `confirm` (the staff member's "I checked the
 * bank app", sent once the create has answered). The create is checked against what the QR showed:
 * if the server charged another amount, or pays another (masked) account, the confirm is NOT sent
 * and the entry waits for a person: money was taken, and the server never auto-confirms (rule 2).
 *
 * The provisional label ("XK-07") is only a name for the waiting order. The server numbers the
 * order when it arrives; the label is not kept after the sync.
 */
import type { OrderDto, PaymentResult, RealtimeFrame } from '@sds/shared';
import type { ApiClient, NewOrderInput } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import type { AuthPhase } from '../auth/auth-store.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { newUuid } from '../platform/ids.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import type { LocalStore, OutboxEntry } from '../platform/localStore.ts';
import type { ConnectionStatus } from '../realtime/connection.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import {
  backoffMs,
  cashEntry,
  classifyReplayError,
  dependentIds,
  ERROR_NOT_UNDERSTOOD,
  ERROR_QR_AMOUNT,
  ERROR_QR_TARGET,
  errorCodeOf,
  KIND_CASH,
  KIND_ORDER,
  KIND_PROMPTPAY,
  KIND_PROMPTPAY_CONFIRM,
  MAX_QUEUE,
  type OrderPayload,
  orderEntry,
  orderPayloadOf,
  ownsEntry,
  type PaymentPayload,
  type PromptpayCreatePayload,
  paymentPayloadOf,
  promptpayConfirmEntry,
  promptpayConfirmPayloadOf,
  promptpayCreateEntry,
  promptpayCreatePayloadOf,
  provisionalLabel,
  purgeableIds,
  type QueueItem,
  recoveryCountsOf,
  toQueueItems,
} from './outbox-model.ts';
import { framesOf } from './payment-store.ts';

export interface Who {
  staffId: string;
  deviceId: string;
}

export interface OutboxState {
  /** The local store has been opened and read for the signed-in person. */
  ready: boolean;
  /** False: nothing can be saved on this device (private mode, blocked site data). */
  persistent: boolean;
  /** The device or the connection is down: new work is queued without trying the network. */
  offline: boolean;
  /** The signed-in person's entries, oldest first. */
  items: QueueItem[];
  /** Entries on this device that belong to other people: a count, never contents. */
  othersCount: number;
  /** What the owner's last take-over or clear did on this device (counts only), until sign-out. */
  recovered: { action: 'takeOver' | 'clear'; count: number; failed: number } | null;
  /** Other people's entries that were older than 14 days and were removed at sign-in (a count only). */
  purgedCount: number;
  /**
   * An entry the owner took over is waiting for the owner's step-up (the server wants a fresh one
   * to accept a name on a sale). Nothing was dropped: the entry stays and goes once it passes.
   */
  stepUpNeeded: boolean;
  /** Order entry id -> the server order id it became, for this run (so its page can follow). */
  synced: Readonly<Record<string, string>>;
}

export type EnqueueResult =
  | { ok: true; id: string; label: string; replaced?: true }
  | { ok: false; reason: 'storage' | 'full' | 'noSession' | 'orderGone' | 'busy' };

/** The result of the owner's recovery actions: how many entries were handled and how many were not. */
export type RecoverResult =
  | { ok: true; count: number; failed: number }
  | { ok: false; reason: 'forbidden' | 'noSession' | 'offline' }
  /** The server did not accept the report, so nothing on the device was touched. */
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface OutboxDeps {
  api: {
    orders: { create: ApiClient['orders']['create'] };
    payments: Pick<ApiClient['payments'], 'create' | 'confirm'>;
    /** The owner's take-over or clear is reported here first, so it is audited. */
    devices: Pick<ApiClient['devices'], 'outboxRecovery'>;
  };
  entities: Pick<EntityStore, 'apply' | 'applyMany'>;
  auth: ReadableStore<{
    phase: AuthPhase;
    session: { staff: { id: string; role?: string } } | null;
    device: { id: string } | null;
  }> & {
    /** Opens the step-up dialog; true once it passed. Without it an entry that needs one just waits. */
    requestStepUp?: () => Promise<boolean>;
  };
  lifecycle: Lifecycle;
  connection: ReadableStore<{ status: ConnectionStatus }>;
  localStore: () => Promise<LocalStore>;
  now?: () => number;
  random?: () => number;
  newId?: () => string;
}

export interface NewQueuedOrder {
  /** The idempotency key of this order: the one the first attempt used. */
  clientRequestId: string;
  /** The body as it was sent the first time; replayed as it is. */
  body: NewOrderInput;
  lines: OrderPayload['lines'];
  estimateSatang: number | null;
}

export interface NewQueuedCash {
  /** An order entry that has not synced, or an order the server has. */
  target: PaymentPayload['target'];
  tenderedSatang: number;
  /** What the change was shown against (an estimate for an order not synced yet). */
  totalSatang: number | null;
  label: string;
}

export interface NewQueuedPromptpay {
  /** An order entry that has not synced, or an order the server has. */
  target: PromptpayCreatePayload['target'];
  /** The amount the QR showed: an estimate for an order not synced yet, else the server's total. */
  qrAmountSatang: number;
  amountKind: PromptpayCreatePayload['amountKind'];
  /** The account the QR paid, masked (`******5678`): the only trace of the ID that is kept. */
  qrTargetMasked: string;
  label: string;
}

export interface OutboxStore extends ReadableStore<OutboxState> {
  /** Follows sign-in: opens and replays while a person is signed in, stops on sign-out. */
  bind(): () => void;
  /** The device or the connection is down right now. */
  isOffline(): boolean;
  enqueueOrder(input: NewQueuedOrder): Promise<EnqueueResult>;
  enqueueCash(input: NewQueuedCash): Promise<EnqueueResult>;
  /**
   * The customer paid by an offline QR and the staff member checked the bank app: saves the create
   * and the confirm of the PromptPay payment behind its order. Nothing is sent from here and nothing
   * counts as paid until the server confirms.
   */
  enqueuePromptpay(input: NewQueuedPromptpay): Promise<EnqueueResult>;
  /** A refused entry is sent again under the same id (not for a reused request id). */
  retry(id: string): Promise<void>;
  /** Removes a refused entry, and the payment entries that wait for it. */
  discard(id: string): Promise<void>;
  /** Try now (a person tapped "send now"). */
  kick(): void;
  /** Asks the owner for the step-up an entry is waiting for, and sends it when it passes. */
  confirmOwner(): Promise<void>;
  /**
   * Owner only (the caller asks for the step-up first): the entries other people left on this device
   * become the owner's and replay under the owner's session. The server records the owner as the
   * creator of those orders and the one who took the cash.
   */
  takeOverOthers(): Promise<RecoverResult>;
  /** Owner only (after the step-up): deletes the entries other people left on this device. */
  clearOthers(): Promise<RecoverResult>;
}

const SEQ_KEY = 'outbox.seq';
/** After a lost session the queue looks again at this interval, in case nothing signed us out. */
const PAUSED_RETRY_MS = 30_000;
/** A step-up that passed this recently and was still refused is not asked for again by itself. */
const OWNER_LOOP_GUARD_MS = 10_000;

export function createOutboxStore(deps: OutboxDeps): OutboxStore {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const newId = deps.newId ?? newUuid;

  const store = createStore<OutboxState>({
    ready: false,
    persistent: true,
    offline: false,
    items: [],
    othersCount: 0,
    purgedCount: 0,
    stepUpNeeded: false,
    recovered: null,
    synced: {},
  });

  let who: Who | null = null;
  /** Bumped on every sign-in and sign-out: work started in an older epoch touches nothing. */
  let epoch = 0;
  let storePromise: Promise<LocalStore> | null = null;
  let local: LocalStore | null = null;
  /** The signed-in person's rows, oldest first. */
  let mine: OutboxEntry[] = [];
  const attempts = new Map<string, number>();
  const dueAt = new Map<string, number>();
  /** Entries whose request is on its way right now. */
  const inFlight = new Set<string>();
  /** Entries that need the owner's step-up before the server takes them (see `stepUpNeeded`). */
  const awaitingOwner = new Set<string>();
  /** The step-up dialog is open for them right now. */
  let askingOwner = false;
  /** When a step-up last passed for them: a "still required" right after it must not loop the dialog. */
  let ownerPassedAt = Number.NEGATIVE_INFINITY;
  /** After a 429: nothing is sent before this time, whatever else happens (a queue-wide wait). */
  let notBefore = 0;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises the writes that read-modify-write (the counter, the cap). */
  let writes: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task, task);
    writes = next.catch(() => undefined);
    return next;
  };

  const ensureStore = (): Promise<LocalStore> => {
    storePromise ??= deps.localStore();
    return storePromise;
  };

  const lifecycleOffline = () => !deps.lifecycle.isOnline();
  const isOffline = () => {
    const status = deps.connection.getState().status;
    return lifecycleOffline() || status === 'offline' || status === 'reconnecting';
  };

  function publish(extra: Partial<OutboxState> = {}) {
    store.setState({
      items: toQueueItems(mine, attempts),
      offline: isOffline(),
      stepUpNeeded: awaitingOwner.size > 0,
      ...extra,
    });
  }

  // ---------- Loading ----------

  /** Removes what nobody is coming for (see `purgeableIds`); a row that cannot be removed stays. */
  async function purgeOld(
    opened: LocalStore,
    all: OutboxEntry[],
    person: Who,
  ): Promise<{ rows: OutboxEntry[]; purged: number }> {
    const gone = new Set<string>();
    for (const id of purgeableIds(all, person, now())) {
      try {
        await opened.outbox.remove(id);
        gone.add(id);
      } catch {
        // It stays, is counted with the other people's entries and is tried again at next sign-in.
      }
    }
    return { rows: all.filter((r) => !gone.has(r.id)), purged: gone.size };
  }

  async function load(person: Who, startedIn: number): Promise<void> {
    let rows: OutboxEntry[] = [];
    let persistent = false;
    let purged = 0;
    try {
      const opened = await ensureStore();
      local = opened;
      persistent = opened.persistent;
      // Inside the write lock, like every other change that reads and then writes.
      ({ rows, purged } = await serial(async () => {
        const all = await opened.outbox.list();
        return purgeOld(opened, all, person);
      }));
    } catch {
      persistent = false;
    }
    if (epoch !== startedIn) return;
    mine = rows.filter((row) => ownsEntry(row, person));
    publish({
      ready: true,
      persistent,
      othersCount: rows.length - mine.length,
      purgedCount: purged,
    });
    void pump();
  }

  // ---------- The worker ----------

  function nextDue(): OutboxEntry | undefined {
    const at = now();
    if (at < notBefore) return undefined;
    return mine.find((entry) => {
      if (entry.state === 'attention') return false;
      if (awaitingOwner.has(entry.id)) return false;
      if ((dueAt.get(entry.id) ?? 0) > at) return false;
      if (entry.kind === KIND_CASH) {
        // A payment goes only once its order is known to the server.
        const payload = paymentPayloadOf(entry);
        return payload !== null && 'orderId' in payload.target;
      }
      if (entry.kind === KIND_PROMPTPAY) {
        const payload = promptpayCreatePayloadOf(entry);
        return payload !== null && 'orderId' in payload.target;
      }
      if (entry.kind === KIND_PROMPTPAY_CONFIRM) {
        // The confirm goes only after the create has answered and named the payment.
        const payload = promptpayConfirmPayloadOf(entry);
        return payload !== null && 'paymentId' in payload.target;
      }
      return entry.kind === KIND_ORDER;
    });
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (who === null || lifecycleOffline()) return;
    const at = now();
    const waiting = mine
      .filter((e) => e.state !== 'attention' && !awaitingOwner.has(e.id))
      .map((e) => dueAt.get(e.id))
      .filter((due): due is number => due !== undefined)
      .map((due) => Math.max(due, notBefore));
    // A queue-wide wait with entries behind it needs its own wake-up (a "send now" clears the
    // per-entry times but never the wait).
    if (notBefore > at && mine.some((e) => e.state !== 'attention')) waiting.push(notBefore);
    if (waiting.length === 0) return;
    const wait = Math.max(0, Math.min(...waiting) - at);
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, wait);
  }

  async function persist(entry: OutboxEntry): Promise<void> {
    try {
      await local?.outbox.put(entry);
    } catch {
      // The device refused the write. The view is right for now; after a reload the entry comes
      // back as it was and is replayed or refused again, which is harmless.
    }
  }

  const replaceMine = (entry: OutboxEntry) => {
    mine = mine.map((e) => (e.id === entry.id ? entry : e));
  };

  async function markRefused(entry: OutboxEntry, code: string, startedIn: number) {
    const refusedEntry: OutboxEntry = {
      ...entry,
      state: 'attention',
      lastError: code,
      attempts: (attempts.get(entry.id) ?? entry.attempts) + 1,
    };
    await persist(refusedEntry);
    if (epoch !== startedIn) return;
    replaceMine(refusedEntry);
    dueAt.delete(entry.id);
    publish();
  }

  /** The same payment, pointed at the server order instead of the order entry. */
  const relinked = (row: OutboxEntry, entryId: string, orderId: string): OutboxEntry => {
    if (row.kind === KIND_CASH) {
      const payload = paymentPayloadOf(row);
      if (!payload || !('entryId' in payload.target) || payload.target.entryId !== entryId)
        return row;
      return { ...row, payload: { ...payload, target: { orderId } } };
    }
    if (row.kind === KIND_PROMPTPAY) {
      const payload = promptpayCreatePayloadOf(row);
      if (!payload || !('entryId' in payload.target) || payload.target.entryId !== entryId)
        return row;
      return { ...row, payload: { ...payload, target: { orderId } } };
    }
    return row;
  };

  /**
   * The confirm behind a create that has answered: pointed at the payment the server made. When the
   * server's amount or account is not what the QR showed, the confirm is set to `attention` with
   * the reason and the server's amount, so it is never sent without a person.
   */
  const confirmLinked = (
    row: OutboxEntry,
    createId: string,
    result: PaymentResult,
    mismatch: string | null,
  ): OutboxEntry => {
    if (row.kind !== KIND_PROMPTPAY_CONFIRM) return row;
    const payload = promptpayConfirmPayloadOf(row);
    if (
      !payload ||
      !('createEntryId' in payload.target) ||
      payload.target.createEntryId !== createId
    )
      return row;
    const linked = {
      ...payload,
      target: { paymentId: result.payment.id, orderId: result.order.id },
      ...(mismatch === null ? {} : { serverAmountSatang: result.payment.amountSatang }),
    };
    return mismatch === null
      ? { ...row, payload: linked }
      : { ...row, payload: linked, state: 'attention', lastError: mismatch };
  };

  /**
   * The order reached the server: link its payments to it, then forget the entry. It runs inside
   * `serial()`, so saving cash for this order cannot land between the read and the removal: it
   * either is read here and linked, or it comes after and is pointed at the server order. If the
   * device cannot be read or a rewrite fails, the order entry STAYS (a replay of it is harmless,
   * the server answers the order it already has) and is tried again after a backoff.
   */
  function orderSynced(entry: OutboxEntry, order: OrderDto, startedIn: number): Promise<void> {
    return serial(async () => {
      try {
        const opened = local ?? (await ensureStore());
        for (const row of await opened.outbox.list()) {
          const linked = relinked(row, entry.id, order.id);
          if (linked !== row) await opened.outbox.put(linked);
        }
      } catch {
        if (epoch !== startedIn) return;
        const tries = (attempts.get(entry.id) ?? entry.attempts) + 1;
        attempts.set(entry.id, tries);
        dueAt.set(entry.id, now() + backoffMs(tries, random));
        publish();
        return;
      }
      try {
        await local?.outbox.remove(entry.id);
      } catch {
        // It stays on the device and is answered as a replay next time.
      }
      if (epoch !== startedIn) return;
      const frame: RealtimeFrame = {
        type: 'order.upserted',
        id: order.id,
        rev: order.rev,
        data: order,
      };
      deps.entities.apply(frame);
      mine = mine.filter((e) => e.id !== entry.id).map((e) => relinked(e, entry.id, order.id));
      attempts.delete(entry.id);
      dueAt.delete(entry.id);
      publish({ synced: { ...store.getState().synced, [entry.id]: order.id } });
    });
  }

  /**
   * The create answered. Its confirm is pointed at the payment BEFORE the create entry is removed
   * (a crash in between replays the create, which the server answers as the same payment), and is
   * held for a person when the amount or the account is not what the QR showed.
   */
  function promptpayCreated(
    entry: OutboxEntry,
    payload: PromptpayCreatePayload,
    result: PaymentResult,
    startedIn: number,
  ): Promise<void> {
    return serial(async () => {
      const mismatch =
        result.payment.amountSatang !== payload.qrAmountSatang
          ? ERROR_QR_AMOUNT
          : result.payment.promptpayTargetMasked !== payload.qrTargetMasked
            ? ERROR_QR_TARGET
            : null;
      try {
        const opened = local ?? (await ensureStore());
        for (const row of await opened.outbox.list()) {
          const linked = confirmLinked(row, entry.id, result, mismatch);
          if (linked !== row) await opened.outbox.put(linked);
        }
      } catch {
        if (epoch !== startedIn) return;
        const tries = (attempts.get(entry.id) ?? entry.attempts) + 1;
        attempts.set(entry.id, tries);
        dueAt.set(entry.id, now() + backoffMs(tries, random));
        publish();
        return;
      }
      try {
        await local?.outbox.remove(entry.id);
      } catch {
        // It stays on the device and is answered as a replay next time.
      }
      if (epoch !== startedIn) return;
      deps.entities.applyMany(framesOf(result));
      mine = mine
        .filter((e) => e.id !== entry.id)
        .map((e) => confirmLinked(e, entry.id, result, mismatch));
      attempts.delete(entry.id);
      dueAt.delete(entry.id);
      publish();
    });
  }

  async function paymentSynced(entry: OutboxEntry, frames: RealtimeFrame[], startedIn: number) {
    try {
      await local?.outbox.remove(entry.id);
    } catch {
      // see orderSynced
    }
    if (epoch !== startedIn) return;
    deps.entities.applyMany(frames);
    mine = mine.filter((e) => e.id !== entry.id);
    attempts.delete(entry.id);
    dueAt.delete(entry.id);
    publish();
  }

  /**
   * One replay. Returns whether the pass may go on to the next entry. Everything that decides what
   * is sent (the in-flight claim, the sent mark, the body) happens before the first `await`, so a
   * change to the entry either lands before this or is refused (`inFlight`, `sentAt`).
   */
  async function replay(waiting: OutboxEntry, startedIn: number): Promise<boolean> {
    inFlight.add(waiting.id);
    const entry = waiting.sentAt === undefined ? { ...waiting, sentAt: now() } : waiting;
    if (entry !== waiting) replaceMine(entry);
    try {
      // Written before the request leaves: from here on the server may have the entry.
      if (entry !== waiting) await persist(entry);
      return await send(entry, startedIn);
    } finally {
      inFlight.delete(waiting.id);
    }
  }

  /**
   * The person an owner took this entry over from, to be named on the request: only for an entry
   * that carries a name and only while the owner is signed in (the server refuses anyone else).
   */
  function namedOn(entry: OutboxEntry): string | undefined {
    if (entry.originalStaffId === undefined) return undefined;
    return deps.auth.getState().session?.staff.role === 'owner' ? entry.originalStaffId : undefined;
  }

  /**
   * The server wants a fresh owner step-up before it takes a named entry. The entry stays queued
   * and is skipped until the step-up passes; the pass goes on with the others (the dialog must
   * never hold up the queue). The dialog opens once, and not again right after a step-up that just
   * passed (a clock that disagrees with the server would otherwise loop it).
   */
  function waitForOwner(entry: OutboxEntry, startedIn: number) {
    awaitingOwner.add(entry.id);
    publish();
    if (now() - ownerPassedAt > OWNER_LOOP_GUARD_MS) void askOwner(startedIn);
  }

  async function askOwner(startedIn: number): Promise<void> {
    const ask = deps.auth.requestStepUp;
    if (!ask || askingOwner) return;
    askingOwner = true;
    let passed = false;
    try {
      passed = await ask();
    } catch {
      passed = false;
    } finally {
      askingOwner = false;
    }
    if (epoch !== startedIn) return;
    if (passed) {
      ownerPassedAt = now();
      awaitingOwner.clear();
      publish();
      void pump();
    }
  }

  async function send(entry: OutboxEntry, startedIn: number): Promise<boolean> {
    const named = namedOn(entry);
    try {
      if (entry.kind === KIND_ORDER) {
        const payload = orderPayloadOf(entry);
        if (!payload) {
          await markRefused(entry, ERROR_NOT_UNDERSTOOD, startedIn);
          return true;
        }
        const { order } = await deps.api.orders.create(
          named === undefined ? payload.body : { ...payload.body, originalStaffId: named },
          { clientRequestId: entry.id },
        );
        await orderSynced(entry, order, startedIn);
        return true;
      }
      if (entry.kind === KIND_PROMPTPAY) {
        const payload = promptpayCreatePayloadOf(entry);
        if (!payload || !('orderId' in payload.target)) {
          await markRefused(entry, ERROR_NOT_UNDERSTOOD, startedIn);
          return true;
        }
        const { result } = await deps.api.payments.create(
          payload.target.orderId,
          { method: 'promptpay' },
          { clientRequestId: entry.id },
        );
        await promptpayCreated(entry, payload, result, startedIn);
        return true;
      }
      if (entry.kind === KIND_PROMPTPAY_CONFIRM) {
        const payload = promptpayConfirmPayloadOf(entry);
        if (!payload || !('paymentId' in payload.target)) {
          await markRefused(entry, ERROR_NOT_UNDERSTOOD, startedIn);
          return true;
        }
        // The server answers 200 without a write when the payment is already confirmed, so a
        // confirm whose answer was lost is safe to send again. It takes no request id.
        const result = await deps.api.payments.confirm(payload.target.paymentId, {});
        await paymentSynced(entry, framesOf(result), startedIn);
        return true;
      }
      const payload = paymentPayloadOf(entry);
      if (!payload || !('orderId' in payload.target)) {
        await markRefused(entry, ERROR_NOT_UNDERSTOOD, startedIn);
        return true;
      }
      const { result } = await deps.api.payments.create(
        payload.target.orderId,
        {
          method: 'cash',
          tendered: payload.tenderedSatang,
          ...(named === undefined ? {} : { originalStaffId: named }),
        },
        { clientRequestId: entry.id },
      );
      await paymentSynced(entry, framesOf(result), startedIn);
      return true;
    } catch (error) {
      if (epoch !== startedIn) return false;
      if (named !== undefined && isApiClientError(error) && error.code === 'STEP_UP_REQUIRED') {
        waitForOwner(entry, startedIn);
        return true;
      }
      const verdict = classifyReplayError(error);
      if (verdict === 'refused') {
        await markRefused(entry, errorCodeOf(error), startedIn);
        return true;
      }
      if (verdict === 'rateLimited') {
        // The server named a wait: the whole queue honours it (the next entry would be limited too).
        const tries = (attempts.get(entry.id) ?? entry.attempts) + 1;
        attempts.set(entry.id, tries);
        const named = isApiClientError(error) ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
        const wait = Math.max(named, backoffMs(tries, random));
        dueAt.set(entry.id, now() + wait);
        notBefore = Math.max(notBefore, now() + named);
        publish();
        return false;
      }
      if (verdict === 'pause') {
        dueAt.set(entry.id, now() + PAUSED_RETRY_MS);
        publish();
        return false;
      }
      const tries = (attempts.get(entry.id) ?? entry.attempts) + 1;
      attempts.set(entry.id, tries);
      dueAt.set(entry.id, now() + backoffMs(tries, random));
      publish();
      // No answer at all: the others would fail the same way, so the pass ends. A server fault
      // belongs to this entry; the next one may be fine.
      return verdict === 'transient';
    }
  }

  async function pump(): Promise<void> {
    if (who === null) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const startedIn = epoch;
    try {
      do {
        again = false;
        for (;;) {
          if (epoch !== startedIn || lifecycleOffline()) break;
          const entry = nextDue();
          if (!entry) break;
          if (!(await replay(entry, startedIn))) break;
        }
      } while (again && epoch === startedIn);
    } finally {
      running = false;
      if (epoch === startedIn) schedule();
    }
  }

  /**
   * Looks at the queue now. `clearBackoffs` is for the moments that say the network is back or that
   * a person asked ("send now"): then every entry may go at once. A new entry or the app coming to
   * the front only looks, so entries still waiting out their backoff keep waiting. A 429's wait
   * (`notBefore`) is never skipped.
   */
  const kick = (clearBackoffs = true) => {
    if (clearBackoffs) for (const id of [...dueAt.keys()]) dueAt.delete(id);
    void pump();
  };

  // ---------- Saving ----------

  /** Writes the entry to the device; null when it is saved, else why not. */
  async function save(
    entry: OutboxEntry,
    startedIn: number,
  ): Promise<Extract<EnqueueResult, { ok: false }> | null> {
    const opened = await ensureStore().catch(() => null);
    if (!opened?.persistent) return { ok: false, reason: 'storage' };
    local = opened;
    try {
      if ((await opened.outbox.count()) >= MAX_QUEUE) return { ok: false, reason: 'full' };
      await opened.outbox.put(entry);
    } catch {
      return { ok: false, reason: 'storage' };
    }
    if (epoch === startedIn) {
      mine = [...mine, entry];
      publish();
      kick(false);
    }
    return null;
  }

  async function nextLabel(opened: LocalStore): Promise<number> {
    const current = (await opened.kv.get<number>(SEQ_KEY)) ?? 0;
    const next = Number.isInteger(current) && current >= 0 ? current + 1 : 1;
    await opened.kv.set(SEQ_KEY, next);
    return next;
  }

  const existing = (id: string) => mine.find((e) => e.id === id);

  const enqueueOrder: OutboxStore['enqueueOrder'] = (input) =>
    serial(async () => {
      const person = who;
      if (person === null) return { ok: false, reason: 'noSession' };
      const startedIn = epoch;
      const already = existing(input.clientRequestId);
      const alreadyPayload = already ? orderPayloadOf(already) : null;
      if (already && alreadyPayload)
        return { ok: true, id: already.id, label: alreadyPayload.label };
      const opened = await ensureStore().catch(() => null);
      if (!opened?.persistent) return { ok: false, reason: 'storage' };
      let label: string;
      try {
        label = provisionalLabel(person.deviceId, await nextLabel(opened));
      } catch {
        return { ok: false, reason: 'storage' };
      }
      const entry = orderEntry(
        input.clientRequestId,
        {
          body: input.body,
          label,
          lines: input.lines,
          estimateSatang: input.estimateSatang,
        },
        person,
        now(),
      );
      const saved = await save(entry, startedIn);
      return saved ?? { ok: true, id: entry.id, label };
    });

  /**
   * A cash entry is already waiting for this order. The same tender is the same entry. A different
   * tender replaces it only while the entry has never been sent (no sent mark, not in flight, not
   * refused): after that the first request may already be on the server, and a changed body under
   * the same request id would be refused as a reused key. The check and the in-memory change
   * happen in one step, so a replay cannot pick up the old tender in between.
   */
  async function retender(waiting: OutboxEntry, input: NewQueuedCash): Promise<EnqueueResult> {
    const payload = paymentPayloadOf(waiting);
    if (payload?.tenderedSatang === input.tenderedSatang) {
      return { ok: true, id: waiting.id, label: input.label };
    }
    const unsent =
      waiting.state !== 'attention' && waiting.sentAt === undefined && !inFlight.has(waiting.id);
    if (!payload || !unsent) return { ok: false, reason: 'busy' };
    const updated: OutboxEntry = {
      ...waiting,
      payload: {
        ...payload,
        tenderedSatang: input.tenderedSatang,
        totalSatang: input.totalSatang,
        changed: true,
      },
    };
    replaceMine(updated);
    try {
      await (local ?? (await ensureStore())).outbox.put(updated);
    } catch {
      replaceMine(waiting);
      publish();
      return { ok: false, reason: 'storage' };
    }
    publish();
    return { ok: true, id: waiting.id, label: input.label, replaced: true };
  }

  const enqueueCash: OutboxStore['enqueueCash'] = (input) =>
    serial(async () => {
      const person = who;
      if (person === null) return { ok: false, reason: 'noSession' };
      const startedIn = epoch;
      // An order entry that has synced since the screen was drawn is the server's order now. One
      // that is neither here nor known to have synced is gone: the cash would wait for nothing.
      let target = input.target;
      if ('entryId' in target) {
        const { entryId } = target;
        if (!mine.some((e) => e.id === entryId)) {
          const orderId = store.getState().synced[entryId];
          if (orderId === undefined) return { ok: false, reason: 'orderGone' };
          target = { orderId };
        }
      }
      // One payment per order: a PromptPay waiting for it means cash would collide with it.
      if (promptpayWaitingFor(target)) return { ok: false, reason: 'busy' };
      // One cash payment per order: asking again answers the one that is waiting.
      const wanted = JSON.stringify(target);
      const waiting = mine.find((e) => {
        if (e.kind !== KIND_CASH) return false;
        const payload = paymentPayloadOf(e);
        return payload !== null && JSON.stringify(payload.target) === wanted;
      });
      if (waiting) return retender(waiting, input);
      const entry = cashEntry(
        newId(),
        {
          target,
          tenderedSatang: input.tenderedSatang,
          label: input.label,
          totalSatang: input.totalSatang,
        },
        person,
        now(),
      );
      const saved = await save(entry, startedIn);
      return saved ?? { ok: true, id: entry.id, label: input.label };
    });

  /** The PromptPay create (or, once that has answered, confirm) already saved for this target. */
  function promptpayWaitingFor(target: PromptpayCreatePayload['target']): OutboxEntry | undefined {
    const wanted = JSON.stringify(target);
    return mine.find((e) => {
      if (e.kind === KIND_PROMPTPAY) {
        const payload = promptpayCreatePayloadOf(e);
        return payload !== null && JSON.stringify(payload.target) === wanted;
      }
      if (e.kind === KIND_PROMPTPAY_CONFIRM) {
        const payload = promptpayConfirmPayloadOf(e);
        return (
          payload !== null &&
          'orderId' in target &&
          'orderId' in payload.target &&
          payload.target.orderId === target.orderId
        );
      }
      return false;
    });
  }

  const enqueuePromptpay: OutboxStore['enqueuePromptpay'] = (input) =>
    serial(async () => {
      const person = who;
      if (person === null) return { ok: false, reason: 'noSession' };
      const startedIn = epoch;
      let target = input.target;
      if ('entryId' in target) {
        const { entryId } = target;
        if (!mine.some((e) => e.id === entryId)) {
          const orderId = store.getState().synced[entryId];
          if (orderId === undefined) return { ok: false, reason: 'orderGone' };
          target = { orderId };
        }
      }
      // One payment per order: the same method answers the one that is waiting, cash is refused.
      const waiting = promptpayWaitingFor(target);
      if (waiting) return { ok: true, id: waiting.id, label: input.label };
      const cashWaiting = mine.some((e) => {
        if (e.kind !== KIND_CASH) return false;
        const payload = paymentPayloadOf(e);
        return payload !== null && JSON.stringify(payload.target) === JSON.stringify(target);
      });
      if (cashWaiting) return { ok: false, reason: 'busy' };

      const opened = await ensureStore().catch(() => null);
      if (!opened?.persistent) return { ok: false, reason: 'storage' };
      const at = now();
      const create = promptpayCreateEntry(
        newId(),
        {
          target,
          qrAmountSatang: input.qrAmountSatang,
          amountKind: input.amountKind,
          qrTargetMasked: input.qrTargetMasked,
          label: input.label,
        },
        person,
        at,
      );
      const confirm = promptpayConfirmEntry(
        newId(),
        {
          target: { createEntryId: create.id },
          qrAmountSatang: input.qrAmountSatang,
          amountKind: input.amountKind,
          label: input.label,
        },
        person,
        at,
      );
      try {
        // Both need a place: a create without its confirm must never be left behind.
        if ((await opened.outbox.count()) + 2 > MAX_QUEUE) return { ok: false, reason: 'full' };
        await opened.outbox.put(create);
        try {
          await opened.outbox.put(confirm);
        } catch {
          await opened.outbox.remove(create.id).catch(() => undefined);
          return { ok: false, reason: 'storage' };
        }
      } catch {
        return { ok: false, reason: 'storage' };
      }
      local = opened;
      if (epoch === startedIn) {
        mine = [...mine, create, confirm];
        publish();
        kick(false);
      }
      return { ok: true, id: create.id, label: input.label };
    });

  // ---------- A person's choices ----------

  async function retry(id: string): Promise<void> {
    const entry = existing(id);
    const item = toQueueItems(mine, attempts).find((i) => i.id === id);
    if (!entry || !item || item.state !== 'attention' || !item.canRetry) return;
    const queued: OutboxEntry = { ...entry, state: 'queued' };
    delete queued.lastError;
    queued.attempts = 0;
    await persist(queued);
    replaceMine(queued);
    attempts.delete(id);
    dueAt.delete(id);
    publish();
    kick(false);
  }

  async function discard(id: string): Promise<void> {
    const item = toQueueItems(mine, attempts).find((i) => i.id === id);
    // Refused, or stuck (tried many times with no answer: it may even be on the server already).
    // Never one whose request is on its way.
    if (!item || (item.state !== 'attention' && !item.stuck) || inFlight.has(id)) return;
    // What waits for an entry goes with it: the payments of an order, and the confirm behind a create.
    const gone = new Set([id, ...dependentIds(mine, id)]);
    for (const goneId of gone) {
      try {
        await local?.outbox.remove(goneId);
      } catch {
        // see orderSynced
      }
      attempts.delete(goneId);
      dueAt.delete(goneId);
    }
    mine = mine.filter((e) => !gone.has(e.id));
    publish();
  }

  // ---------- The owner's recovery of other people's entries ----------

  /**
   * One pass over the rows that are not the signed-in owner's, inside the write lock. `act` handles
   * a row and says whether it worked; a row that fails stays where it is. Only the owner role may
   * run it: the role is the session's, not the caller's word.
   */
  function recoverOthers(
    action: 'takeOver' | 'clear',
    act: (opened: LocalStore, row: OutboxEntry, person: Who) => Promise<OutboxEntry | null>,
  ): Promise<RecoverResult> {
    return serial(async () => {
      const person = who;
      if (person === null) return { ok: false, reason: 'noSession' };
      if (deps.auth.getState().session?.staff.role !== 'owner') {
        return { ok: false, reason: 'forbidden' };
      }
      const startedIn = epoch;
      let opened: LocalStore;
      let others: OutboxEntry[];
      try {
        opened = local ?? (await ensureStore());
        others = (await opened.outbox.list()).filter((row) => !ownsEntry(row, person));
      } catch {
        // The device cannot be read: nothing was touched.
        return { ok: true, count: 0, failed: store.getState().othersCount };
      }
      if (others.length === 0) return { ok: true, count: 0, failed: 0 };
      // The server is told first and has to accept it (audit, alert): offline there is nobody to
      // tell, so nothing is done.
      if (isOffline()) return { ok: false, reason: 'offline' };
      try {
        await deps.api.devices.outboxRecovery(
          person.deviceId,
          { action: action === 'takeOver' ? 'take_over' : 'clear', ...recoveryCountsOf(others) },
          { clientRequestId: newId() },
        );
      } catch (error) {
        // A stale step-up is the caller's to answer (it asks and calls again); nothing was written.
        if (isApiClientError(error) && error.code === 'STEP_UP_REQUIRED') throw error;
        return {
          ok: false,
          reason: 'error',
          error: isApiClientError(error) ? error : new ApiClientError('UNKNOWN'),
        };
      }
      const handled: OutboxEntry[] = [];
      const handledIds = new Set<string>();
      for (const row of others) {
        try {
          const moved = await act(opened, row, person);
          handledIds.add(row.id);
          if (moved) handled.push(moved);
        } catch {
          // It stays as it was, with its owner, and is counted as failed.
        }
      }
      if (epoch === startedIn) {
        mine = [...mine, ...handled].sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );
        publish({
          othersCount: store.getState().othersCount - handledIds.size,
          recovered: {
            action,
            count: handledIds.size,
            failed: others.length - handledIds.size,
          },
        });
        if (handled.length > 0) kick(false);
      }
      return { ok: true, count: handledIds.size, failed: others.length - handledIds.size };
    });
  }

  const takeOverOthers = () =>
    recoverOthers('takeOver', async (opened, row, person) => {
      // Who rang it up stays on the row, so the replay can name them. Someone already named, or
      // the owner themselves on an older device id, is left as it is.
      const original =
        row.originalStaffId ??
        (row.staffId !== undefined && row.staffId !== person.staffId ? row.staffId : undefined);
      const taken: OutboxEntry = {
        ...row,
        staffId: person.staffId,
        deviceId: person.deviceId,
        ...(original === undefined ? {} : { originalStaffId: original }),
      };
      await opened.outbox.put(taken);
      return taken;
    });

  const clearOthers = () =>
    recoverOthers('clear', async (opened, row) => {
      await opened.outbox.remove(row.id);
      return null;
    });

  // ---------- Following sign-in, the network and the app ----------

  function stop() {
    epoch += 1;
    who = null;
    mine = [];
    attempts.clear();
    dueAt.clear();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    running = false;
    again = false;
    awaitingOwner.clear();
    askingOwner = false;
    ownerPassedAt = Number.NEGATIVE_INFINITY;
    store.setState({
      ready: false,
      items: [],
      othersCount: 0,
      purgedCount: 0,
      stepUpNeeded: false,
      recovered: null,
      synced: {},
    });
  }

  function start(person: Who) {
    stop();
    who = person;
    void load(person, epoch);
  }

  function follow() {
    const { phase, session, device } = deps.auth.getState();
    const next =
      phase === 'signedIn' && session && device
        ? { staffId: session.staff.id, deviceId: device.id }
        : null;
    if (next === null) {
      if (who !== null) stop();
    } else if (who?.staffId !== next.staffId || who.deviceId !== next.deviceId) {
      start(next);
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    isOffline,
    enqueueOrder,
    enqueueCash,
    enqueuePromptpay,
    retry,
    discard,
    kick: () => {
      // A person asked: an entry that was waiting for the owner tries again (and asks again).
      if (awaitingOwner.size > 0) {
        awaitingOwner.clear();
        publish();
      }
      kick(true);
    },
    confirmOwner: async () => {
      if (who === null) return;
      ownerPassedAt = Number.NEGATIVE_INFINITY;
      await askOwner(epoch);
    },
    takeOverOthers,
    clearOthers,
    bind() {
      const unsubscribeAuth = deps.auth.subscribe(follow);
      let lastStatus = deps.connection.getState().status;
      const unsubscribeConnection = deps.connection.subscribe(() => {
        const status = deps.connection.getState().status;
        publish();
        if (status === 'online' && lastStatus !== 'online') kick();
        lastStatus = status;
      });
      const unsubscribeLifecycle = deps.lifecycle.subscribe({
        online: () => {
          publish();
          kick();
        },
        offline: () => publish(),
        visible: () => kick(false),
      });
      follow();
      publish();
      return () => {
        unsubscribeAuth();
        unsubscribeConnection();
        unsubscribeLifecycle();
        stop();
      };
    },
  };
}
