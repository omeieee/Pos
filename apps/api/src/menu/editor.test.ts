/**
 * What a Settings menu editor needs from the API (task 3): list everything including archived and
 * inactive rows, restore, reorder through `sort`, per-channel prices, and no costs in any response.
 */
import type { CategoryDto, GroupDto, ItemDto } from '@sds/shared';
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

async function manager() {
  const s = await h.newStaff('manager', '4821');
  return h.pinSession(device.token, s.id, '4821');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}
const uid = () => crypto.randomUUID().slice(0, 8);

describe('listing everything for the editor', () => {
  test('a manager sees inactive categories and, on request, archived items, groups and options', async () => {
    const token = await manager();
    const cat = (
      await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}` })
    ).json() as CategoryDto;
    const item = (
      await call('POST', '/v1/menu/items', token, {
        categoryId: cat.id,
        nameTh: `i ${uid()}`,
        priceSatang: 5000,
        estCostSatang: 1234,
        channels: ['storefront'],
      })
    ).json() as ItemDto;
    const group = (
      await call('POST', '/v1/menu/modifier-groups', token, {
        nameTh: `g ${uid()}`,
        minSelect: 0,
        maxSelect: 2,
        options: [{ nameTh: 'a', costDeltaSatang: 77 }, { nameTh: 'b' }],
      })
    ).json() as GroupDto;
    const optionA = group.options[0];
    if (!optionA) throw new Error('no option');

    await call('DELETE', `/v1/menu/items/${item.id}`, token);
    await call('DELETE', `/v1/menu/modifier-groups/${group.id}`, token);
    await call('DELETE', `/v1/menu/modifier-options/${optionA.id}`, token);
    await call('DELETE', `/v1/menu/categories/${cat.id}`, token);

    // Inactive categories are always in the staff list (the editor can switch them back on).
    const cats = (await call('GET', '/v1/menu/categories', token)).json() as {
      categories: CategoryDto[];
    };
    expect(cats.categories.find((c) => c.id === cat.id)).toMatchObject({ active: false });

    const hidden = (await call('GET', '/v1/menu/items', token)).json() as { items: ItemDto[] };
    expect(hidden.items.map((i) => i.id)).not.toContain(item.id);
    const all = (await call('GET', '/v1/menu/items?includeArchived=true', token)).json() as {
      items: ItemDto[];
    };
    expect(all.items.find((i) => i.id === item.id)).toMatchObject({ archived: true });

    const groups = (
      await call('GET', '/v1/menu/modifier-groups?includeArchived=true', token)
    ).json() as { groups: GroupDto[] };
    const listed = groups.groups.find((g) => g.id === group.id);
    expect(listed).toMatchObject({ archived: true });
    expect(listed?.options.find((o) => o.id === optionA.id)).toMatchObject({ archived: true });

    // Costs are in no response, for anyone.
    expect(JSON.stringify([cats, hidden, all, groups])).not.toMatch(/estCost|costDelta|1234/);
  });

  test('categories, groups and options are restored with a PATCH', async () => {
    const token = await manager();
    const cat = (
      await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}` })
    ).json() as CategoryDto;
    const off = (
      await call('DELETE', `/v1/menu/categories/${cat.id}`, token)
    ).json() as CategoryDto;
    const on = await call('PATCH', `/v1/menu/categories/${cat.id}`, token, {
      expectedVersion: off.version,
      active: true,
    });
    expect(on.json()).toMatchObject({ active: true });

    const group = (
      await call('POST', '/v1/menu/modifier-groups', token, {
        nameTh: `g ${uid()}`,
        minSelect: 0,
        maxSelect: 1,
        options: [{ nameTh: 'a' }],
      })
    ).json() as GroupDto;
    const gone = (
      await call('DELETE', `/v1/menu/modifier-groups/${group.id}`, token)
    ).json() as GroupDto;
    const back = await call('PATCH', `/v1/menu/modifier-groups/${group.id}`, token, {
      expectedVersion: gone.version,
      archived: false,
    });
    expect(back.json()).toMatchObject({ archived: false });

    const optionId = group.options[0]?.id ?? '';
    const removed = (await call('DELETE', `/v1/menu/modifier-options/${optionId}`, token)).json();
    const restored = await call('PATCH', `/v1/menu/modifier-options/${optionId}`, token, {
      expectedVersion: removed.version,
      archived: false,
    });
    expect(restored.json()).toMatchObject({ archived: false });
  });
});

describe('ordering and channel prices', () => {
  test('sort decides the order of the lists, and a stale version on a reorder is a conflict', async () => {
    const token = await manager();
    const cat = (
      await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}` })
    ).json() as CategoryDto;
    const make = async (sort: number) =>
      (
        await call('POST', '/v1/menu/items', token, {
          categoryId: cat.id,
          nameTh: `i ${uid()}`,
          priceSatang: 100,
          channels: ['storefront'],
          sort,
        })
      ).json() as ItemDto;
    const [a, b, c] = [await make(10), await make(20), await make(30)] as [
      ItemDto,
      ItemDto,
      ItemDto,
    ];

    // Move c to the top.
    const moved = await call('PATCH', `/v1/menu/items/${c.id}`, token, {
      expectedVersion: c.version,
      sort: 5,
    });
    expect(moved.json()).toMatchObject({ sort: 5, version: 2 });
    const order = (
      (await call('GET', '/v1/menu/items', token)).json() as { items: ItemDto[] }
    ).items
      .filter((i) => i.categoryId === cat.id)
      .map((i) => i.id);
    expect(order).toEqual([c.id, a.id, b.id]);

    const stale = await call('PATCH', `/v1/menu/items/${c.id}`, token, {
      expectedVersion: c.version,
      sort: 99,
    });
    expect(stale.statusCode).toBe(409);
  });

  test('each channel can have its own price, replaced as a whole, and an empty set clears them', async () => {
    const token = await manager();
    const cat = (
      await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}` })
    ).json() as CategoryDto;
    const item = (
      await call('POST', '/v1/menu/items', token, {
        categoryId: cat.id,
        nameTh: `i ${uid()}`,
        priceSatang: 5000,
        channels: ['storefront', 'grab', 'lineman'],
        channelPrices: { grab: 6500 },
      })
    ).json() as ItemDto;
    expect(item.channelPrices).toEqual({ grab: 6500 });
    const patched = (
      await call('PATCH', `/v1/menu/items/${item.id}`, token, {
        expectedVersion: item.version,
        channelPrices: { grab: 6600, lineman: 6800 },
      })
    ).json() as ItemDto;
    expect(patched.channelPrices).toEqual({ grab: 6600, lineman: 6800 });
    const cleared = (
      await call('PATCH', `/v1/menu/items/${item.id}`, token, {
        expectedVersion: patched.version,
        channelPrices: {},
      })
    ).json() as ItemDto;
    expect(cleared.channelPrices).toEqual({});
  });
});
