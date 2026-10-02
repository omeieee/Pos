import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { categoryDto, groupDto, itemDto, optionDto, uuid } from '../test-support/frames.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';
const ITEM = uuid(10);
const GROUP = uuid(11);
const KEY = uuid(99);

function clientWith(responder: Parameters<typeof mockFetch>[0]) {
  const net = mockFetch(responder);
  const api = createApiClient({
    baseUrl: BASE,
    fetch: net.fetch,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
  });
  return { api, calls: net.calls };
}

describe('menu editor reads', () => {
  test('archived rows are asked for only when the editor wants them', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: { items: [], groups: [] } }));
    await api.menu.listItems();
    await api.menu.listItems({ includeArchived: true });
    await api.menu.listGroups({ includeArchived: true });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/menu/items`,
      `${BASE}/v1/menu/items?includeArchived=true`,
      `${BASE}/v1/menu/modifier-groups?includeArchived=true`,
    ]);
  });

  test('costs are read from their own route and parsed', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: {
        items: [{ id: ITEM, estCostSatang: 1800 }],
        options: [{ id: uuid(12), costDeltaSatang: -200 }],
      },
    }));
    const costs = await api.menu.costs();
    expect(costs.items[0]?.estCostSatang).toBe(1800);
    expect(costs.options[0]?.costDeltaSatang).toBe(-200);
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/costs`);
  });
});

describe('menu editor creates', () => {
  test('a create sends the request id in the body and in Idempotency-Key, and 201 is new', async () => {
    const { api, calls } = clientWith(() => ({
      status: 201,
      json: categoryDto(uuid(5), 3, { nameTh: 'ของหวาน' }),
    }));
    const result = await api.menu.createCategory({ nameTh: 'ของหวาน' }, { clientRequestId: KEY });
    expect(result).toMatchObject({ replay: false, clientRequestId: KEY });
    expect(bodyOf(calls[0])).toMatchObject({ nameTh: 'ของหวาน', clientRequestId: KEY });
    expect(calls[0]?.headers['idempotency-key']).toBe(KEY);
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/categories`);
  });

  test('without a given id it makes one, and 200 means the first try had landed', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: groupDto(GROUP, 4) }));
    const result = await api.menu.createGroup({ nameTh: 'เส้น', minSelect: 1, maxSelect: 1 });
    expect(result.replay).toBe(true);
    expect(result.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(calls[0])).toMatchObject({ clientRequestId: result.clientRequestId });
  });

  test('items and options post to their own routes with prices in satang', async () => {
    const { api, calls } = clientWith((call) =>
      call.url.endsWith('/options')
        ? { status: 201, json: optionDto(uuid(13), GROUP, 5) }
        : { status: 201, json: itemDto(ITEM, 6) },
    );
    await api.menu.createItem({
      categoryId: uuid(900),
      nameTh: 'ต้มยำ',
      priceSatang: satang(5000),
      channels: ['storefront'],
      channelPrices: { line: satang(5500) },
    });
    await api.menu.createOption(GROUP, { nameTh: 'ไข่', priceDeltaSatang: satang(1000) });
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/items`);
    expect(bodyOf(calls[0])).toMatchObject({ priceSatang: 5000, channelPrices: { line: 5500 } });
    expect(calls[1]?.url).toBe(`${BASE}/v1/menu/modifier-groups/${GROUP}/options`);
  });

  test('a create the shared schema refuses never reaches the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: {} }));
    await expect(api.menu.createCategory({ nameTh: '   ' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('menu editor changes', () => {
  test('a patch needs expectedVersion before it is sent', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: itemDto(ITEM, 7) }));
    await expect(
      // @ts-expect-error expectedVersion is required
      api.menu.patchItem(ITEM, { nameTh: 'ใหม่' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await api.menu.patchItem(ITEM, { expectedVersion: 3, nameTh: 'ใหม่' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/items/${ITEM}`);
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 3, nameTh: 'ใหม่' });
  });

  test('a path id that is not a UUID is refused before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: {} }));
    await expect(
      api.menu.patchCategory('../orders', { expectedVersion: 1, active: false }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test('sold out goes to the availability routes of the item and of the option', async () => {
    const { api, calls } = clientWith((call) =>
      call.url.includes('modifier-options')
        ? { status: 200, json: optionDto(uuid(13), GROUP, 8, { isAvailable: false }) }
        : { status: 200, json: itemDto(ITEM, 8, { isAvailable: false }) },
    );
    await api.menu.setItemAvailable(ITEM, { isAvailable: false, expectedVersion: 2 });
    await api.menu.setOptionAvailable(uuid(13), { isAvailable: false, expectedVersion: 1 });
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/items/${ITEM}/availability`);
    expect(calls[1]?.url).toBe(`${BASE}/v1/menu/modifier-options/${uuid(13)}/availability`);
  });

  test('reorder sends the whole set with the versions the editor saw', async () => {
    const { api, calls } = clientWith(() => ({
      status: 200,
      json: { kind: 'categories', parentId: null, changed: 1, rows: [] },
    }));
    await api.menu.reorder({
      kind: 'categories',
      order: [
        { id: uuid(1), expectedVersion: 2 },
        { id: uuid(2), expectedVersion: 5 },
      ],
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/reorder`);
    expect(bodyOf(calls[0])).toMatchObject({
      kind: 'categories',
      order: [
        { id: uuid(1), expectedVersion: 2 },
        { id: uuid(2), expectedVersion: 5 },
      ],
    });
  });

  test('a stale version and a changed set come back as their codes', async () => {
    const { api } = clientWith((call) =>
      call.url.endsWith('/reorder')
        ? apiError(409, 'REORDER_SET_MISMATCH')
        : apiError(409, 'VERSION_CONFLICT', { currentVersion: 9 }),
    );
    await expect(
      api.menu.reorder({ kind: 'groups', order: [{ id: uuid(1), expectedVersion: 1 }] }),
    ).rejects.toMatchObject({ code: 'REORDER_SET_MISMATCH', status: 409 });
    await expect(
      api.menu.patchGroup(GROUP, { expectedVersion: 1, archived: true }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 9 });
  });
});

describe('menu photos', () => {
  test('the upload is a PUT of the bytes with the blob type, not JSON', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: itemDto(ITEM, 9) }));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
    await api.menu.putPhoto(ITEM, new Blob([bytes], { type: 'image/jpeg' }));
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`${BASE}/v1/menu/items/${ITEM}/photo`);
    expect(calls[0]?.headers['content-type']).toBe('image/jpeg');
    expect([...(calls[0]?.bytes ?? [])]).toEqual([...bytes]);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_SESSION_TOKEN}`);
  });

  test('removing a photo is a DELETE with no body and no content type', async () => {
    const { api, calls } = clientWith(() => ({ status: 200, json: itemDto(ITEM, 10) }));
    await api.menu.removePhoto(ITEM);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  test('a too-large photo answers with a code the app can say in Thai', async () => {
    const { api } = clientWith(() => apiError(413, 'PHOTO_TOO_LARGE'));
    await expect(
      api.menu.putPhoto(ITEM, new Blob([new Uint8Array(4)], { type: 'image/jpeg' })),
    ).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE', status: 413 });
  });
});
