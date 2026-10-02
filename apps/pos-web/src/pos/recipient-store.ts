/**
 * The remembered recipients of the order screen (automatic customer memory, owner 2026-10-02) and
 * the list of buildings. State and rules live here, outside React, so they run without a DOM.
 *
 * - `recent`: the latest recipients (refetched when the order screen opens and after an order is
 *   placed). `matches`: the answer to the name typed in the field, after a short pause.
 * - Only what the endpoint returns is kept; nothing is derived or stored on the device.
 * - Names are personal data: this store logs nothing, and an error keeps only its code. A search
 *   that fails just leaves no matches.
 * - Every answer carries a sequence number, so an older answer never overwrites a newer one; on
 *   sign-out `reset()` forgets the names and drops answers still on their way (same epoch pattern
 *   as the cart), so the next person never sees them.
 * - Buildings come from the synced `delivery` setting. A setting that was never saved is not in
 *   the feed, so it is read once and put into the entity store as if it had come from the feed
 *   (a later real frame has a newer rev and wins).
 */
import { RECIPIENTS_DEFAULT_LIMIT, type RecipientDto } from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { deliveryBuildings } from './delivery-model.ts';

export const SEARCH_DEBOUNCE_MS = 250;

export interface RecipientState {
  recent: RecipientDto[];
  /** The answer to the typed name; null when nothing is typed. */
  matches: RecipientDto[] | null;
  /** The last read of the building list failed (and none has arrived since). */
  buildingsFailed: boolean;
}

export interface RecipientDeps {
  api: {
    recipients: { list: ApiClient['recipients']['list'] };
    settings: { delivery: ApiClient['settings']['delivery'] };
  };
  entities: EntityStore;
  debounceMs?: number;
}

export interface RecipientStore extends ReadableStore<RecipientState> {
  /** Reads the latest recipients (call when the order screen opens and after an order). */
  refresh(): Promise<void>;
  /** The text typed in the name field. Debounced; blank means "no search". */
  search(text: string): void;
  /** Makes sure the buildings are in the entity store. */
  ensureBuildings(): Promise<void>;
  /** Sign-out: forgets the names and drops any answer still on its way. */
  reset(): void;
}

export function createRecipientStore(deps: RecipientDeps): RecipientStore {
  const debounceMs = deps.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const store = createStore<RecipientState>({ recent: [], matches: null, buildingsFailed: false });
  let epoch = 0;
  let recentSeq = 0;
  let searchSeq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loadingBuildings: Promise<void> | null = null;

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    async refresh() {
      const mine = ++recentSeq;
      const startedIn = epoch;
      try {
        const { recipients } = await deps.api.recipients.list({ limit: RECIPIENTS_DEFAULT_LIMIT });
        if (epoch === startedIn && mine === recentSeq) store.setState({ recent: recipients });
      } catch {
        // A convenience only: keep what is shown. The error is not kept (it could carry a name).
      }
    },

    search(text) {
      cancelTimer();
      const typed = text.trim();
      const mine = ++searchSeq;
      if (typed === '') {
        store.setState({ matches: null });
        return;
      }
      const startedIn = epoch;
      timer = setTimeout(() => {
        timer = null;
        void (async () => {
          let found: RecipientDto[] | null = null;
          try {
            found = (await deps.api.recipients.list({ q: typed, limit: RECIPIENTS_DEFAULT_LIMIT }))
              .recipients;
          } catch {
            found = null;
          }
          if (epoch === startedIn && mine === searchSeq) store.setState({ matches: found });
        })();
      }, debounceMs);
    },

    ensureBuildings() {
      if (deliveryBuildings(deps.entities.getState().settings) !== null) return Promise.resolve();
      loadingBuildings ??= (async () => {
        store.setState({ buildingsFailed: false });
        try {
          const setting = await deps.api.settings.delivery();
          deps.entities.apply({
            type: 'settings.updated',
            id: 'delivery',
            rev: setting.rev,
            version: setting.version,
            data: setting.value,
          });
        } catch {
          // The screen says the list is missing and offers a retry.
          store.setState({ buildingsFailed: true });
        } finally {
          loadingBuildings = null;
        }
      })();
      return loadingBuildings;
    },

    reset() {
      epoch += 1;
      recentSeq += 1;
      searchSeq += 1;
      cancelTimer();
      store.setState({ recent: [], matches: null, buildingsFailed: false });
    },
  };
}
