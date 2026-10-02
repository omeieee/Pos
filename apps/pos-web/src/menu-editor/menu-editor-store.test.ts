import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { categoryDto, groupDto, itemDto, optionDto, uuid } from '../test-support/frames.ts';
import { createEditorEnv } from '../test-support/menu-editor-env.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { fakeExifJpeg } from './photo-fixtures.ts';
import type { PhotoEngine } from './photo-plan.ts';

const NEW_ITEM = {
  categoryId: MENU.catDrink,
  nameTh: 'โกโก้',
  priceSatang: satang(3500),
  channels: ['storefront' as const],
};

describe('load', () => {
  test('reads the whole menu with archived rows, and puts it in the entity store', async () => {
    const archived = itemDto(uuid(700), 900, { nameTh: 'เมนูเก่า', archived: true });
    const env = createEditorEnv({
      seed: false,
      menu: {
        listCategories: async () => ({ categories: [categoryDto(uuid(701), 901)] }),
        listItems: async () => ({ items: [archived] }),
        listGroups: async () => ({
          groups: [groupDto(uuid(702), 903, { options: [{ id: uuid(703), rev: 902 }] })],
        }),
      },
    });
    await env.store.load();
    expect(env.menu.listItems).toHaveBeenCalledWith({ includeArchived: true });
    expect(env.menu.listGroups).toHaveBeenCalledWith({ includeArchived: true });
    expect(env.store.getState().status).toBe('ready');
    expect(env.entities.getState().items.get(archived.id)?.archived).toBe(true);
    expect(env.entities.getState().options.has(uuid(703))).toBe(true);
    expect(env.menu.costs).not.toHaveBeenCalled();
    expect(env.store.getState().costs).toBeNull();
  });

  test('a role with report.view also gets the costs, held in the editor state only', async () => {
    const env = createEditorEnv({
      costs: true,
      seed: false,
      menu: {
        listCategories: async () => ({ categories: [] }),
        listItems: async () => ({ items: [] }),
        listGroups: async () => ({ groups: [] }),
        costs: async () => ({
          items: [{ id: MENU.tomYum, estCostSatang: satang(1800) }],
          options: [{ id: MENU.egg, costDeltaSatang: satang(-200) }],
        }),
      },
    });
    await env.store.load();
    expect(env.store.getState().costs).toEqual({
      items: { [MENU.tomYum]: 1800 },
      options: { [MENU.egg]: -200 },
    });
    // The entity store (what the till reads and the device saves) has no trace of a cost.
    expect(JSON.stringify([...env.entities.getState().items.values()])).not.toContain('Cost');
  });

  test('a cost read that fails for any reason but 403 is flagged; a 403 is a role without costs', async () => {
    const reads = {
      listCategories: async () => ({ categories: [] }),
      listItems: async () => ({ items: [] }),
      listGroups: async () => ({ groups: [] }),
    };
    const broken = createEditorEnv({
      costs: true,
      seed: false,
      menu: {
        ...reads,
        costs: async () => {
          throw new ApiClientError('NETWORK');
        },
      },
    });
    await broken.store.load();
    expect(broken.store.getState()).toMatchObject({
      status: 'ready',
      costs: null,
      costsFailed: true,
    });

    const forbidden = createEditorEnv({
      costs: true,
      seed: false,
      menu: {
        ...reads,
        costs: async () => {
          throw new ApiClientError('FORBIDDEN', { status: 403 });
        },
      },
    });
    await forbidden.store.load();
    expect(forbidden.store.getState()).toMatchObject({ costs: null, costsFailed: false });
  });

  test('a failed first load is an error screen; a failed later read keeps the rows', async () => {
    let fail = true;
    const env = createEditorEnv({
      menu: {
        listCategories: async () => {
          if (fail) throw new ApiClientError('NETWORK');
          return { categories: [] };
        },
        listItems: async () => ({ items: [] }),
        listGroups: async () => ({ groups: [] }),
      },
    });
    await env.store.load();
    expect(env.store.getState()).toMatchObject({ status: 'error', error: { code: 'NETWORK' } });
    fail = false;
    await env.store.load();
    expect(env.store.getState().status).toBe('ready');
    fail = true;
    await env.store.load();
    expect(env.store.getState().status).toBe('ready');
  });
});

describe('creating', () => {
  test('a saved row goes into the entity store, and its cost is remembered for report.view roles', async () => {
    const created = itemDto(uuid(710), 1000, { nameTh: 'โกโก้', categoryId: MENU.catDrink });
    const env = createEditorEnv({
      costs: true,
      menu: {
        listCategories: async () => ({ categories: [] }),
        listItems: async () => ({ items: [] }),
        listGroups: async () => ({ groups: [] }),
        costs: async () => ({ items: [], options: [] }),
        createItem: async (_input, options) => ({
          row: created,
          replay: false,
          clientRequestId: options?.clientRequestId ?? '',
        }),
      },
    });
    await env.store.load();
    const outcome = await env.store.createItem({ ...NEW_ITEM, estCostSatang: satang(1200) });
    expect(outcome.ok).toBe(true);
    expect(env.entities.getState().items.get(created.id)?.nameTh).toBe('โกโก้');
    expect(env.store.getState().costs?.items[created.id]).toBe(1200);
  });

  test('every create carries a request id, and a retry of the same content reuses it', async () => {
    const created = itemDto(uuid(711), 1001);
    let attempt = 0;
    const env = createEditorEnv({
      menu: {
        createItem: async (_input, options) => {
          attempt += 1;
          if (attempt === 1) throw new ApiClientError('TIMEOUT');
          return { row: created, replay: true, clientRequestId: options?.clientRequestId ?? '' };
        },
      },
    });
    const first = await env.store.createItem(NEW_ITEM);
    expect(first).toMatchObject({ ok: false, reason: 'error', error: { code: 'TIMEOUT' } });
    const second = await env.store.createItem(NEW_ITEM);
    expect(second.ok).toBe(true);
    const keys = env.menu.createItem.mock.calls.map((c) => c[1]?.clientRequestId);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  test('other content gets a new id, and so does a create after a success', async () => {
    const created = itemDto(uuid(712), 1002);
    const env = createEditorEnv({
      menu: {
        createItem: async (_input, options) => ({
          row: created,
          replay: false,
          clientRequestId: options?.clientRequestId ?? '',
        }),
      },
    });
    await env.store.createItem(NEW_ITEM);
    await env.store.createItem(NEW_ITEM);
    await env.store.createItem({ ...NEW_ITEM, nameTh: 'อย่างอื่น' });
    const keys = env.menu.createItem.mock.calls.map((c) => c[1]?.clientRequestId);
    expect(new Set(keys).size).toBe(3);
  });

  test('a refusal the server really gave ends the key', async () => {
    let attempt = 0;
    const created = itemDto(uuid(713), 1003);
    const env = createEditorEnv({
      menu: {
        createItem: async (_input, options) => {
          attempt += 1;
          if (attempt === 1) throw new ApiClientError('UNKNOWN_CATEGORY', { status: 422 });
          return { row: created, replay: false, clientRequestId: options?.clientRequestId ?? '' };
        },
      },
    });
    await env.store.createItem(NEW_ITEM);
    await env.store.createItem(NEW_ITEM);
    const keys = env.menu.createItem.mock.calls.map((c) => c[1]?.clientRequestId);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test('a double tap sends one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = createEditorEnv({
      menu: {
        createCategory: async (_input, options) => {
          await gate;
          return {
            row: categoryDto(uuid(714), 1004),
            replay: false,
            clientRequestId: options?.clientRequestId ?? '',
          };
        },
      },
    });
    const a = env.store.createCategory({ nameTh: 'ของหวาน' });
    const b = env.store.createCategory({ nameTh: 'ของหวาน' });
    release();
    expect((await b).ok).toBe(false);
    expect((await a).ok).toBe(true);
    expect(env.menu.createCategory).toHaveBeenCalledTimes(1);
  });

  test('a group made with its options is stored with them', async () => {
    const group = groupDto(uuid(715), 1005, { options: [{ id: uuid(716), rev: 1005 }] });
    const env = createEditorEnv({
      menu: {
        createGroup: async (_input, options) => ({
          row: group,
          replay: false,
          clientRequestId: options?.clientRequestId ?? '',
        }),
      },
    });
    await env.store.createGroup({ nameTh: 'เส้น', minSelect: 1, maxSelect: 1 });
    expect(env.entities.getState().groups.has(group.id)).toBe(true);
    expect(env.entities.getState().options.has(uuid(716))).toBe(true);
  });
});

describe('changing', () => {
  test('a patch goes out with the version it was built on and shows at once', async () => {
    const env = createEditorEnv({
      menu: {
        patchItem: async (id) => itemDto(id, 1100, { version: 2, priceSatang: satang(5500) }),
      },
    });
    const outcome = await env.store.patchItem(MENU.tomYum, {
      expectedVersion: 1,
      priceSatang: satang(5500),
    });
    expect(outcome.ok).toBe(true);
    expect(env.menu.patchItem).toHaveBeenCalledWith(MENU.tomYum, {
      expectedVersion: 1,
      priceSatang: 5500,
    });
    expect(env.entities.getState().items.get(MENU.tomYum)?.priceSatang).toBe(5500);
  });

  test('sold out and archive send the version on screen', async () => {
    const env = createEditorEnv({
      menu: {
        setItemAvailable: async (id) => itemDto(id, 1101, { version: 2, isAvailable: false }),
        patchItem: async (id, input) =>
          itemDto(id, 1102, { version: 3, archived: input.archived ?? false }),
        setOptionAvailable: async (id) =>
          optionDto(id, MENU.gExtra, 1103, { version: 2, isAvailable: false }),
      },
    });
    await env.store.setItemAvailable({ id: MENU.tomYum, version: 1 }, false);
    expect(env.menu.setItemAvailable).toHaveBeenCalledWith(MENU.tomYum, {
      isAvailable: false,
      expectedVersion: 1,
    });
    await env.store.setItemArchived({ id: MENU.tea, version: 1 }, true);
    expect(env.menu.patchItem).toHaveBeenCalledWith(MENU.tea, {
      expectedVersion: 1,
      archived: true,
    });
    await env.store.setOptionAvailable({ id: MENU.egg, version: 1 }, false);
    expect(env.menu.setOptionAvailable).toHaveBeenCalledWith(MENU.egg, {
      isAvailable: false,
      expectedVersion: 1,
    });
  });

  test('a version conflict reads the menu again and tells the caller; it never retries by itself', async () => {
    const env = createEditorEnv({
      menu: {
        patchItem: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 4 });
        },
        listCategories: async () => ({ categories: [] }),
        listItems: async () => ({ items: [itemDto(MENU.tomYum, 1200, { version: 4 })] }),
        listGroups: async () => ({ groups: [] }),
      },
    });
    const outcome = await env.store.patchItem(MENU.tomYum, { expectedVersion: 1, nameTh: 'ก' });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'error',
      refreshed: true,
      error: { code: 'VERSION_CONFLICT' },
    });
    expect(env.menu.patchItem).toHaveBeenCalledTimes(1);
    expect(env.entities.getState().items.get(MENU.tomYum)?.version).toBe(4);
  });

  test('another error leaves the rows as they are', async () => {
    const env = createEditorEnv({
      menu: {
        patchItem: async () => {
          throw new ApiClientError('UNKNOWN_CATEGORY', { status: 422 });
        },
      },
    });
    const outcome = await env.store.patchItem(MENU.tomYum, { expectedVersion: 1, nameTh: 'ก' });
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: false });
    expect(env.menu.listItems).not.toHaveBeenCalled();
  });

  test('the cost the person typed is remembered; one that was not edited is left alone', async () => {
    const env = createEditorEnv({
      costs: true,
      menu: {
        listCategories: async () => ({ categories: [] }),
        listItems: async () => ({ items: [] }),
        listGroups: async () => ({ groups: [] }),
        costs: async () => ({
          items: [{ id: MENU.tomYum, estCostSatang: satang(1800) }],
          options: [],
        }),
        patchItem: async (id) => itemDto(id, 1300, { version: 2 }),
      },
    });
    await env.store.load();
    await env.store.patchItem(MENU.tomYum, { expectedVersion: 1, nameTh: 'ก' });
    expect(env.store.getState().costs?.items[MENU.tomYum]).toBe(1800);
    await env.store.patchItem(MENU.tomYum, { expectedVersion: 2, estCostSatang: satang(2000) });
    expect(env.store.getState().costs?.items[MENU.tomYum]).toBe(2000);
  });
});

describe('reordering', () => {
  const response = (rows: { id: string; sort: number; version: number; rev: number }[]) => ({
    kind: 'items' as const,
    parentId: MENU.catNoodle,
    changed: rows.length,
    rows,
  });

  test('sends the whole set in the new order with the versions on screen, then shows the new order', async () => {
    const env = createEditorEnv({
      menu: {
        reorder: async () =>
          response([
            { id: MENU.boat, sort: 0, version: 2, rev: 1400 },
            { id: MENU.tomYum, sort: 1, version: 2, rev: 1401 },
            { id: MENU.seafood, sort: 2, version: 1, rev: 1 },
          ]),
      },
    });
    const outcome = await env.store.reorder('items', MENU.catNoodle, [
      MENU.boat,
      MENU.tomYum,
      MENU.seafood,
    ]);
    expect(outcome.ok).toBe(true);
    expect(env.menu.reorder).toHaveBeenCalledWith({
      kind: 'items',
      parentId: MENU.catNoodle,
      order: [
        { id: MENU.boat, expectedVersion: 1 },
        { id: MENU.tomYum, expectedVersion: 1 },
        { id: MENU.seafood, expectedVersion: 1 },
      ],
    });
    const items = env.entities.getState().items;
    expect(items.get(MENU.boat)).toMatchObject({ sort: 0, version: 2, rev: 1400 });
    expect(items.get(MENU.tomYum)).toMatchObject({ sort: 1, version: 2 });
  });

  test('categories and groups are sent without a parent', async () => {
    const env = createEditorEnv({
      menu: { reorder: async () => ({ kind: 'categories', parentId: null, changed: 0, rows: [] }) },
    });
    await env.store.reorder('categories', undefined, [
      MENU.catDrink,
      MENU.catNoodle,
      MENU.catHidden,
    ]);
    expect(env.menu.reorder.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
  });

  test.each(['REORDER_SET_MISMATCH', 'VERSION_CONFLICT'])(
    '%s reads the list again and says so',
    async (code) => {
      const env = createEditorEnv({
        menu: {
          reorder: async () => {
            throw new ApiClientError(code, { status: 409 });
          },
          listCategories: async () => ({ categories: [] }),
          listItems: async () => ({ items: [] }),
          listGroups: async () => ({ groups: [] }),
        },
      });
      const outcome = await env.store.reorder('categories', undefined, [
        MENU.catDrink,
        MENU.catNoodle,
      ]);
      expect(outcome).toMatchObject({
        ok: false,
        reason: 'error',
        refreshed: true,
        error: { code },
      });
      expect(env.menu.listItems).toHaveBeenCalledTimes(1);
    },
  );

  test('a row the store has never seen is refused before the network', async () => {
    const env = createEditorEnv();
    expect(await env.store.reorder('items', MENU.catNoodle, [uuid(999)])).toMatchObject({
      ok: false,
      reason: 'stale',
    });
    expect(env.menu.reorder).not.toHaveBeenCalled();
  });
});

describe('online only', () => {
  test('offline: nothing is sent and nothing is queued', async () => {
    const env = createEditorEnv({ online: false });
    expect(await env.store.createCategory({ nameTh: 'ก' })).toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(await env.store.patchItem(MENU.tea, { expectedVersion: 1, nameTh: 'ก' })).toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(
      await env.store.setPhoto(
        { id: MENU.tea },
        new Blob([fakeExifJpeg()], { type: 'image/jpeg' }),
      ),
    ).toEqual({ ok: false, reason: 'offline' });
    for (const call of Object.values(env.menu)) expect(call).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  test('an answer that arrives after sign-out changes nothing, and the costs are forgotten', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = createEditorEnv({
      costs: true,
      menu: {
        listCategories: async () => ({ categories: [] }),
        listItems: async () => ({ items: [] }),
        listGroups: async () => ({ groups: [] }),
        costs: async () => ({
          items: [{ id: MENU.tomYum, estCostSatang: satang(1800) }],
          options: [],
        }),
        patchItem: async (id) => {
          await gate;
          return itemDto(id, 1500, { version: 2, nameTh: 'หลังออกจากระบบ' });
        },
      },
    });
    await env.store.load();
    const moving = env.store.patchItem(MENU.tomYum, { expectedVersion: 1, nameTh: 'ก' });
    env.store.reset();
    release();
    expect(await moving).toMatchObject({ ok: false, reason: 'stale' });
    expect(env.entities.getState().items.get(MENU.tomYum)?.nameTh).not.toBe('หลังออกจากระบบ');
    expect(env.store.getState()).toMatchObject({ costs: null, pending: [], status: 'idle' });
  });
});

describe('photo: nothing leaves the device with camera metadata in it', () => {
  const chosen = new Blob([fakeExifJpeg()], { type: 'image/jpeg' });

  test('the uploaded bytes come from the re-encoded picture and carry no EXIF', async () => {
    const env = createEditorEnv({
      menu: { putPhoto: async (id) => itemDto(id, 1600, { version: 2, photoVersion: 2 }) },
    });
    const outcome = await env.store.setPhoto({ id: MENU.tea }, chosen);
    expect(outcome.ok).toBe(true);
    const sent = env.menu.putPhoto.mock.calls[0]?.[1] as Blob;
    expect(sent.type).toBe('image/webp');
    const bytes = new Uint8Array(await sent.arrayBuffer());
    expect(sent.size).toBeLessThanOrEqual(150_000);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).not.toContain('Exif');
    expect(text).not.toContain('GPS');
    // not the chosen file itself
    expect(bytes).not.toEqual(new Uint8Array(await chosen.arrayBuffer()));
  });

  test('an encoder that would let the original EXIF through is refused and nothing is uploaded', async () => {
    const leaky: PhotoEngine = {
      async open() {
        return {
          width: 800,
          height: 600,
          encode: async () => new Blob([fakeExifJpeg()], { type: 'image/jpeg' }),
          close: () => undefined,
        };
      },
    };
    const env = createEditorEnv({ engine: leaky });
    expect(await env.store.setPhoto({ id: MENU.tea }, chosen)).toEqual({
      ok: false,
      reason: 'photo',
      failure: 'metadata',
    });
    expect(env.menu.putPhoto).not.toHaveBeenCalled();
    expect(env.store.getState().pending).toEqual([]);
  });

  test('a file the browser cannot read is reported, not sent', async () => {
    const broken: PhotoEngine = {
      async open() {
        throw new Error('no decoder');
      },
    };
    const env = createEditorEnv({ engine: broken });
    expect(await env.store.setPhoto({ id: MENU.tea }, chosen)).toMatchObject({
      reason: 'photo',
      failure: 'unreadable',
    });
    expect(env.menu.putPhoto).not.toHaveBeenCalled();
  });

  test('removing a photo shows the item without it', async () => {
    const env = createEditorEnv({
      menu: { removePhoto: async (id) => itemDto(id, 1700, { version: 2, photoVersion: null }) },
    });
    expect((await env.store.removePhoto({ id: MENU.tea })).ok).toBe(true);
    expect(env.entities.getState().items.get(MENU.tea)?.version).toBe(2);
  });
});
