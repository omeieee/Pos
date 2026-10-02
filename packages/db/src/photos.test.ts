import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as repo from './menu.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as sync from './sync.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61',
  'hex',
);
const photo = (over: Partial<repo.NewPhoto> = {}): repo.NewPhoto => ({
  contentType: 'image/png',
  bytes: png,
  width: 16,
  height: 16,
  version: 2,
  ...over,
});

async function makeItem(over: Partial<repo.NewItem> = {}, active = true) {
  const cat = await repo.insertCategory(db, { nameTh: 'หมวดรูป', nameEn: null, sort: 0 });
  if (!active) await repo.updateCategoryIfVersion(db, cat.id, 1, { active: false });
  return repo.insertItem(db, {
    categoryId: cat.id,
    nameTh: 'ก๋วยเตี๋ยว',
    nameEn: null,
    descriptionTh: null,
    descriptionEn: null,
    priceSatang: 5000,
    estCostSatang: 2200,
    imageKey: null,
    channels: ['storefront', 'line'],
    sort: 0,
    isAvailable: true,
    ...over,
  });
}

/** Stores a photo and points the item at it, the way the API does in one transaction. */
async function withPhoto(it: { id: string; version: number }, over: Partial<repo.NewPhoto> = {}) {
  const p = photo(over);
  await repo.setPhoto(db, it.id, p);
  await repo.updateItemIfVersion(db, it.id, it.version, { photoVersion: p.version });
  return p;
}

describe('item photos (D-21)', () => {
  test('the bytes come back byte for byte as a Buffer, whatever the driver returns', async () => {
    const it = await makeItem();
    await repo.setPhoto(db, it.id, photo());
    const found = await repo.findPhoto(db, it.id);
    expect(Buffer.isBuffer(found?.bytes)).toBe(true);
    expect(found?.bytes.equals(png)).toBe(true);
    expect(found).toMatchObject({ contentType: 'image/png', byteSize: png.length, version: 2 });
    // Binary that is not text (every byte value) survives too.
    const noise = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await repo.setPhoto(db, it.id, photo({ bytes: noise, version: 3 }));
    expect((await repo.findPhoto(db, it.id))?.bytes.equals(noise)).toBe(true);
  });

  test('replacing keeps one row per item; deleting removes it', async () => {
    const it = await makeItem();
    await repo.setPhoto(db, it.id, photo({ version: 5 }));
    await repo.setPhoto(db, it.id, photo({ version: 6 }));
    const count = await client.query(
      'select count(*)::int as n from menu_item_photos where menu_item_id = $1',
      [it.id],
    );
    expect(count.rows[0]).toEqual({ n: 1 });
    expect((await repo.findPhoto(db, it.id))?.version).toBe(6);
    expect(await repo.deletePhoto(db, it.id)).toBe(true);
    expect(await repo.findPhoto(db, it.id)).toBeUndefined();
    expect(await repo.deletePhoto(db, it.id)).toBe(false);
  });

  test('the table refuses a type, size or dimension the API would never write', async () => {
    const it = await makeItem();
    for (const bad of [
      photo({ contentType: 'image/gif' }),
      photo({ contentType: 'text/html' }),
      photo({ bytes: Buffer.alloc(200_001) }),
      photo({ bytes: Buffer.alloc(0) }),
      photo({ width: 0 }),
    ]) {
      await expect(repo.setPhoto(db, it.id, bad)).rejects.toThrow();
    }
  });

  test('only a live item of an active category with a photo is servable, at any availability', async () => {
    const it = await makeItem();
    expect(await repo.findServablePhoto(db, it.id)).toBeUndefined(); // no photo yet
    await repo.setPhoto(db, it.id, photo());
    expect(await repo.findServablePhoto(db, it.id)).toBeUndefined(); // a stray row: the item does not point at it
    await repo.updateItemIfVersion(db, it.id, it.version, { photoVersion: 2 });
    expect(await repo.findServablePhoto(db, it.id)).toMatchObject({
      version: 2,
      contentType: 'image/png',
    });

    const current = await repo.findItem(db, it.id);
    await repo.updateItemIfVersion(db, it.id, current?.version ?? 0, { archivedAt: new Date() });
    expect(await repo.findServablePhoto(db, it.id)).toBeUndefined(); // archived

    const hidden = await makeItem({}, false);
    await withPhoto(hidden);
    expect(await repo.findServablePhoto(db, hidden.id)).toBeUndefined(); // inactive category

    // A sold-out item is still on the staff till and its tile keeps its picture.
    const soldOut = await makeItem({ isAvailable: false });
    await withPhoto(soldOut);
    expect(await repo.findServablePhoto(db, soldOut.id)).toBeDefined();
  });

  test('the feed carries photo_version and nothing of the bytes', async () => {
    const it = await makeItem();
    const p = await withPhoto(it);
    expect(sync.SYNC_POLICY.menu_items.allow).toContain('photoVersion');
    expect(sync.SYNC_POLICY.menu_items.deny).not.toContain('photoVersion');
    const page = await sync.readChanges(db, {
      since: 0,
      limit: 1000,
      include: { orders: false, payments: false, menu: true, customers: false, settings: false },
    });
    const entry = page.entries.find((c) => c.kind === 'item' && c.item.id === it.id);
    expect(entry).toBeDefined();
    const text = JSON.stringify(page.entries);
    expect(text).not.toContain(png.toString('base64'));
    expect(text).not.toContain(png.toString('hex'));
    expect(entry && 'item' in entry ? entry.item.photoVersion : null).toBe(p.version);
    expect(Object.keys(entry && 'item' in entry ? entry.item : {})).not.toContain('bytes');
  });
});
