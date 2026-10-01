import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as repo from './menu.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const item = (categoryId: string, over: Partial<repo.NewItem> = {}): repo.NewItem => ({
  categoryId,
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

describe('items, channel prices and attached groups', () => {
  test('channel prices and groups are replaced as a whole, groups in the given order', async () => {
    const cat = await repo.insertCategory(db, { nameTh: 'หมวด', nameEn: null, sort: 0 });
    const it = await repo.insertItem(db, item(cat.id));
    const g1 = await repo.insertGroup(db, {
      nameTh: 'ก',
      nameEn: null,
      minSelect: 0,
      maxSelect: 1,
      sort: 0,
    });
    const g2 = await repo.insertGroup(db, {
      nameTh: 'ข',
      nameEn: null,
      minSelect: 0,
      maxSelect: 1,
      sort: 0,
    });

    await repo.replaceItemChannelPrices(db, it.id, { grab: 6500, lineman: 6800 });
    await repo.replaceItemGroups(db, it.id, [g2.id, g1.id]);
    let extras = await repo.loadItemExtras(db, [it.id]);
    expect(extras.channelPrices.get(it.id)).toEqual({ grab: 6500, lineman: 6800 });
    expect(extras.groupIds.get(it.id)).toEqual([g2.id, g1.id]);

    await repo.replaceItemChannelPrices(db, it.id, { grab: 7000 });
    await repo.replaceItemGroups(db, it.id, [g1.id]);
    extras = await repo.loadItemExtras(db, [it.id]);
    expect(extras.channelPrices.get(it.id)).toEqual({ grab: 7000 });
    expect(extras.groupIds.get(it.id)).toEqual([g1.id]);

    await repo.replaceItemChannelPrices(db, it.id, {});
    expect((await repo.loadItemExtras(db, [it.id])).channelPrices.get(it.id)).toBeUndefined();
    expect((await repo.loadItemExtras(db, [])).groupIds.size).toBe(0);
  });

  test('an update needs the version the caller saw', async () => {
    const cat = await repo.insertCategory(db, { nameTh: 'หมวด 2', nameEn: null, sort: 1 });
    const it = await repo.insertItem(db, item(cat.id));
    const updated = await repo.updateItemIfVersion(db, it.id, 1, { priceSatang: 5500 });
    expect(updated).toMatchObject({ priceSatang: 5500, version: 2 });
    expect(await repo.updateItemIfVersion(db, it.id, 1, { priceSatang: 6000 })).toBeUndefined();
  });

  test('archived items are left out of the list unless asked for', async () => {
    const cat = await repo.insertCategory(db, { nameTh: 'หมวด 3', nameEn: null, sort: 2 });
    const live = await repo.insertItem(db, item(cat.id, { nameTh: 'มี' }));
    const gone = await repo.insertItem(db, item(cat.id, { nameTh: 'เลิก' }));
    await repo.updateItemIfVersion(db, gone.id, 1, { archivedAt: new Date() });
    const ids = (rows: repo.ItemRow[]) => rows.map((r) => r.id);
    expect(ids(await repo.listItems(db, { includeArchived: false }))).toContain(live.id);
    expect(ids(await repo.listItems(db, { includeArchived: false }))).not.toContain(gone.id);
    expect(ids(await repo.listItems(db, { includeArchived: true }))).toContain(gone.id);
  });
});

describe('the public menu', () => {
  test('holds only what can be ordered on the channel: available, live, offered, in an active category', async () => {
    const active = await repo.insertCategory(db, { nameTh: 'เปิด', nameEn: null, sort: 10 });
    const closed = await repo.insertCategory(db, { nameTh: 'ปิด', nameEn: null, sort: 11 });
    await repo.updateCategoryIfVersion(db, closed.id, 1, { active: false });

    const ok = await repo.insertItem(db, item(active.id, { nameTh: 'ได้', channels: ['grab'] }));
    const soldOut = await repo.insertItem(
      db,
      item(active.id, { nameTh: 'หมด', channels: ['grab'], isAvailable: false }),
    );
    const archived = await repo.insertItem(
      db,
      item(active.id, { nameTh: 'เลิก', channels: ['grab'] }),
    );
    await repo.updateItemIfVersion(db, archived.id, 1, { archivedAt: new Date() });
    const otherChannel = await repo.insertItem(
      db,
      item(active.id, { nameTh: 'ช่องอื่น', channels: ['line'] }),
    );
    await repo.replaceItemChannelPrices(db, ok.id, { grab: 6500, line: 1 });

    const group = await repo.insertGroup(db, {
      nameTh: 'ท็อปปิ้ง',
      nameEn: null,
      minSelect: 0,
      maxSelect: 2,
      sort: 0,
    });
    const [live, off, retired] = await repo.insertOptions(db, [
      {
        groupId: group.id,
        nameTh: 'ไข่',
        nameEn: null,
        priceDeltaSatang: 500,
        costDeltaSatang: 300,
        isAvailable: true,
        sort: 1,
      },
      {
        groupId: group.id,
        nameTh: 'หมดแล้ว',
        nameEn: null,
        priceDeltaSatang: 0,
        costDeltaSatang: 0,
        isAvailable: false,
        sort: 2,
      },
      {
        groupId: group.id,
        nameTh: 'เลิก',
        nameEn: null,
        priceDeltaSatang: 0,
        costDeltaSatang: 0,
        isAvailable: true,
        sort: 3,
      },
    ]);
    await repo.updateOptionIfVersion(db, retired?.id ?? '', 1, { archivedAt: new Date() });
    await repo.replaceItemGroups(db, ok.id, [group.id]);

    const menu = await repo.loadPublicMenu(db, 'grab');
    const itemIds = menu.items.map((i) => i.id);
    expect(itemIds).toContain(ok.id);
    for (const hidden of [soldOut.id, archived.id, otherChannel.id])
      expect(itemIds).not.toContain(hidden);
    expect(menu.categories.map((c) => c.id)).toContain(active.id);
    expect(menu.categories.map((c) => c.id)).not.toContain(closed.id);
    // Only this channel's price override is loaded.
    expect(menu.prices.filter((p) => p.itemId === ok.id)).toEqual([
      { itemId: ok.id, channel: 'grab', priceSatang: 6500 },
    ]);
    expect(menu.groups.map((g) => g.id)).toEqual([group.id]);
    expect(menu.options.map((o) => o.id)).toEqual([live?.id]);
    expect(menu.options.map((o) => o.id)).not.toContain(off?.id);
  });
});
