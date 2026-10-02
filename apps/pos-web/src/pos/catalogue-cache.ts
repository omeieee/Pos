/**
 * A saved copy of the catalogue (the menu and the settings the order screen needs) on the device,
 * so that a reload with no connection still has a menu to take orders from (02 §8).
 *
 * What is kept, and what never is:
 * - kept: categories, items, option groups and options, and the settings in
 *   `CATALOGUE_SETTING_KEYS` (shop, hours, business day, payment methods, delivery buildings);
 * - never kept: orders, payments, customers, recipients, tokens, and the PromptPay ID (not even the
 *   masked one) or the co-pay scheme. The PromptPay ID has its own slice (D-20). The list is an
 *   allowlist on the way out AND on the way in, so a copy that was tampered with cannot bring any
 *   other row back.
 *
 * How it is used:
 * - read at sign-in, before anything waits for the network, and put into the entity store with
 *   `hydrate`: the usual sync then corrects it (a newer rev always wins), and a price from here is
 *   never authoritative, because the server prices every order;
 * - written after each change to those rows, debounced, in one row of the local store with a schema
 *   version and a saved-at time. Reading it does not rewrite it, so the time is the time of the data;
 * - dropped when a DIFFERENT person signs in, when the schema version differs, and when the copy is
 *   damaged. It is kept across a reload of the same person and across a sign-out.
 *
 * A reset of the entity store (sign-out) is not a change and never overwrites a good copy: nothing
 * is written while the store holds no items, and a pending write is dropped on sign-out.
 */
import {
  type CategoryDto,
  type GroupDto,
  type ItemDto,
  menuUpsertedFrameSchema,
  type OptionDto,
  type RealtimeFrame,
  settingsUpdatedFrameSchema,
} from '@sds/shared';
import { z } from 'zod';
import type { AuthPhase } from '../auth/auth-store.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { LocalStore } from '../platform/localStore.ts';
import type { EntityState, EntityStore } from '../realtime/entity-store.ts';

export const CATALOGUE_KEY = 'catalogue';
/** Bump when the shape of the saved copy changes: an older copy is then dropped, not read. */
export const CATALOGUE_SCHEMA = 1;
/** The synced settings the order screen reads. Never `promptpay` or `gov_copay`. */
export const CATALOGUE_SETTING_KEYS = [
  'shop',
  'opening_hours',
  'business_day',
  'payment_methods',
  'delivery',
] as const;
const DEBOUNCE_MS = 1500;

const blobSchema = z.object({
  v: z.number().int(),
  staffId: z.string().min(1),
  savedAt: z.number().int().nonnegative(),
  frames: z.array(z.union([menuUpsertedFrameSchema, settingsUpdatedFrameSchema])),
});

const allowedSetting = (id: string) => (CATALOGUE_SETTING_KEYS as readonly string[]).includes(id);

/** The frames of the catalogue in the entity store, ready to be saved. */
export function catalogueFrames(
  state: Pick<EntityState, 'categories' | 'items' | 'groups' | 'options' | 'settings'>,
): RealtimeFrame[] {
  const frames: RealtimeFrame[] = [];
  const menu = <T extends { id: string; rev: number }>(
    kind: 'category' | 'item' | 'option',
    rows: ReadonlyMap<string, T>,
  ) => {
    for (const row of rows.values()) {
      frames.push({ type: 'menu.upserted', kind, id: row.id, rev: row.rev, data: row } as never);
    }
  };
  menu<CategoryDto>('category', state.categories);
  menu<ItemDto>('item', state.items);
  menu<OptionDto>('option', state.options);
  for (const group of state.groups.values()) {
    // The options travel as their own rows, each with its own rev.
    const data: GroupDto = { ...group, options: [] };
    frames.push({ type: 'menu.upserted', kind: 'group', id: group.id, rev: group.rev, data });
  }
  for (const entry of state.settings.values()) {
    if (allowedSetting(entry.id)) frames.push(entry);
  }
  return frames;
}

/** What a saved copy holds if it can be trusted, else null. Only allowlisted frames are returned. */
export function readCatalogue(raw: unknown): {
  staffId: string;
  savedAt: number;
  frames: RealtimeFrame[];
} | null {
  const parsed = blobSchema.safeParse(raw);
  if (!parsed.success || parsed.data.v !== CATALOGUE_SCHEMA) return null;
  const frames = parsed.data.frames.filter(
    (frame) => frame.type === 'menu.upserted' || allowedSetting(frame.id),
  );
  return { staffId: parsed.data.staffId, savedAt: parsed.data.savedAt, frames };
}

export interface CatalogueState {
  /** The rows on screen came from the saved copy and the server has not answered yet. */
  fromCache: boolean;
  /** When the copy was written (epoch ms); null when there is none in use. */
  savedAt: number | null;
}

export interface CatalogueDeps {
  entities: Pick<EntityStore, 'getState' | 'subscribe' | 'hydrate'>;
  auth: ReadableStore<{ phase: AuthPhase; session: { staff: { id: string } } | null }>;
  /** `synced`: a catch-up has finished since the connection started. */
  connection: ReadableStore<{ synced: boolean }>;
  localStore: () => Promise<LocalStore>;
  now?: () => number;
  debounceMs?: number;
}

export interface CatalogueCache extends ReadableStore<CatalogueState> {
  /** Follows sign-in: reads the copy when someone signs in, keeps it up to date, stops on sign-out. */
  bind(): () => void;
}

type Families = Pick<EntityState, 'categories' | 'items' | 'groups' | 'options' | 'settings'>;
const familiesOf = (s: EntityState): Families => ({
  categories: s.categories,
  items: s.items,
  groups: s.groups,
  options: s.options,
  settings: s.settings,
});
const sameFamilies = (a: Families, b: Families) =>
  a.categories === b.categories &&
  a.items === b.items &&
  a.groups === b.groups &&
  a.options === b.options &&
  a.settings === b.settings;

export function createCatalogueCache(deps: CatalogueDeps): CatalogueCache {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const store = createStore<CatalogueState>({ fromCache: false, savedAt: null });

  let who: string | null = null;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Until the saved copy has been read, changes only note that something changed. */
  let ready = false;
  let changedBeforeReady = false;
  /** True while the saved copy is being put in: that is not a change to save. */
  let hydrating = false;
  let seen: Families = familiesOf(deps.entities.getState());

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function flush(startedIn: number) {
    if (who === null || epoch !== startedIn) return;
    const state = deps.entities.getState();
    // Never write an empty catalogue: that is a reset, not a menu.
    if (state.items.size === 0) return;
    const staffId = who;
    try {
      const opened = await deps.localStore();
      if (!opened.persistent || epoch !== startedIn) return;
      await opened.kv.set(CATALOGUE_KEY, {
        v: CATALOGUE_SCHEMA,
        staffId,
        savedAt: now(),
        frames: catalogueFrames(state),
      });
    } catch {
      // The device refused the write: the next change tries again. The menu on screen is unaffected.
    }
  }

  function schedule() {
    cancel();
    const startedIn = epoch;
    timer = setTimeout(() => {
      timer = null;
      void flush(startedIn);
    }, debounceMs);
  }

  function onEntities() {
    if (hydrating) return;
    const current = familiesOf(deps.entities.getState());
    if (sameFamilies(seen, current)) return;
    seen = current;
    if (who === null) return;
    if (!ready) {
      changedBeforeReady = true;
      return;
    }
    schedule();
  }

  async function load(person: string, startedIn: number) {
    try {
      const opened = await deps.localStore();
      if (opened.persistent) {
        const raw = await opened.kv.get(CATALOGUE_KEY);
        if (raw !== undefined) {
          const found = readCatalogue(raw);
          if (found && found.staffId === person && found.frames.length > 0) {
            if (epoch !== startedIn) return;
            hydrating = true;
            try {
              deps.entities.hydrate(found.frames);
            } finally {
              hydrating = false;
            }
            store.setState({
              fromCache: !deps.connection.getState().synced,
              savedAt: found.savedAt,
            });
          } else {
            // Another person's, an older schema or damaged: it is not used and not kept.
            await opened.kv.remove(CATALOGUE_KEY);
          }
        }
      }
    } catch {
      // No saved copy this time; the network brings the menu as before.
    }
    if (epoch !== startedIn) return;
    // What the copy put in is not a change to save.
    seen = familiesOf(deps.entities.getState());
    ready = true;
    if (changedBeforeReady) schedule();
  }

  function stop() {
    epoch += 1;
    cancel();
    who = null;
    ready = false;
    changedBeforeReady = false;
    store.setState({ fromCache: false, savedAt: null });
  }

  function follow() {
    const { phase, session } = deps.auth.getState();
    const next = phase === 'signedIn' && session ? session.staff.id : null;
    if (next === null) {
      if (who !== null) stop();
    } else if (who !== next) {
      stop();
      who = next;
      void load(next, epoch);
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    bind() {
      const unsubscribeAuth = deps.auth.subscribe(follow);
      const unsubscribeEntities = deps.entities.subscribe(onEntities);
      const unsubscribeConnection = deps.connection.subscribe(() => {
        if (deps.connection.getState().synced && store.getState().fromCache) {
          store.setState({ fromCache: false });
        }
      });
      follow();
      return () => {
        unsubscribeAuth();
        unsubscribeEntities();
        unsubscribeConnection();
        stop();
      };
    },
  };
}
