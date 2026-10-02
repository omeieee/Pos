/**
 * The menu-editor routes of the made-up server (dev and tests only; see mock-shop.ts): the staff
 * lists with archived rows, creates with idempotency keys, versioned patches, the sold-out
 * switches, the atomic reorder, the costs (`report.view` only) and the photo upload. It answers
 * the way apps/api does: the same status codes and `code`s (VERSION_CONFLICT with the current
 * version, REORDER_SET_MISMATCH, IDEMPOTENCY_KEY_REUSED, the PHOTO_* codes), and the shared
 * schemas validate every body. Rows live in the shop's frame map, so a change reaches every open
 * socket like a real one.
 *
 * Not modelled: new orders are still priced from the shop's fixed seed menu, so a price edited here
 * shows on the order screen (an estimate) but the mock's order total keeps the seed price. The photo
 * route stores nothing: it keeps the last upload for inspection (`lastPhoto`).
 */
import {
  availabilityInputSchema,
  type CategoryDto,
  checkPhoto,
  createCategoryInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  type GroupDto,
  hasPermission,
  type ItemDto,
  idParamSchema,
  menuPhotoPath,
  type OptionDto,
  patchCategoryInputSchema,
  patchGroupInputSchema,
  patchItemInputSchema,
  patchOptionInputSchema,
  type ReorderResponse,
  reorderInputSchema,
  type StaffRole,
  type SyncChange,
} from '@sds/shared';

export interface MockAnswer {
  status: number;
  body: unknown;
}

export interface MockMenuAdminDeps {
  /** Every row the shop holds, as its latest frames. */
  rows(): Iterable<SyncChange>;
  nextRev(): number;
  publish(frame: SyncChange): void;
  newUuid(): string;
}

export interface RawBody {
  bytes: Uint8Array;
  contentType: string;
}

const error = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details },
});
const conflict = (version: number) => error(409, 'VERSION_CONFLICT', { currentVersion: version });
const invalid = () => error(400, 'VALIDATION_ERROR');

const PHOTO_CODES = {
  empty: [422, 'PHOTO_EMPTY'],
  too_big: [413, 'PHOTO_TOO_LARGE'],
  not_an_image: [415, 'PHOTO_NOT_AN_IMAGE'],
  type_mismatch: [415, 'PHOTO_TYPE_MISMATCH'],
  too_many_pixels: [422, 'PHOTO_TOO_MANY_PIXELS'],
} as const;

export function createMockMenuAdmin(deps: MockMenuAdminDeps) {
  /** Estimated costs by id. A dish costs about 40% of its price until someone says otherwise. */
  const itemCosts = new Map<string, number>();
  const optionCosts = new Map<string, number>();
  /** `kind:clientRequestId` -> what it made, for the idempotent creates. */
  const made = new Map<string, { hash: string; row: unknown }>();
  let lastPhoto: { itemId: string; contentType: string; bytes: Uint8Array } | null = null;

  // ----- the rows, as the frames hold them -----
  function snapshot() {
    const categories = new Map<string, CategoryDto>();
    const items = new Map<string, ItemDto>();
    const groups = new Map<string, GroupDto>();
    const options = new Map<string, OptionDto>();
    for (const frame of deps.rows()) {
      if (frame.type !== 'menu.upserted') continue;
      if (frame.kind === 'category') categories.set(frame.id, frame.data);
      else if (frame.kind === 'item') items.set(frame.id, frame.data);
      else if (frame.kind === 'option') options.set(frame.id, frame.data);
      else groups.set(frame.id, frame.data);
    }
    return { categories, items, groups, options };
  }
  const bySort = (a: { sort: number; id: string }, b: { sort: number; id: string }) =>
    a.sort - b.sort || a.id.localeCompare(b.id);

  const groupDto = (
    group: GroupDto,
    options: Map<string, OptionDto>,
    includeArchived: boolean,
  ) => ({
    ...group,
    options: [...options.values()]
      .filter((o) => o.groupId === group.id && (includeArchived || !o.archived))
      .sort(bySort),
  });

  // ----- writing rows -----
  function putCategory(row: CategoryDto): CategoryDto {
    const rev = deps.nextRev();
    const next = { ...row, version: row.version + 1, rev };
    deps.publish({ type: 'menu.upserted', kind: 'category', id: next.id, rev, data: next });
    return next;
  }
  function putItem(row: ItemDto): ItemDto {
    const rev = deps.nextRev();
    const next = { ...row, version: row.version + 1, rev };
    deps.publish({ type: 'menu.upserted', kind: 'item', id: next.id, rev, data: next });
    return next;
  }
  function putOption(row: OptionDto): OptionDto {
    const rev = deps.nextRev();
    const next = { ...row, version: row.version + 1, rev };
    deps.publish({ type: 'menu.upserted', kind: 'option', id: next.id, rev, data: next });
    return next;
  }
  function putGroup(row: GroupDto): GroupDto {
    const rev = deps.nextRev();
    const next = { ...row, version: row.version + 1, rev };
    const { options } = snapshot();
    deps.publish({
      type: 'menu.upserted',
      kind: 'group',
      id: next.id,
      rev,
      data: { ...next, options: groupDto(next, options, true).options },
    });
    return groupDto(next, snapshot().options, true);
  }
  /** A brand-new row starts at version 0 here so that `put*` makes it version 1. */
  const fresh = <T extends { version: number; rev: number }>(row: Omit<T, 'version' | 'rev'>) =>
    ({ ...row, version: 0, rev: 0 }) as T;

  /** The create answers: 201 the first time, 200 for the same id with the same content, 409 for other content. */
  function idempotent<T>(
    kind: string,
    clientRequestId: string | undefined,
    content: unknown,
    make: () => MockAnswer & { row?: T },
  ): MockAnswer {
    if (clientRequestId === undefined) return make();
    const key = `${kind}:${clientRequestId}`;
    const hash = JSON.stringify(content);
    const earlier = made.get(key);
    if (earlier) {
      return earlier.hash === hash
        ? { status: 200, body: earlier.row }
        : error(409, 'IDEMPOTENCY_KEY_REUSED');
    }
    const answer = make();
    if (answer.status === 201) made.set(key, { hash, row: answer.body });
    return answer;
  }

  function bodyWithoutKey(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) return body;
    const { clientRequestId: _gone, ...rest } = body as Record<string, unknown>;
    return rest;
  }

  const idOf = (value: string | undefined): string | null => {
    const parsed = idParamSchema.safeParse({ id: value });
    return parsed.success ? parsed.data.id : null;
  };

  // ----- the routes -----
  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    role: StaffRole,
    raw?: RawBody,
  ): MockAnswer | null {
    if (!path.startsWith('/v1/menu/')) return null;
    const canEdit = hasPermission(role, 'menu.edit');
    const rest = path.slice('/v1/menu/'.length);

    // Reads
    if (method === 'GET') {
      const state = snapshot();
      const wantArchived = query.get('includeArchived') === 'true';
      if ((rest === 'items' || rest === 'modifier-groups') && wantArchived && !canEdit) {
        return error(403, 'FORBIDDEN');
      }
      if (rest === 'categories') {
        return { status: 200, body: { categories: [...state.categories.values()].sort(bySort) } };
      }
      if (rest === 'items') {
        const items = [...state.items.values()]
          .filter((i) => wantArchived || !i.archived)
          .sort(bySort);
        return { status: 200, body: { items } };
      }
      if (rest === 'modifier-groups') {
        const groups = [...state.groups.values()]
          .filter((g) => wantArchived || !g.archived)
          .sort(bySort)
          .map((g) => groupDto(g, state.options, wantArchived));
        return { status: 200, body: { groups } };
      }
      if (rest === 'costs') {
        if (!hasPermission(role, 'report.view')) return error(403, 'FORBIDDEN');
        return {
          status: 200,
          body: {
            items: [...state.items.values()].map((i) => ({
              id: i.id,
              estCostSatang: itemCosts.get(i.id) ?? Math.round(i.priceSatang * 0.4),
            })),
            options: [...state.options.values()].map((o) => ({
              id: o.id,
              costDeltaSatang: optionCosts.get(o.id) ?? 0,
            })),
          },
        };
      }
    }

    // The sold-out switches need only menu.availability (every role); everything else, menu.edit.
    const availability = /^(items|modifier-options)\/([^/]+)\/availability$/.exec(rest);
    if (method === 'PATCH' && availability) {
      if (!hasPermission(role, 'menu.availability')) return error(403, 'FORBIDDEN');
      return switchAvailability(availability[1] === 'items', idOf(availability[2]), body);
    }
    if (method === 'GET') return null;
    if (!canEdit) return error(403, 'FORBIDDEN');

    if (method === 'POST' && rest === 'reorder') return reorder(body);

    const photo = /^items\/([^/]+)\/photo$/.exec(rest);
    if (photo && method === 'PUT') return putPhoto(idOf(photo[1]), raw);
    if (photo && method === 'DELETE') return removePhoto(idOf(photo[1]));

    if (method === 'POST') return create(rest, body);
    if (method === 'PATCH') return patch(rest, body);
    return null;
  }

  function create(rest: string, body: unknown): MockAnswer | null {
    const state = snapshot();
    if (rest === 'categories') {
      const input = createCategoryInputSchema.safeParse(body);
      if (!input.success) return invalid();
      return idempotent('category', input.data.clientRequestId, bodyWithoutKey(body), () => {
        const row = putCategory(
          fresh<CategoryDto>({
            id: deps.newUuid(),
            nameTh: input.data.nameTh,
            nameEn: input.data.nameEn ?? null,
            sort: input.data.sort,
            active: true,
          }),
        );
        return { status: 201, body: row };
      });
    }
    if (rest === 'items') {
      const input = createItemInputSchema.safeParse(body);
      if (!input.success) return invalid();
      const data = input.data;
      if (!state.categories.has(data.categoryId)) return error(422, 'UNKNOWN_CATEGORY');
      if (
        data.modifierGroupIds?.some((g) => !state.groups.get(g) || state.groups.get(g)?.archived)
      ) {
        return error(422, 'UNKNOWN_GROUP');
      }
      return idempotent('item', data.clientRequestId, bodyWithoutKey(body), () => {
        const id = deps.newUuid();
        itemCosts.set(id, data.estCostSatang);
        const row = putItem(
          fresh<ItemDto>({
            id,
            categoryId: data.categoryId,
            nameTh: data.nameTh,
            nameEn: data.nameEn ?? null,
            descriptionTh: data.descriptionTh ?? null,
            descriptionEn: data.descriptionEn ?? null,
            priceSatang: data.priceSatang,
            imageUrl: null,
            photoVersion: null,
            photoUrl: null,
            isAvailable: data.isAvailable,
            channels: data.channels,
            channelPrices: (data.channelPrices ?? {}) as ItemDto['channelPrices'],
            modifierGroupIds: data.modifierGroupIds ?? [],
            sort: data.sort,
            archived: false,
          }),
        );
        return { status: 201, body: row };
      });
    }
    if (rest === 'modifier-groups') {
      const input = createGroupInputSchema.safeParse(body);
      if (!input.success) return invalid();
      const data = input.data;
      return idempotent('group', data.clientRequestId, bodyWithoutKey(body), () => {
        const id = deps.newUuid();
        for (const [index, o] of (data.options ?? []).entries()) {
          const optionId = deps.newUuid();
          optionCosts.set(optionId, o.costDeltaSatang);
          putOption(
            fresh<OptionDto>({
              id: optionId,
              groupId: id,
              nameTh: o.nameTh,
              nameEn: o.nameEn ?? null,
              priceDeltaSatang: o.priceDeltaSatang,
              isAvailable: o.isAvailable,
              sort: o.sort || index,
              archived: false,
            }),
          );
        }
        const row = putGroup({
          ...fresh<GroupDto>({
            id,
            nameTh: data.nameTh,
            nameEn: data.nameEn ?? null,
            minSelect: data.minSelect,
            maxSelect: data.maxSelect,
            sort: data.sort,
            archived: false,
            options: [],
          }),
        });
        return { status: 201, body: row };
      });
    }
    const option = /^modifier-groups\/([^/]+)\/options$/.exec(rest);
    if (option) {
      const groupId = idOf(option[1]);
      const group = groupId ? state.groups.get(groupId) : undefined;
      if (!group) return error(404, 'NOT_FOUND');
      const input = createOptionInputSchema.safeParse(body);
      if (!input.success) return invalid();
      if (group.archived) return error(422, 'UNKNOWN_GROUP');
      const data = input.data;
      return idempotent(`option:${group.id}`, data.clientRequestId, bodyWithoutKey(body), () => {
        const id = deps.newUuid();
        optionCosts.set(id, data.costDeltaSatang);
        const row = putOption(
          fresh<OptionDto>({
            id,
            groupId: group.id,
            nameTh: data.nameTh,
            nameEn: data.nameEn ?? null,
            priceDeltaSatang: data.priceDeltaSatang,
            isAvailable: data.isAvailable,
            sort: data.sort,
            archived: false,
          }),
        );
        return { status: 201, body: row };
      });
    }
    return null;
  }

  function patch(rest: string, body: unknown): MockAnswer | null {
    const state = snapshot();
    const [kind, rawId] = rest.split('/');
    const id = idOf(rawId);
    if (!id) return error(404, 'NOT_FOUND');

    if (kind === 'categories') {
      const row = state.categories.get(id);
      if (!row) return error(404, 'NOT_FOUND');
      const input = patchCategoryInputSchema.safeParse(body);
      if (!input.success) return invalid();
      if (row.version !== input.data.expectedVersion) return conflict(row.version);
      const { expectedVersion: _v, ...changes } = input.data;
      return { status: 200, body: putCategory({ ...row, ...definedOnly(changes) }) };
    }
    if (kind === 'items') {
      const row = state.items.get(id);
      if (!row) return error(404, 'NOT_FOUND');
      const input = patchItemInputSchema.safeParse(body);
      if (!input.success) return invalid();
      if (row.version !== input.data.expectedVersion) return conflict(row.version);
      const { expectedVersion: _v, estCostSatang, imageUrl: _image, ...changes } = input.data;
      if (changes.categoryId && !state.categories.has(changes.categoryId)) {
        return error(422, 'UNKNOWN_CATEGORY');
      }
      if (
        changes.modifierGroupIds?.some((g) => !state.groups.get(g) || state.groups.get(g)?.archived)
      ) {
        return error(422, 'UNKNOWN_GROUP');
      }
      if (estCostSatang !== undefined) itemCosts.set(id, estCostSatang);
      return {
        status: 200,
        body: putItem({ ...row, ...(definedOnly(changes) as Partial<ItemDto>) }),
      };
    }
    if (kind === 'modifier-groups') {
      const row = state.groups.get(id);
      if (!row) return error(404, 'NOT_FOUND');
      const input = patchGroupInputSchema.safeParse(body);
      if (!input.success) return invalid();
      if (row.version !== input.data.expectedVersion) return conflict(row.version);
      const { expectedVersion: _v, ...changes } = input.data;
      const next = { ...row, ...definedOnly(changes) };
      if (next.minSelect > next.maxSelect) return invalid();
      return { status: 200, body: putGroup(next) };
    }
    if (kind === 'modifier-options') {
      const row = state.options.get(id);
      if (!row) return error(404, 'NOT_FOUND');
      const input = patchOptionInputSchema.safeParse(body);
      if (!input.success) return invalid();
      if (row.version !== input.data.expectedVersion) return conflict(row.version);
      const { expectedVersion: _v, costDeltaSatang, ...changes } = input.data;
      if (costDeltaSatang !== undefined) optionCosts.set(id, costDeltaSatang);
      return { status: 200, body: putOption({ ...row, ...definedOnly(changes) }) };
    }
    return null;
  }

  function switchAvailability(isItem: boolean, id: string | null, body: unknown): MockAnswer {
    const input = availabilityInputSchema.safeParse(body);
    if (!id || !input.success) return invalid();
    const state = snapshot();
    const row = isItem ? state.items.get(id) : state.options.get(id);
    if (!row) return error(404, 'NOT_FOUND');
    if (input.data.expectedVersion !== undefined && row.version !== input.data.expectedVersion) {
      return conflict(row.version);
    }
    if (row.isAvailable === input.data.isAvailable) return { status: 200, body: row };
    const next = { ...row, isAvailable: input.data.isAvailable };
    return { status: 200, body: isItem ? putItem(next as ItemDto) : putOption(next as OptionDto) };
  }

  function reorder(body: unknown): MockAnswer {
    const input = reorderInputSchema.safeParse(body);
    if (!input.success) return invalid();
    const { kind, parentId, order } = input.data;
    const state = snapshot();
    type Sibling = { id: string; sort: number; version: number; rev: number };
    let siblings: Sibling[];
    if (kind === 'categories') siblings = [...state.categories.values()];
    else if (kind === 'items') {
      if (!state.categories.has(parentId ?? '')) return error(404, 'NOT_FOUND');
      siblings = [...state.items.values()].filter((i) => i.categoryId === parentId && !i.archived);
    } else if (kind === 'groups') siblings = [...state.groups.values()].filter((g) => !g.archived);
    else {
      if (!state.groups.has(parentId ?? '')) return error(404, 'NOT_FOUND');
      siblings = [...state.options.values()].filter((o) => o.groupId === parentId && !o.archived);
    }
    const current = new Map(siblings.map((s) => [s.id, s]));
    if (siblings.length !== order.length || order.some((o) => !current.has(o.id))) {
      return error(409, 'REORDER_SET_MISMATCH');
    }
    const wanted = order.map((o, sort) => ({ ...o, sort, was: current.get(o.id) as Sibling }));
    const moved = wanted.filter((w) => w.was.sort !== w.sort);
    const answer = (changed: number, rows: ReorderResponse['rows']): MockAnswer => ({
      status: 200,
      body: { kind, parentId: parentId ?? null, changed, rows } satisfies ReorderResponse,
    });
    if (moved.length === 0) {
      return answer(
        0,
        wanted.map((w) => ({ id: w.id, sort: w.sort, version: w.was.version, rev: w.was.rev })),
      );
    }
    const stale = wanted.find((w) => w.was.version !== w.expectedVersion);
    if (stale) return conflict(stale.was.version);
    const written = new Map<string, { version: number; rev: number }>();
    for (const w of moved) {
      let next: { version: number; rev: number };
      if (kind === 'categories')
        next = putCategory({ ...(state.categories.get(w.id) as CategoryDto), sort: w.sort });
      else if (kind === 'items')
        next = putItem({ ...(state.items.get(w.id) as ItemDto), sort: w.sort });
      else if (kind === 'groups')
        next = putGroup({ ...(state.groups.get(w.id) as GroupDto), sort: w.sort });
      else next = putOption({ ...(state.options.get(w.id) as OptionDto), sort: w.sort });
      written.set(w.id, next);
    }
    return answer(
      moved.length,
      wanted.map((w) => ({
        id: w.id,
        sort: w.sort,
        version: written.get(w.id)?.version ?? w.was.version,
        rev: written.get(w.id)?.rev ?? w.was.rev,
      })),
    );
  }

  function putPhoto(id: string | null, raw: RawBody | undefined): MockAnswer {
    const row = id ? snapshot().items.get(id) : undefined;
    if (!id || !row) return error(404, 'NOT_FOUND');
    const check = checkPhoto(raw?.bytes ?? new Uint8Array(), raw?.contentType);
    if (!check.ok) {
      const [status, code] = PHOTO_CODES[check.reason];
      return error(status, code);
    }
    lastPhoto = {
      itemId: id,
      contentType: raw?.contentType ?? '',
      bytes: raw?.bytes ?? new Uint8Array(),
    };
    const photoVersion = row.version + 1;
    return {
      status: 200,
      body: putItem({ ...row, photoVersion, photoUrl: menuPhotoPath(id, photoVersion) }),
    };
  }

  function removePhoto(id: string | null): MockAnswer {
    const row = id ? snapshot().items.get(id) : undefined;
    if (!id || !row) return error(404, 'NOT_FOUND');
    if (row.photoVersion == null) return { status: 200, body: row };
    return { status: 200, body: putItem({ ...row, photoVersion: null, photoUrl: null }) };
  }

  return {
    handle,
    /** The last photo uploaded (what the server would have stored), for checking what the app sent. */
    lastPhoto: () => lastPhoto,
    /** A dish's cost price as the server holds it, in satang. */
    costOfItem: (id: string) => itemCosts.get(id),
  };
}

/** The keys that have a value: `undefined` means "not given" in a patch. */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
function definedOnly<T extends object>(changes: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}
