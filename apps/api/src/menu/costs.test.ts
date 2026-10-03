/**
 * Costs for the Settings menu editor: written with items and options, read back only by
 * `GET /v1/menu/costs` for report.view, and in no DTO, list or event.
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

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string | undefined,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}
const uid = () => crypto.randomUUID().slice(0, 8);

interface Costs {
  items: { id: string; estCostSatang: number }[];
  options: { id: string; costDeltaSatang: number }[];
}

async function seeded(token: string) {
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
  return { item, group };
}

describe('GET /v1/menu/costs', () => {
  test('a manager reads every cost, archived rows included, with no-store', async () => {
    const token = await as('manager');
    const { item, group } = await seeded(token);
    const [a, b] = group.options as [GroupDto['options'][number], GroupDto['options'][number]];
    await call('DELETE', `/v1/menu/modifier-options/${a.id}`, token);
    await call('DELETE', `/v1/menu/items/${item.id}`, token);

    const res = await call('GET', '/v1/menu/costs', token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as Costs;
    expect(body.items.find((i) => i.id === item.id)).toEqual({ id: item.id, estCostSatang: 1234 });
    expect(body.options.find((o) => o.id === a.id)).toEqual({ id: a.id, costDeltaSatang: 77 });
    expect(body.options.find((o) => o.id === b.id)).toEqual({ id: b.id, costDeltaSatang: 0 });
    expect(Object.keys(body).sort()).toEqual(['items', 'options']);
  });

  test('a cost changed by PATCH is read back', async () => {
    const token = await as('manager');
    const { item, group } = await seeded(token);
    const option = group.options[0];
    await call('PATCH', `/v1/menu/items/${item.id}`, token, {
      expectedVersion: item.version,
      estCostSatang: 1500,
    });
    await call('PATCH', `/v1/menu/modifier-options/${option?.id}`, token, {
      expectedVersion: option?.version,
      costDeltaSatang: 90,
    });
    const body = (await call('GET', '/v1/menu/costs', token)).json() as Costs;
    expect(body.items.find((i) => i.id === item.id)?.estCostSatang).toBe(1500);
    expect(body.options.find((o) => o.id === option?.id)?.costDeltaSatang).toBe(90);
  });

  test('cashier, kitchen and an unsigned caller are refused', async () => {
    for (const role of ['cashier', 'kitchen'] as const) {
      const res = await call('GET', '/v1/menu/costs', await as(role));
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/estCost|:\s*1234\b/);
    }
    expect((await call('GET', '/v1/menu/costs', undefined)).statusCode).toBe(401);
  });

  test('the item and group DTOs, the lists and the events still carry no cost', async () => {
    const token = await as('manager');
    const before = h.events.length;
    const { item, group } = await seeded(token);
    await call('PATCH', `/v1/menu/items/${item.id}`, token, {
      expectedVersion: item.version,
      estCostSatang: 4321,
    });
    const one = await call('GET', `/v1/menu/items/${item.id}`, await as('cashier'));
    const items = await call('GET', '/v1/menu/items', token);
    const groups = await call('GET', '/v1/menu/modifier-groups', token);
    const published = h.events.slice(before);
    expect(published.length).toBeGreaterThan(0);
    expect(
      JSON.stringify([item, group, one.json(), items.json(), groups.json(), published]),
    ).not.toMatch(/estCost|costDelta|:\s*(1234|4321)\b/);
  });
});
