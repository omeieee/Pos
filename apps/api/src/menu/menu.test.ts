import {
  type CategoryDto,
  categoryDtoSchema,
  type GroupDto,
  groupDtoSchema,
  type ItemDto,
  itemDtoSchema,
  optionDtoSchema,
  publicMenuResponseSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
function call(method: Method, url: string, token: string | undefined, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

const uid = () => crypto.randomUUID().slice(0, 8);

async function newCategory(token: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/menu/categories', token, {
    nameTh: `หมวด ${uid()}`,
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`category: ${res.statusCode} ${res.body}`);
  return categoryDtoSchema.parse(res.json());
}
async function newGroup(token: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/menu/modifier-groups', token, {
    nameTh: `กลุ่ม ${uid()}`,
    minSelect: 1,
    maxSelect: 1,
    options: [
      { nameTh: 'เส้นเล็ก' },
      { nameTh: 'เส้นใหญ่', priceDeltaSatang: 500, costDeltaSatang: 300 },
    ],
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`group: ${res.statusCode} ${res.body}`);
  return groupDtoSchema.parse(res.json());
}
async function newItem(token: string, categoryId: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/menu/items', token, {
    categoryId,
    nameTh: `เมนู ${uid()}`,
    priceSatang: 5000,
    estCostSatang: 2200,
    channels: ['storefront', 'line', 'grab'],
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`item: ${res.statusCode} ${res.body}`);
  return itemDtoSchema.parse(res.json());
}

const publicItemIds = async (channel?: string) => {
  const res = await call('GET', `/v1/menu${channel ? `?channel=${channel}` : ''}`, undefined);
  const menu = publicMenuResponseSchema.parse(res.json());
  return menu.categories.flatMap((c) => c.items.map((i) => i.id));
};

const rows = async (sql: string, params: unknown[] = []) =>
  (await h.client.query<Record<string, unknown>>(sql, params)).rows;

// ---------- who may do what ----------

describe('access', () => {
  test('the public menu needs no session; everything else does', async () => {
    expect((await call('GET', '/v1/menu', undefined)).statusCode).toBe(200);
    for (const [method, url] of [
      ['GET', '/v1/menu/categories'],
      ['POST', '/v1/menu/categories'],
      ['GET', '/v1/menu/items'],
      ['POST', '/v1/menu/items'],
      ['GET', '/v1/menu/modifier-groups'],
      ['POST', '/v1/menu/modifier-groups'],
      ['PATCH', `/v1/menu/items/${crypto.randomUUID()}/availability`],
    ] as const) {
      expect((await call(method, url, undefined, {})).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('every role can read the staff lists; only managers and the owner can edit', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    for (const role of ['cashier', 'kitchen'] as const) {
      const token = await as(role);
      for (const url of ['/v1/menu/categories', '/v1/menu/items', '/v1/menu/modifier-groups']) {
        expect((await call('GET', url, token)).statusCode, `${role} ${url}`).toBe(200);
      }
      const denied = [
        await call('POST', '/v1/menu/categories', token, { nameTh: 'x' }),
        await call('PATCH', `/v1/menu/categories/${cat.id}`, token, {
          expectedVersion: 1,
          nameTh: 'y',
        }),
        await call('DELETE', `/v1/menu/categories/${cat.id}`, token),
        await call('POST', '/v1/menu/items', token, {
          categoryId: cat.id,
          nameTh: 'x',
          priceSatang: 1,
          channels: ['storefront'],
        }),
        await call('POST', '/v1/menu/modifier-groups', token, {
          nameTh: 'x',
          minSelect: 0,
          maxSelect: 1,
        }),
        await call('GET', '/v1/menu/items?includeArchived=true', token),
      ];
      for (const res of denied) {
        expect(res.statusCode, role).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });
});

// ---------- categories ----------

describe('categories', () => {
  test('create, list, rename with the version, and a stale version is a conflict', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager, { nameTh: 'ก๋วยเตี๋ยว', nameEn: 'Noodles', sort: 3 });
    expect(cat).toMatchObject({
      nameTh: 'ก๋วยเตี๋ยว',
      nameEn: 'Noodles',
      sort: 3,
      active: true,
      version: 1,
    });

    const list = (await call('GET', '/v1/menu/categories', await as('cashier'))).json() as {
      categories: CategoryDto[];
    };
    expect(list.categories.map((c) => c.id)).toContain(cat.id);

    const renamed = await call('PATCH', `/v1/menu/categories/${cat.id}`, manager, {
      expectedVersion: 1,
      nameTh: 'เส้น',
    });
    expect(renamed.json()).toMatchObject({ nameTh: 'เส้น', version: 2 });
    expect(renamed.json().rev).toBeGreaterThan(cat.rev);
    const stale = await call('PATCH', `/v1/menu/categories/${cat.id}`, manager, {
      expectedVersion: 1,
      nameTh: 'เก่า',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
  });

  test('deleting a category hides it (and its items) from the menu but keeps the rows', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const item = await newItem(manager, cat.id);
    expect(await publicItemIds()).toContain(item.id);
    const res = await call('DELETE', `/v1/menu/categories/${cat.id}`, manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: false });
    expect(await publicItemIds()).not.toContain(item.id);
    expect(await rows('select id from menu_categories where id = $1', [cat.id])).toHaveLength(1);
  });

  test('refuses an empty name and unknown fields; unknown id is 404', async () => {
    const manager = await as('manager');
    expect((await call('POST', '/v1/menu/categories', manager, { nameTh: '  ' })).statusCode).toBe(
      400,
    );
    expect(
      (await call('POST', '/v1/menu/categories', manager, { nameTh: 'x', rev: 9 })).statusCode,
    ).toBe(400);
    const res = await call('PATCH', `/v1/menu/categories/${crypto.randomUUID()}`, manager, {
      expectedVersion: 1,
      nameTh: 'x',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------- modifier groups and options ----------

describe('modifier groups and options', () => {
  test('a group is created with its options; costs are accepted but never shown', async () => {
    const manager = await as('manager');
    const res = await call('POST', '/v1/menu/modifier-groups', manager, {
      nameTh: 'เส้น',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { nameTh: 'เส้นเล็ก' },
        { nameTh: 'พิเศษ', priceDeltaSatang: 1000, costDeltaSatang: 500 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toMatch(/cost/i);
    const group = groupDtoSchema.parse(res.json());
    expect(group.options.map((o) => [o.nameTh, o.priceDeltaSatang])).toEqual([
      ['เส้นเล็ก', 0],
      ['พิเศษ', 1000],
    ]);
    const stored = await rows('select cost_delta_satang from modifier_options where id = $1', [
      group.options[1]?.id,
    ]);
    expect(Number(stored[0]?.cost_delta_satang)).toBe(500);
  });

  test('min above max is refused; patch needs the version', async () => {
    const manager = await as('manager');
    expect(
      (
        await call('POST', '/v1/menu/modifier-groups', manager, {
          nameTh: 'x',
          minSelect: 3,
          maxSelect: 1,
        })
      ).statusCode,
    ).toBe(400);
    const g = await newGroup(manager);
    const ok = await call('PATCH', `/v1/menu/modifier-groups/${g.id}`, manager, {
      expectedVersion: 1,
      maxSelect: 3,
    });
    expect(ok.json()).toMatchObject({ maxSelect: 3, version: 2 });
    // The merged range must still be valid: min 1 against a new max of... lowering max below min.
    const bad = await call('PATCH', `/v1/menu/modifier-groups/${g.id}`, manager, {
      expectedVersion: 2,
      maxSelect: 1,
      minSelect: 2,
    });
    expect(bad.statusCode).toBe(400);
    const lowered = await call('PATCH', `/v1/menu/modifier-groups/${g.id}`, manager, {
      expectedVersion: 2,
      minSelect: 5,
    });
    expect(lowered.statusCode).toBe(400); // 5 is above the stored max of 3
    expect(
      (
        await call('PATCH', `/v1/menu/modifier-groups/${g.id}`, manager, {
          expectedVersion: 1,
          nameTh: 'เก่า',
        })
      ).statusCode,
    ).toBe(409);
  });

  test('options can be added, edited, archived and marked sold out', async () => {
    const manager = await as('manager');
    const kitchen = await as('kitchen');
    const g = await newGroup(manager);
    const added = await call('POST', `/v1/menu/modifier-groups/${g.id}/options`, manager, {
      nameTh: 'ไข่',
      priceDeltaSatang: 500,
      costDeltaSatang: 300,
    });
    expect(added.statusCode).toBe(201);
    const option = optionDtoSchema.parse(added.json());
    expect(option).toMatchObject({
      groupId: g.id,
      priceDeltaSatang: 500,
      isAvailable: true,
      archived: false,
    });

    const edited = await call('PATCH', `/v1/menu/modifier-options/${option.id}`, manager, {
      expectedVersion: 1,
      priceDeltaSatang: 600,
    });
    expect(edited.json()).toMatchObject({ priceDeltaSatang: 600, version: 2 });

    // The kitchen can mark an option sold out, but cannot edit it.
    const off = await call(
      'PATCH',
      `/v1/menu/modifier-options/${option.id}/availability`,
      kitchen,
      { isAvailable: false },
    );
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ isAvailable: false });
    expect(
      (
        await call('PATCH', `/v1/menu/modifier-options/${option.id}`, kitchen, {
          expectedVersion: 3,
          priceDeltaSatang: 1,
        })
      ).statusCode,
    ).toBe(403);

    const gone = await call('DELETE', `/v1/menu/modifier-options/${option.id}`, manager);
    expect(gone.json()).toMatchObject({ archived: true });
    const list = (await call('GET', '/v1/menu/modifier-groups', manager)).json() as {
      groups: GroupDto[];
    };
    const listed = list.groups.find((x) => x.id === g.id);
    expect(listed?.options.map((o) => o.id)).not.toContain(option.id);
  });

  test('archiving a group removes it from the list and from the public menu, keeping the row', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id, { modifierGroupIds: [g.id] });
    const publicGroups = async () => {
      const menu = publicMenuResponseSchema.parse(
        (await call('GET', '/v1/menu', undefined)).json(),
      );
      return menu.categories
        .flatMap((c) => c.items)
        .find((i) => i.id === item.id)
        ?.modifierGroups.map((x) => x.id);
    };
    expect(await publicGroups()).toEqual([g.id]);
    const res = await call('DELETE', `/v1/menu/modifier-groups/${g.id}`, manager);
    expect(res.json()).toMatchObject({ archived: true });
    expect(await publicGroups()).toEqual([]);
    expect(await rows('select id from modifier_groups where id = $1', [g.id])).toHaveLength(1);
  });
});

// ---------- items ----------

describe('items', () => {
  test('create returns the item without any cost, with channels, channel prices, groups and photo', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const res = await call('POST', '/v1/menu/items', manager, {
      categoryId: cat.id,
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      nameEn: 'Tom yum noodles',
      descriptionTh: 'รสจัด',
      priceSatang: 5000,
      estCostSatang: 2200,
      imageUrl: 'https://img.example.test/tomyum.jpg',
      channels: ['storefront', 'grab'],
      channelPrices: { grab: 6500 },
      modifierGroupIds: [g.id],
      sort: 2,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toMatch(/cost/i);
    const item = itemDtoSchema.parse(res.json());
    expect(item).toMatchObject({
      categoryId: cat.id,
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      priceSatang: 5000,
      imageUrl: 'https://img.example.test/tomyum.jpg',
      isAvailable: true,
      channels: ['storefront', 'grab'],
      channelPrices: { grab: 6500 },
      modifierGroupIds: [g.id],
      archived: false,
      version: 1,
    });
    const stored = await rows('select est_cost_satang, image_key from menu_items where id = $1', [
      item.id,
    ]);
    expect(Number(stored[0]?.est_cost_satang)).toBe(2200);
  });

  test('refuses what does not make sense, with a clear code', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const archivedGroup = await newGroup(manager);
    await call('DELETE', `/v1/menu/modifier-groups/${archivedGroup.id}`, manager);
    const base = { categoryId: cat.id, nameTh: 'x', priceSatang: 5000, channels: ['storefront'] };
    const cases: [string, Record<string, unknown>, number, string][] = [
      ['a negative price', { priceSatang: -1 }, 400, 'VALIDATION_ERROR'],
      ['a price with a fraction', { priceSatang: 50.5 }, 400, 'VALIDATION_ERROR'],
      ['an http photo', { imageUrl: 'http://img.example.test/a.jpg' }, 400, 'VALIDATION_ERROR'],
      ['no channel', { channels: [] }, 400, 'VALIDATION_ERROR'],
      ['an unknown category', { categoryId: crypto.randomUUID() }, 422, 'UNKNOWN_CATEGORY'],
      ['an unknown group', { modifierGroupIds: [crypto.randomUUID()] }, 422, 'UNKNOWN_GROUP'],
      ['an archived group', { modifierGroupIds: [archivedGroup.id] }, 422, 'UNKNOWN_GROUP'],
    ];
    for (const [label, over, status, code] of cases) {
      const res = await call('POST', '/v1/menu/items', manager, { ...base, ...over });
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toMatchObject({ code });
    }
  });

  test('a change needs the version; price, channel prices and groups can be replaced; rev and version bump', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g1 = await newGroup(manager);
    const g2 = await newGroup(manager);
    const item = await newItem(manager, cat.id, {
      channelPrices: { grab: 6500 },
      modifierGroupIds: [g1.id],
    });

    const res = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: 1,
      priceSatang: 5500,
      channelPrices: { lineman: 6800 },
      modifierGroupIds: [g2.id, g1.id],
    });
    expect(res.statusCode).toBe(200);
    const updated = itemDtoSchema.parse(res.json());
    expect(updated).toMatchObject({
      priceSatang: 5500,
      channelPrices: { lineman: 6800 },
      modifierGroupIds: [g2.id, g1.id],
      version: 2,
    });
    expect(updated.rev).toBeGreaterThan(item.rev);

    const stale = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: 1,
      priceSatang: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    expect(
      (await call('PATCH', `/v1/menu/items/${item.id}`, manager, { priceSatang: 1 })).statusCode,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/v1/menu/items/${crypto.randomUUID()}`, manager, {
          expectedVersion: 1,
          priceSatang: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  test('changing only the attached groups still counts as a change (version and rev move)', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id);
    const res = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: 1,
      modifierGroupIds: [g.id],
    });
    expect(res.json()).toMatchObject({ version: 2, modifierGroupIds: [g.id] });
    expect(res.json().rev).toBeGreaterThan(item.rev);
  });

  test('two managers saving at once: one wins, one is told to reload', async () => {
    const a = await as('manager');
    const b = await as('manager');
    const item = await newItem(a, (await newCategory(a)).id);
    const [x, y] = await Promise.all([
      call('PATCH', `/v1/menu/items/${item.id}`, a, { expectedVersion: 1, priceSatang: 5100 }),
      call('PATCH', `/v1/menu/items/${item.id}`, b, { expectedVersion: 1, priceSatang: 5200 }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
  });

  test('the staff list shows sold-out items too; archived ones only to people who can edit', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const sold = await newItem(manager, cat.id, { isAvailable: false });
    const gone = await newItem(manager, cat.id);
    await call('DELETE', `/v1/menu/items/${gone.id}`, manager);

    const cashier = await as('cashier');
    const ids = async (token: string, query = '') =>
      (
        (await call('GET', `/v1/menu/items${query}`, token)).json() as { items: ItemDto[] }
      ).items.map((i) => i.id);
    expect(await ids(cashier)).toContain(sold.id);
    expect(await ids(cashier)).not.toContain(gone.id);
    expect(await ids(manager, '?includeArchived=true')).toContain(gone.id);
  });

  test('one item can be read by id', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const res = await call('GET', `/v1/menu/items/${item.id}`, await as('cashier'));
    expect(itemDtoSchema.parse(res.json())).toEqual(item);
    expect((await call('GET', `/v1/menu/items/${crypto.randomUUID()}`, manager)).statusCode).toBe(
      404,
    );
  });
});

// ---------- deleting an item that has been sold ----------

describe('deleting an item soft-deletes it', () => {
  test('the row stays, the menu stops showing and selling it, and past orders keep their snapshot', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id, { nameTh: 'เมนูที่จะเลิก', modifierGroupIds: [g.id] });

    const order = await call('POST', '/v1/orders', manager, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'takeaway',
      items: [{ menuItemId: item.id, qty: 1, modifierOptionIds: [g.options[0]?.id] }],
    });
    expect(order.statusCode).toBe(201);

    const del = await call('DELETE', `/v1/menu/items/${item.id}`, manager);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ archived: true });
    expect(await rows('select archived_at from menu_items where id = $1', [item.id])).toHaveLength(
      1,
    );
    expect(await publicItemIds()).not.toContain(item.id);

    // Selling it again is refused...
    const again = await call('POST', '/v1/orders', manager, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'takeaway',
      items: [{ menuItemId: item.id, qty: 1, modifierOptionIds: [g.options[0]?.id] }],
    });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ code: 'ORDER_INVALID' });
    // ...but the old order still reads, with the name and price it was sold at.
    const old = await call('GET', `/v1/orders/${order.json().id}`, manager);
    expect(old.json().items[0]).toMatchObject({ nameTh: 'เมนูที่จะเลิก', unitPriceSatang: 5000 });
  });

  test('it can be restored with a PATCH, and then sells again', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const del = await call('DELETE', `/v1/menu/items/${item.id}`, manager);
    const back = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: del.json().version,
      archived: false,
    });
    expect(back.json()).toMatchObject({ archived: false });
    expect(await publicItemIds()).toContain(item.id);
  });

  test('deleting twice is harmless', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    await call('DELETE', `/v1/menu/items/${item.id}`, manager);
    const again = await call('DELETE', `/v1/menu/items/${item.id}`, manager);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ archived: true });
  });
});

// ---------- sold out ----------

describe('sold out (หมด)', () => {
  test('every role can toggle it; the item leaves the public menu and cannot be ordered; toggling back restores it', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id, { modifierGroupIds: [g.id] });
    const order = (token: string) =>
      call('POST', '/v1/orders', token, {
        clientRequestId: crypto.randomUUID(),
        channel: 'storefront',
        fulfillment: 'takeaway',
        items: [{ menuItemId: item.id, qty: 1, modifierOptionIds: [g.options[0]?.id] }],
      });

    for (const role of ['kitchen', 'cashier', 'manager'] as const) {
      const token = await as(role);
      const off = await call('PATCH', `/v1/menu/items/${item.id}/availability`, token, {
        isAvailable: false,
      });
      expect(off.statusCode, role).toBe(200);
      expect(off.json()).toMatchObject({ isAvailable: false });
      expect(await publicItemIds()).not.toContain(item.id);
      expect((await order(manager)).json()).toMatchObject({ code: 'ORDER_INVALID' });

      const on = await call('PATCH', `/v1/menu/items/${item.id}/availability`, token, {
        isAvailable: true,
      });
      expect(on.json()).toMatchObject({ isAvailable: true });
      expect(await publicItemIds()).toContain(item.id);
      expect((await order(manager)).statusCode).toBe(201);
    }
  });

  test('is audited, bumps version and rev, and is published once after commit', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const before = h.events.length;
    const res = await call('PATCH', `/v1/menu/items/${item.id}/availability`, await as('kitchen'), {
      isAvailable: false,
    });
    expect(res.json()).toMatchObject({ version: 2 });
    expect(res.json().rev).toBeGreaterThan(item.rev);
    const audit = (await h.auditRows(item.id)).find((a) => a.action === 'menu.availability');
    expect(audit).toMatchObject({
      entity: 'menu_items',
      before: { isAvailable: true },
      after: { isAvailable: false },
    });
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({
        type: 'menu.upserted',
        kind: 'item',
        id: item.id,
        rev: res.json().rev,
      }),
    ]);
  });

  test('setting what it already is changes nothing', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const before = h.events.length;
    const res = await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, {
      isAvailable: true,
    });
    expect(res.json()).toMatchObject({ version: 1 });
    expect(h.events.length).toBe(before);
  });

  test('an expectedVersion, when sent, is enforced', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: 1,
      priceSatang: 5100,
    });
    const stale = await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, {
      isAvailable: false,
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, {
          isAvailable: false,
          expectedVersion: 2,
        })
      ).statusCode,
    ).toBe(200);
  });

  test('refuses a missing flag; unknown item is 404', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    expect(
      (await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/v1/menu/items/${crypto.randomUUID()}/availability`, manager, {
          isAvailable: false,
        })
      ).statusCode,
    ).toBe(404);
  });
});

// ---------- the public menu ----------

describe('GET /v1/menu', () => {
  test('lists categories with their available items for the channel, at the channel price', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager, { nameTh: 'เมนูหลัก', sort: -50 });
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id, {
      nameTh: 'ก๋วยเตี๋ยว',
      channels: ['storefront', 'grab'],
      channelPrices: { grab: 6500 },
      modifierGroupIds: [g.id],
      imageUrl: 'https://img.example.test/a.jpg',
    });
    const fetch = async (channel?: string) => {
      const res = await call('GET', `/v1/menu${channel ? `?channel=${channel}` : ''}`, undefined);
      expect(res.statusCode).toBe(200);
      const menu = publicMenuResponseSchema.parse(res.json());
      const found = menu.categories.flatMap((c) => c.items).find((i) => i.id === item.id);
      return { menu, found, body: res.body };
    };
    const storefront = await fetch();
    expect(storefront.menu.channel).toBe('storefront');
    expect(storefront.found).toMatchObject({
      priceSatang: 5000,
      imageUrl: 'https://img.example.test/a.jpg',
    });
    expect(storefront.found?.modifierGroups[0]?.options.map((o) => o.priceDeltaSatang)).toEqual([
      0, 500,
    ]);
    expect(storefront.menu.categories[0]?.id).toBe(cat.id); // sorted by sort

    const grab = await fetch('grab');
    expect(grab.found?.priceSatang).toBe(6500);
    expect((await fetch('line')).found).toBeUndefined(); // not offered on LINE
  });

  test('never shows costs, ids of staff, or anything marked unavailable', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id, { estCostSatang: 1234, modifierGroupIds: [g.id] });
    await call('PATCH', `/v1/menu/modifier-options/${g.options[1]?.id}/availability`, manager, {
      isAvailable: false,
    });
    const res = await call('GET', '/v1/menu', undefined);
    expect(res.body).not.toMatch(/cost/i);
    expect(res.body).not.toContain('1234');
    const menu = publicMenuResponseSchema.parse(res.json());
    const found = menu.categories.flatMap((c) => c.items).find((i) => i.id === item.id);
    expect(found?.modifierGroups[0]?.options.map((o) => o.id)).toEqual([g.options[0]?.id]);
  });

  test('drops an item whose required group cannot be filled (it could never be ordered)', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    // Needs one of two options.
    const required = await newGroup(manager);
    // Needs two choices but only two exist: one sold out leaves too few.
    const pair = await newGroup(manager, { minSelect: 2, maxSelect: 2 });
    // Optional: sold-out options never block the item.
    const optional = await newGroup(manager, { minSelect: 0, maxSelect: 2 });
    const ok = await newItem(manager, cat.id, { modifierGroupIds: [required.id] });
    const needsAll = await newItem(manager, cat.id, { modifierGroupIds: [pair.id] });
    const soft = await newItem(manager, cat.id, { modifierGroupIds: [optional.id] });
    expect(await publicItemIds()).toEqual(expect.arrayContaining([ok.id, needsAll.id, soft.id]));

    const soldOut = (id: string | undefined) =>
      call('PATCH', `/v1/menu/modifier-options/${id}/availability`, manager, {
        isAvailable: false,
      });
    // One of two sold out: `required` still has one (enough), `pair` has too few, `optional` is fine.
    for (const g of [required, pair, optional]) await soldOut(g.options[1]?.id);
    let ids = await publicItemIds();
    expect(ids).toContain(ok.id);
    expect(ids).not.toContain(needsAll.id);
    expect(ids).toContain(soft.id);

    // Every option of the required group sold out: that item goes too; the optional one stays.
    await soldOut(required.options[0]?.id);
    await soldOut(optional.options[0]?.id);
    ids = await publicItemIds();
    expect(ids).not.toContain(ok.id);
    expect(ids).toContain(soft.id);

    // Bring one back: orderable again.
    await call(
      'PATCH',
      `/v1/menu/modifier-options/${required.options[0]?.id}/availability`,
      manager,
      {
        isAvailable: true,
      },
    );
    expect(await publicItemIds()).toContain(ok.id);
  });

  test('an unknown channel, or "phone", is a validation error', async () => {
    for (const channel of ['fax', 'phone']) {
      const res = await call('GET', `/v1/menu?channel=${channel}`, undefined);
      expect(res.statusCode, channel).toBe(400);
    }
  });
});

// ---------- events and audit ----------

describe('every write publishes after commit and is audited', () => {
  test('category, item and group changes publish menu.upserted with the committed rev', async () => {
    const manager = await as('manager');
    const before = h.events.length;
    const cat = await newCategory(manager);
    const g = await newGroup(manager);
    const item = await newItem(manager, cat.id);
    const kinds = h.events
      .slice(before)
      .map((e) => (e.type === 'menu.upserted' ? `${e.kind}:${e.id}` : e.type));
    expect(kinds).toEqual(
      expect.arrayContaining([`category:${cat.id}`, `group:${g.id}`, `item:${item.id}`]),
    );
    const itemEvent = h.events.find(
      (e) => e.type === 'menu.upserted' && e.kind === 'item' && e.id === item.id,
    );
    expect(itemEvent).toMatchObject({ rev: item.rev });
  });

  test('a refused write publishes nothing and audits nothing', async () => {
    const manager = await as('manager');
    const before = h.events.length;
    await call('POST', '/v1/menu/items', manager, {
      categoryId: crypto.randomUUID(),
      nameTh: 'x',
      priceSatang: 1,
      channels: ['storefront'],
    });
    await call('POST', '/v1/menu/categories', manager, { nameTh: ' ' });
    expect(h.events.length).toBe(before);
  });

  test('item changes are audited with before and after of what changed', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: 1,
      priceSatang: 5500,
    });
    const audit = (await h.auditRows(item.id)).filter((a) => a.action === 'menu.item_update');
    expect(audit.at(-1)).toMatchObject({
      before: { priceSatang: 5000 },
      after: { priceSatang: 5500 },
    });
    expect((await h.auditRows(item.id)).map((a) => a.action)).toContain('menu.item_create');
  });
});
