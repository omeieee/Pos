/**
 * Kitchen printing from the staff app (P8): the reprint of an order and the list of recent print
 * jobs. State and rules live here, outside React, so they run (and are tested) without a DOM.
 *
 * - Online only. A reprint asks the server to queue a job for the print notebook; nothing is kept
 *   on the device for later (a paper ticket that comes out hours late is worse than none).
 * - One reprint per order at a time (`pending`, set in the same tick, so a double tap sends one).
 * - Each reprint has one idempotency key (`clientRequestId`). When an answer is lost (network,
 *   timeout, 5xx) the same key is used on the next tap, so the server answers the same job and
 *   never makes a second one. After a real answer (done, or a refusal) the key is dropped: the
 *   next tap is a new, deliberate reprint.
 * - The result is shown from the server's answer only. `PRINTING_OFF` is the server's switch.
 * - `reset()` (sign-out) bumps an epoch: an answer that belongs to an earlier epoch changes nothing.
 */
import type { PrintJobDto } from '@sds/shared';
import type { ApiClient } from '../../api/client.ts';
import { ApiClientError, isApiClientError } from '../../api/errors.ts';
import { createStore, type ReadableStore } from '../../lib/store.ts';
import { newUuid } from '../../platform/ids.ts';
import type { Lifecycle } from '../../platform/lifecycle.ts';
import { mayHaveBeenCreated } from '../cart/cart-store.ts';

export type ReprintResult =
  | { kind: 'done'; seq: number }
  | { kind: 'offline' }
  | { kind: 'error'; error: ApiClientError };

export interface JobsState {
  /** `loading` only before the first answer; a later read keeps what is shown. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  jobs: readonly PrintJobDto[];
}

export interface PrintState {
  /** Orders with a reprint on its way. */
  pending: readonly string[];
  /** The last outcome per order, until the next reprint of that order starts. */
  results: Readonly<Record<string, ReprintResult>>;
  jobs: JobsState;
}

export type ReprintOutcome =
  | { ok: true; seq: number }
  | { ok: false; reason: 'offline' | 'busy' | 'stale' }
  | { ok: false; reason: 'error'; error: ApiClientError };

export interface PrintDeps {
  api: { print: Pick<ApiClient['print'], 'jobs' | 'reprint'> };
  lifecycle: Pick<Lifecycle, 'isOnline'>;
  newId?: () => string;
}

export interface PrintStore extends ReadableStore<PrintState> {
  reprint(orderId: string): Promise<ReprintOutcome>;
  /** Forgets one order's outcome (the message was read). */
  dismiss(orderId: string): void;
  /** Reads the newest print jobs (a read already on its way is shared). */
  loadJobs(): Promise<void>;
  /** Sign-out: forgets everything and makes every answer still on its way harmless. */
  reset(): void;
}

const initial = (): PrintState => ({
  pending: [],
  results: {},
  jobs: { status: 'idle', jobs: [] },
});

export function createPrintStore(deps: PrintDeps): PrintStore {
  const store = createStore<PrintState>(initial());
  const newId = deps.newId ?? newUuid;
  let epoch = 0;
  /** The idempotency key of a reprint whose answer was lost, per order. */
  const keys = new Map<string, string>();
  let reading: Promise<void> | null = null;

  const without = <T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> => {
    const { [id]: _gone, ...rest } = record;
    return rest;
  };

  async function reprint(orderId: string): Promise<ReprintOutcome> {
    if (store.getState().pending.includes(orderId)) return { ok: false, reason: 'busy' };
    if (!deps.lifecycle.isOnline()) {
      store.setState({ results: { ...store.getState().results, [orderId]: { kind: 'offline' } } });
      return { ok: false, reason: 'offline' };
    }
    const startedIn = epoch;
    store.setState({
      pending: [...store.getState().pending, orderId],
      results: without(store.getState().results, orderId),
    });
    const key = keys.get(orderId) ?? newId();
    keys.set(orderId, key);
    const finish = (result?: ReprintResult) =>
      store.setState({
        pending: store.getState().pending.filter((id) => id !== orderId),
        ...(result ? { results: { ...store.getState().results, [orderId]: result } } : {}),
      });
    try {
      const { job } = await deps.api.print.reprint(orderId, key);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      keys.delete(orderId);
      finish({ kind: 'done', seq: job.seq });
      return { ok: true, seq: job.seq };
    } catch (caught) {
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
      // A lost answer keeps the key: the next tap cannot print twice.
      if (!mayHaveBeenCreated(error)) keys.delete(orderId);
      finish({ kind: 'error', error });
      return { ok: false, reason: 'error', error };
    }
  }

  function loadJobs(): Promise<void> {
    if (reading) return reading;
    const startedIn = epoch;
    const current = store.getState().jobs;
    if (current.status !== 'ready') store.setState({ jobs: { ...current, status: 'loading' } });
    reading = deps.api.print
      .jobs()
      .then(
        ({ jobs }) => {
          if (epoch === startedIn) store.setState({ jobs: { status: 'ready', jobs } });
        },
        () => {
          if (epoch !== startedIn) return;
          // What is already on screen stays; only a first read that failed becomes an error.
          const shown = store.getState().jobs;
          if (shown.status !== 'ready') store.setState({ jobs: { ...shown, status: 'error' } });
        },
      )
      .finally(() => {
        reading = null;
      });
    return reading;
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    reprint,
    dismiss(orderId) {
      if (orderId in store.getState().results) {
        store.setState({ results: without(store.getState().results, orderId) });
      }
    },
    loadJobs,
    reset() {
      epoch += 1;
      keys.clear();
      reading = null;
      store.setState(initial());
    },
  };
}
