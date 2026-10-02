/**
 * The state and rules of the menu editor, outside React so they run (and are tested) without a DOM.
 *
 * - Online only. Every write checks the device is online first and answers `offline` without
 *   calling the server; nothing is queued (a menu edit that lands hours late would overwrite a
 *   newer one).
 * - The rows live in the entity store (the same copy the order screen sells from), so a change from
 *   another device shows here by itself and a saved change shows on the till at once. The editor
 *   reads archived rows too, so `load()` asks for them and puts them in with their own revs.
 * - Costs are the exception: they are in no DTO and in nothing the app saves. They are held here,
 *   in memory, for roles with `report.view`, and nowhere else.
 * - Every create has an idempotency key that belongs to the content: the same content tried again
 *   after a lost answer reuses its key (the server then returns the row the first try made); other
 *   content gets a new one. A refusal the server really gave ends the key.
 * - A patch carries the version the editor saw. On VERSION_CONFLICT or REORDER_SET_MISMATCH the
 *   rows are read again and the person is told; nothing is retried by itself.
 * - One request per row at a time (`pending`, set in the same tick, so a double tap sends one).
 * - `reset()` (sign-out) bumps an epoch: an answer that belongs to an earlier epoch changes nothing.
 */
import type {
  CategoryDto,
  GroupDto,
  ItemDto,
  OptionDto,
  RealtimeFrame,
  ReorderResponse,
} from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { newUuid } from '../platform/ids.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import { mayHaveBeenCreated } from '../pos/cart-store.ts';
import type { EntityStore } from '../realtime/entity-store.ts';
import { groupsWithOptions } from '../realtime/selectors.ts';
import type { GroupPatch, ItemPatch, OptionPatch } from './model.ts';
import { type PhotoEngine, PhotoError, type PhotoFailure, preparePhoto } from './photo-plan.ts';

export interface Costs {
  items: Readonly<Record<string, number>>;
  options: Readonly<Record<string, number>>;
}

export interface MenuEditorState {
  /** `loading` only before the first answer; later reads keep `ready` so the screen does not blink. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: ApiClientError | null;
  /** Estimated costs by id, for roles with `report.view`; null for everyone else. */
  costs: Costs | null;
  /** Keys of the rows (or lists) with a request on its way. */
  pending: readonly string[];
}

export type EditorOutcome<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; reason: 'offline' | 'busy' | 'stale' }
  | { ok: false; reason: 'photo'; failure: PhotoFailure }
  | {
      ok: false;
      reason: 'error';
      error: ApiClientError;
      /** The rows were read again because they had changed on another device. */
      refreshed: boolean;
    };

export type ReorderKind = 'categories' | 'items' | 'groups' | 'options';

export interface MenuEditorDeps {
  api: { menu: ApiClient['menu'] };
  entities: EntityStore;
  lifecycle: Pick<Lifecycle, 'isOnline'>;
  /** Does this person have `report.view`? Read each time: the person can change. */
  canSeeCosts: () => boolean;
  photoEngine: PhotoEngine;
  newId?: () => string;
}

export interface MenuEditorStore extends ReadableStore<MenuEditorState> {
  /** Reads the whole menu (archived rows too) and, when allowed, the costs. */
  load(): Promise<void>;

  createCategory(
    input: Parameters<ApiClient['menu']['createCategory']>[0],
  ): Promise<EditorOutcome<CategoryDto>>;
  patchCategory(
    id: string,
    patch: { expectedVersion: number; nameTh?: string; nameEn?: string | null },
  ): Promise<EditorOutcome<CategoryDto>>;
  setCategoryActive(
    category: Pick<CategoryDto, 'id' | 'version'>,
    active: boolean,
  ): Promise<EditorOutcome<CategoryDto>>;

  createItem(
    input: Parameters<ApiClient['menu']['createItem']>[0],
  ): Promise<EditorOutcome<ItemDto>>;
  patchItem(id: string, patch: ItemPatch): Promise<EditorOutcome<ItemDto>>;
  setItemAvailable(
    item: Pick<ItemDto, 'id' | 'version'>,
    isAvailable: boolean,
  ): Promise<EditorOutcome<ItemDto>>;
  setItemArchived(
    item: Pick<ItemDto, 'id' | 'version'>,
    archived: boolean,
  ): Promise<EditorOutcome<ItemDto>>;
  /** Re-encodes the chosen file (`photo-plan.ts`), then uploads it. */
  setPhoto(item: Pick<ItemDto, 'id'>, file: Blob): Promise<EditorOutcome<ItemDto>>;
  removePhoto(item: Pick<ItemDto, 'id'>): Promise<EditorOutcome<ItemDto>>;

  createGroup(
    input: Parameters<ApiClient['menu']['createGroup']>[0],
  ): Promise<EditorOutcome<GroupDto>>;
  patchGroup(id: string, patch: GroupPatch): Promise<EditorOutcome<GroupDto>>;
  setGroupArchived(
    group: Pick<GroupDto, 'id' | 'version'>,
    archived: boolean,
  ): Promise<EditorOutcome<GroupDto>>;

  createOption(
    groupId: string,
    input: Parameters<ApiClient['menu']['createOption']>[1],
  ): Promise<EditorOutcome<OptionDto>>;
  patchOption(id: string, patch: OptionPatch): Promise<EditorOutcome<OptionDto>>;
  setOptionAvailable(
    option: Pick<OptionDto, 'id' | 'version'>,
    isAvailable: boolean,
  ): Promise<EditorOutcome<OptionDto>>;
  setOptionArchived(
    option: Pick<OptionDto, 'id' | 'version'>,
    archived: boolean,
  ): Promise<EditorOutcome<OptionDto>>;

  /** The whole sibling set in its new order, with the versions on screen. */
  reorder(
    kind: ReorderKind,
    parentId: string | undefined,
    orderedIds: readonly string[],
  ): Promise<EditorOutcome<undefined>>;

  /** Sign-out: forgets the costs and makes every answer still on its way harmless. */
  reset(): void;
}

/** Codes that mean "this row is not where you thought": read the menu again. */
const STALE_CODES: readonly string[] = ['VERSION_CONFLICT', 'REORDER_SET_MISMATCH'];

/** The `pending` key of one row, and of one list being reordered: screens disable a control while it is in. */
export const rowKey = (id: string) => `row:${id}`;
export const reorderKey = (kind: ReorderKind, parentId: string | undefined) =>
  `reorder:${kind}:${parentId ?? ''}`;

const initial = (): MenuEditorState => ({ status: 'idle', error: null, costs: null, pending: [] });

const categoryFrame = (c: CategoryDto): RealtimeFrame => ({
  type: 'menu.upserted',
  kind: 'category',
  id: c.id,
  rev: c.rev,
  data: c,
});
const itemFrame = (i: ItemDto): RealtimeFrame => ({
  type: 'menu.upserted',
  kind: 'item',
  id: i.id,
  rev: i.rev,
  data: i,
});
const optionFrame = (o: OptionDto): RealtimeFrame => ({
  type: 'menu.upserted',
  kind: 'option',
  id: o.id,
  rev: o.rev,
  data: o,
});
const groupFrame = (g: GroupDto): RealtimeFrame => ({
  type: 'menu.upserted',
  kind: 'group',
  id: g.id,
  rev: g.rev,
  data: g,
});

export function createMenuEditorStore(deps: MenuEditorDeps): MenuEditorStore {
  const store = createStore<MenuEditorState>(initial());
  const newId = deps.newId ?? newUuid;
  let epoch = 0;
  let loading: Promise<void> | null = null;
  /** Content of a create whose answer never came -> the key to try it with again. */
  const keys = new Map<string, string>();

  // ----- reading -----

  async function read(): Promise<void> {
    const startedIn = epoch;
    const withCost = deps.canSeeCosts();
    try {
      const [categories, items, groups, costs] = await Promise.all([
        deps.api.menu.listCategories(),
        deps.api.menu.listItems({ includeArchived: true }),
        deps.api.menu.listGroups({ includeArchived: true }),
        withCost ? deps.api.menu.costs().catch(() => null) : Promise.resolve(null),
      ]);
      if (epoch !== startedIn) return;
      const frames: RealtimeFrame[] = [
        ...categories.categories.map(categoryFrame),
        ...items.items.map(itemFrame),
        ...groups.groups.flatMap((g) => [...g.options.map(optionFrame), groupFrame(g)]),
      ];
      deps.entities.applyMany(frames);
      store.setState({
        status: 'ready',
        error: null,
        costs: costs
          ? {
              items: Object.fromEntries(costs.items.map((c) => [c.id, c.estCostSatang])),
              options: Object.fromEntries(costs.options.map((c) => [c.id, c.costDeltaSatang])),
            }
          : null,
      });
    } catch (caught) {
      if (epoch !== startedIn) return;
      const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
      // Rows already on screen stay; only a first load that failed becomes an error screen.
      if (store.getState().status !== 'ready') store.setState({ status: 'error', error });
    }
  }

  function load(): Promise<void> {
    if (loading) return loading;
    if (store.getState().status !== 'ready') store.setState({ status: 'loading', error: null });
    loading = read().finally(() => {
      loading = null;
    });
    return loading;
  }

  // ----- writing -----

  const pendingNow = () => store.getState().pending;
  const markPending = (key: string) => store.setState({ pending: [...pendingNow(), key] });
  const clearPending = (key: string) =>
    store.setState({ pending: pendingNow().filter((k) => k !== key) });

  /** Runs one write on a row: guarded, epoch-safe, and a stale answer reads the menu again. */
  async function run<T>(
    key: string,
    send: () => Promise<T>,
    done: (value: T) => void,
  ): Promise<EditorOutcome<T>> {
    if (!deps.lifecycle.isOnline()) return { ok: false, reason: 'offline' };
    if (pendingNow().includes(key)) return { ok: false, reason: 'busy' };
    const startedIn = epoch;
    markPending(key);
    try {
      const value = await send();
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      done(value);
      return { ok: true, value };
    } catch (caught) {
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      const error = isApiClientError(caught) ? caught : new ApiClientError('UNKNOWN');
      const refreshed = STALE_CODES.includes(error.code);
      if (refreshed) await read();
      return { ok: false, reason: 'error', error, refreshed };
    } finally {
      if (epoch === startedIn) clearPending(key);
    }
  }

  /** The key a create is sent with: the same one for the same content that has no answer yet. */
  async function create<T>(
    kind: string,
    content: unknown,
    send: (clientRequestId: string) => Promise<{ row: T; clientRequestId: string }>,
    done: (row: T) => void,
  ): Promise<EditorOutcome<T>> {
    const signature = `${kind}:${JSON.stringify(content)}`;
    const key = keys.get(signature) ?? newId();
    const outcome = await run(signature, async () => (await send(key)).row, done);
    if (outcome.ok) keys.delete(signature);
    else if (outcome.reason === 'error' && mayHaveBeenCreated(outcome.error))
      keys.set(signature, key);
    else if (outcome.reason === 'error') keys.delete(signature);
    return outcome;
  }

  const rememberCost = (kind: 'items' | 'options', id: string, value: number | undefined) => {
    const costs = store.getState().costs;
    if (!costs || value === undefined) return;
    store.setState({ costs: { ...costs, [kind]: { ...costs[kind], [id]: value } } });
  };

  const putCategory = (c: CategoryDto) => deps.entities.apply(categoryFrame(c));
  const putItem = (i: ItemDto) => deps.entities.apply(itemFrame(i));
  const putOption = (o: OptionDto) => deps.entities.apply(optionFrame(o));
  const putGroup = (g: GroupDto) =>
    deps.entities.applyMany([...g.options.map(optionFrame), groupFrame(g)]);

  function applyReorder(kind: ReorderKind, response: ReorderResponse) {
    const state = deps.entities.getState();
    const groups = kind === 'groups' ? groupsWithOptions(state) : null;
    const frames: RealtimeFrame[] = [];
    for (const row of response.rows) {
      const next = { sort: row.sort, version: row.version, rev: row.rev };
      if (kind === 'categories') {
        const c = state.categories.get(row.id);
        if (c) frames.push(categoryFrame({ ...c, ...next }));
      } else if (kind === 'items') {
        const i = state.items.get(row.id);
        if (i) frames.push(itemFrame({ ...i, ...next }));
      } else if (kind === 'options') {
        const o = state.options.get(row.id);
        if (o) frames.push(optionFrame({ ...o, ...next }));
      } else {
        const g = groups?.get(row.id);
        if (g) frames.push(groupFrame({ ...g, ...next }));
      }
    }
    deps.entities.applyMany(frames);
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    load,

    createCategory: (input) =>
      create(
        'category',
        input,
        (id) => deps.api.menu.createCategory(input, { clientRequestId: id }),
        putCategory,
      ),
    patchCategory: (id, patch) =>
      run(rowKey(id), () => deps.api.menu.patchCategory(id, patch), putCategory),
    setCategoryActive: (category, active) =>
      run(
        rowKey(category.id),
        () =>
          deps.api.menu.patchCategory(category.id, { expectedVersion: category.version, active }),
        putCategory,
      ),

    createItem: (input) =>
      create(
        'item',
        input,
        (id) => deps.api.menu.createItem(input, { clientRequestId: id }),
        (item) => {
          putItem(item);
          rememberCost('items', item.id, input.estCostSatang ?? 0);
        },
      ),
    patchItem: (id, patch) =>
      run(
        rowKey(id),
        () => deps.api.menu.patchItem(id, patch),
        (item) => {
          putItem(item);
          rememberCost('items', id, patch.estCostSatang);
        },
      ),
    setItemAvailable: (item, isAvailable) =>
      run(
        rowKey(item.id),
        () =>
          deps.api.menu.setItemAvailable(item.id, { isAvailable, expectedVersion: item.version }),
        putItem,
      ),
    setItemArchived: (item, archived) =>
      run(
        rowKey(item.id),
        () => deps.api.menu.patchItem(item.id, { expectedVersion: item.version, archived }),
        putItem,
      ),

    async setPhoto(item, file) {
      // Re-encoding comes first and needs no network, but the upload does: check online up front
      // so a person is not made to wait for a resize that cannot be sent.
      if (!deps.lifecycle.isOnline()) return { ok: false, reason: 'offline' };
      const key = rowKey(item.id);
      if (pendingNow().includes(key)) return { ok: false, reason: 'busy' };
      const startedIn = epoch;
      markPending(key);
      let photo: Blob;
      try {
        photo = await preparePhoto(file, deps.photoEngine);
      } catch (caught) {
        if (epoch === startedIn) clearPending(key);
        if (epoch !== startedIn) return { ok: false, reason: 'stale' };
        return {
          ok: false,
          reason: 'photo',
          failure:
            caught instanceof PhotoError && caught.reason !== 'bad_size'
              ? caught.reason
              : 'unreadable',
        };
      }
      if (epoch === startedIn) clearPending(key);
      if (epoch !== startedIn) return { ok: false, reason: 'stale' };
      return run(key, () => deps.api.menu.putPhoto(item.id, photo), putItem);
    },
    removePhoto: (item) => run(rowKey(item.id), () => deps.api.menu.removePhoto(item.id), putItem),

    createGroup: (input) =>
      create(
        'group',
        input,
        (id) => deps.api.menu.createGroup(input, { clientRequestId: id }),
        putGroup,
      ),
    patchGroup: (id, patch) => run(rowKey(id), () => deps.api.menu.patchGroup(id, patch), putGroup),
    setGroupArchived: (group, archived) =>
      run(
        rowKey(group.id),
        () => deps.api.menu.patchGroup(group.id, { expectedVersion: group.version, archived }),
        putGroup,
      ),

    createOption: (groupId, input) =>
      create(
        `option:${groupId}`,
        input,
        (id) => deps.api.menu.createOption(groupId, input, { clientRequestId: id }),
        (option) => {
          putOption(option);
          rememberCost('options', option.id, input.costDeltaSatang ?? 0);
        },
      ),
    patchOption: (id, patch) =>
      run(
        rowKey(id),
        () => deps.api.menu.patchOption(id, patch),
        (option) => {
          putOption(option);
          rememberCost('options', id, patch.costDeltaSatang);
        },
      ),
    setOptionAvailable: (option, isAvailable) =>
      run(
        rowKey(option.id),
        () =>
          deps.api.menu.setOptionAvailable(option.id, {
            isAvailable,
            expectedVersion: option.version,
          }),
        putOption,
      ),
    setOptionArchived: (option, archived) =>
      run(
        rowKey(option.id),
        () => deps.api.menu.patchOption(option.id, { expectedVersion: option.version, archived }),
        putOption,
      ),

    async reorder(kind, parentId, orderedIds) {
      const state = deps.entities.getState();
      const versionOf = (id: string): number | undefined =>
        (kind === 'categories'
          ? state.categories.get(id)
          : kind === 'items'
            ? state.items.get(id)
            : kind === 'groups'
              ? state.groups.get(id)
              : state.options.get(id)
        )?.version;
      const order: { id: string; expectedVersion: number }[] = [];
      for (const id of orderedIds) {
        const expectedVersion = versionOf(id);
        if (expectedVersion === undefined) return { ok: false, reason: 'stale' };
        order.push({ id, expectedVersion });
      }
      const key = reorderKey(kind, parentId);
      const outcome = await run(
        key,
        () =>
          deps.api.menu.reorder({ kind, ...(parentId === undefined ? {} : { parentId }), order }),
        (response) => applyReorder(kind, response),
      );
      return outcome.ok ? { ok: true, value: undefined } : outcome;
    },

    reset() {
      epoch += 1;
      loading = null;
      keys.clear();
      store.setState(initial());
    },
  };
}
