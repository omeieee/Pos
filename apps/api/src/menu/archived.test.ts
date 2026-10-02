/** Archived rows: readable only by menu.edit, and nothing new can be attached to them. */
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

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
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

async function newItem(token: string) {
  const cat = (
    await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}` })
  ).json() as CategoryDto;
  return (
    await call('POST', '/v1/menu/items', token, {
      categoryId: cat.id,
      nameTh: `i ${uid()}`,
      priceSatang: 5000,
      channels: ['storefront'],
    })
  ).json() as ItemDto;
}
const newGroup = async (token: string) =>
  (
    await call('POST', '/v1/menu/modifier-groups', token, {
      nameTh: `g ${uid()}`,
      minSelect: 0,
      maxSelect: 2,
    })
  ).json() as GroupDto;

describe('GET /v1/menu/items/:id', () => {
  test('an archived item is a 404 for cashier and kitchen and readable for menu.edit roles', async () => {
    const manager = await as('manager');
    const item = await newItem(manager);
    expect(await call('DELETE', `/v1/menu/items/${item.id}`, manager)).toMatchObject({
      statusCode: 200,
    });

    for (const role of ['cashier', 'kitchen'] as const) {
      const res = await call('GET', `/v1/menu/items/${item.id}`, await as(role));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    const asManager = await call('GET', `/v1/menu/items/${item.id}`, manager);
    expect(asManager.statusCode).toBe(200);
    expect(asManager.json()).toMatchObject({ id: item.id, archived: true });
  });

  test('a live item is still readable by every role, and an archived one is the same 404 as an unknown one', async () => {
    const manager = await as('manager');
    const live = await newItem(manager);
    const cashier = await as('cashier');
    expect((await call('GET', `/v1/menu/items/${live.id}`, cashier)).statusCode).toBe(200);

    const gone = await newItem(manager);
    await call('DELETE', `/v1/menu/items/${gone.id}`, manager);
    const archived = await call('GET', `/v1/menu/items/${gone.id}`, cashier);
    const unknown = await call('GET', `/v1/menu/items/${crypto.randomUUID()}`, cashier);
    expect(archived.statusCode).toBe(unknown.statusCode);
    expect(archived.json()).toEqual(unknown.json());

    // Restoring brings it back for the cashier.
    const archivedDto = (await call('GET', `/v1/menu/items/${gone.id}`, manager)).json() as ItemDto;
    await call('PATCH', `/v1/menu/items/${gone.id}`, manager, {
      expectedVersion: archivedDto.version,
      archived: false,
    });
    expect((await call('GET', `/v1/menu/items/${gone.id}`, cashier)).statusCode).toBe(200);
  });
});

describe('creating an option', () => {
  test('in an archived group is refused and writes nothing', async () => {
    const manager = await as('manager');
    const group = await newGroup(manager);
    await call('DELETE', `/v1/menu/modifier-groups/${group.id}`, manager);

    const before = h.events.length;
    const res = await call('POST', `/v1/menu/modifier-groups/${group.id}/options`, manager, {
      nameTh: 'ไข่ดาว',
      priceDeltaSatang: 1000,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_GROUP' });
    expect(h.events.length).toBe(before);
    const groups = (
      await call('GET', '/v1/menu/modifier-groups?includeArchived=true', manager)
    ).json() as { groups: GroupDto[] };
    expect(groups.groups.find((g) => g.id === group.id)?.options).toEqual([]);
  });

  test('in a live group still works, and in an unknown group is a 404', async () => {
    const manager = await as('manager');
    const group = await newGroup(manager);
    const ok = await call('POST', `/v1/menu/modifier-groups/${group.id}/options`, manager, {
      nameTh: 'ไข่ดาว',
    });
    expect(ok.statusCode).toBe(201);
    const none = await call(
      'POST',
      `/v1/menu/modifier-groups/${crypto.randomUUID()}/options`,
      manager,
      { nameTh: 'x' },
    );
    expect(none.statusCode).toBe(404);
  });

  test('works again once the group is restored', async () => {
    const manager = await as('manager');
    const group = await newGroup(manager);
    const gone = (
      await call('DELETE', `/v1/menu/modifier-groups/${group.id}`, manager)
    ).json() as GroupDto;
    await call('PATCH', `/v1/menu/modifier-groups/${group.id}`, manager, {
      expectedVersion: gone.version,
      archived: false,
    });
    const res = await call('POST', `/v1/menu/modifier-groups/${group.id}/options`, manager, {
      nameTh: 'ไข่ดาว',
    });
    expect(res.statusCode).toBe(201);
  });
});
