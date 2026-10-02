import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { fakeExifJpeg, fakeJpeg } from '../menu-editor/photo-fixtures.ts';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createMockServer, MOCK_STAFF } from './mock-server.ts';

async function signedIn(role: 'manager' | 'cashier' | 'owner') {
  const server = createMockServer();
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice(server.issueDeviceToken());
  const services = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: createFakeLifecycle().lifecycle,
  });
  await services.auth.boot();
  await services.auth.loadStaff();
  const person = MOCK_STAFF.find((s) => s.role === role);
  await services.auth.signInWithPin(person?.id ?? '', person?.pin ?? '');
  return { server, services };
}

describe('the mock menu editor answers like the API', () => {
  test('a manager reads the lists with archived rows, and the costs', async () => {
    const { services } = await signedIn('manager');
    const { items } = await services.api.menu.listItems({ includeArchived: true });
    expect(items.length).toBeGreaterThan(5);
    const costs = await services.api.menu.costs();
    expect(costs.items.length).toBe(items.length);
  });

  test('a cashier may not read archived rows, costs, or change the menu, but may mark sold out', async () => {
    const { services } = await signedIn('cashier');
    await expect(services.api.menu.listItems({ includeArchived: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(services.api.menu.costs()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(services.api.menu.createCategory({ nameTh: 'ก' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const { items } = await services.api.menu.listItems();
    const dish = items[0];
    if (!dish) throw new Error('no dish');
    const toggled = await services.api.menu.setItemAvailable(dish.id, { isAvailable: false });
    expect(toggled.isAvailable).toBe(false);
  });

  test('a create is idempotent: the same key and content returns the row (200), other content is refused', async () => {
    const { services } = await signedIn('manager');
    const key = crypto.randomUUID();
    const first = await services.api.menu.createCategory(
      { nameTh: 'ของหวาน' },
      { clientRequestId: key },
    );
    const again = await services.api.menu.createCategory(
      { nameTh: 'ของหวาน' },
      { clientRequestId: key },
    );
    expect(first.replay).toBe(false);
    expect(again.replay).toBe(true);
    expect(again.row.id).toBe(first.row.id);
    await expect(
      services.api.menu.createCategory({ nameTh: 'อย่างอื่น' }, { clientRequestId: key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });

  test('a patch with an old version is refused with the current one', async () => {
    const { services } = await signedIn('manager');
    const { categories } = await services.api.menu.listCategories();
    const cat = categories[0];
    if (!cat) throw new Error('no category');
    const changed = await services.api.menu.patchCategory(cat.id, {
      expectedVersion: cat.version,
      nameTh: 'ใหม่',
    });
    expect(changed.version).toBe(cat.version + 1);
    await expect(
      services.api.menu.patchCategory(cat.id, { expectedVersion: cat.version, nameTh: 'อีก' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: changed.version });
  });

  test('reorder moves a whole set at once, and refuses a set that is not the whole one', async () => {
    const { services } = await signedIn('manager');
    const { categories } = await services.api.menu.listCategories();
    const order = categories.map((c) => ({ id: c.id, expectedVersion: c.version }));
    const reversed = [...order].reverse();
    const answer = await services.api.menu.reorder({ kind: 'categories', order: reversed });
    expect(answer.changed).toBeGreaterThan(0);
    expect(answer.rows.map((r) => r.id)).toEqual(reversed.map((o) => o.id));
    await expect(
      services.api.menu.reorder({ kind: 'categories', order: reversed.slice(1) }),
    ).rejects.toMatchObject({ code: 'REORDER_SET_MISMATCH' });
    // the old versions are stale now
    await expect(services.api.menu.reorder({ kind: 'categories', order })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  test('the editor store works end to end against it', async () => {
    const { services } = await signedIn('manager');
    await services.menuEditor.load();
    expect(services.menuEditor.getState().status).toBe('ready');
    expect(services.menuEditor.getState().costs).not.toBeNull();
    const [category] = [...services.entities.getState().categories.values()];
    if (!category) throw new Error('no category');
    const made = await services.menuEditor.createItem({
      categoryId: category.id,
      nameTh: 'โกโก้',
      priceSatang: satang(3500),
      channels: ['storefront'],
      estCostSatang: satang(1200),
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(services.entities.getState().items.get(made.value.id)?.nameTh).toBe('โกโก้');
    expect(services.menuEditor.getState().costs?.items[made.value.id]).toBe(1200);
  });
});

describe('the mock photo route', () => {
  async function dish() {
    const env = await signedIn('manager');
    const { items } = await env.services.api.menu.listItems();
    const item = items[0];
    if (!item) throw new Error('no dish');
    return { ...env, item };
  }

  test('stores a clean picture and keeps what it got for inspection', async () => {
    const { server, services, item } = await dish();
    const bytes = fakeJpeg(30_000);
    const updated = await services.api.menu.putPhoto(
      item.id,
      new Blob([bytes], { type: 'image/jpeg' }),
    );
    expect(updated.photoUrl).toContain(`/photo?v=${updated.photoVersion}`);
    const kept = server.lastPhoto();
    expect(kept?.contentType).toBe('image/jpeg');
    expect(kept?.bytes.length).toBe(30_000);
    expect((await services.api.menu.removePhoto(item.id)).photoUrl ?? null).toBeNull();
  });

  test('refuses what the real server refuses: the wrong type, too big, not an image', async () => {
    const { services, item } = await dish();
    await expect(
      services.api.menu.putPhoto(item.id, new Blob([fakeJpeg(30_000)], { type: 'image/png' })),
    ).rejects.toMatchObject({ code: 'PHOTO_TYPE_MISMATCH' });
    await expect(
      services.api.menu.putPhoto(item.id, new Blob([fakeJpeg(250_000)], { type: 'image/jpeg' })),
    ).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
    await expect(
      services.api.menu.putPhoto(item.id, new Blob([new Uint8Array(500)], { type: 'image/jpeg' })),
    ).rejects.toMatchObject({ code: 'PHOTO_NOT_AN_IMAGE' });
  });

  test('where the browser cannot decode the file, the app uploads nothing', async () => {
    const { server, services, item } = await dish();
    // The services use the browser's picture engine; node has no canvas, so it cannot decode.
    // (What a real canvas does to the bytes is checked in a browser: see the Chrome run.)
    const clean = await services.menuEditor.setPhoto(
      { id: item.id },
      new Blob([fakeExifJpeg()], { type: 'image/jpeg' }),
    );
    expect(clean).toMatchObject({ ok: false, reason: 'photo', failure: 'unreadable' });
    expect(server.lastPhoto()).toBeNull();
  });
});
