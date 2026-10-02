import { satang } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiClient } from '../api/client.ts';
import { createStore } from '../lib/store.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
import { CATALOGUE_KEY, createCatalogueCache } from '../pos/catalogue-cache.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { FAKE_DEVICE_TOKEN, FAKE_SESSION_TOKEN, mockFetch } from '../test-support/fixtures.ts';
import { categoryDto, groupDto, itemDto, uuid } from '../test-support/frames.ts';
import { cleanEngine } from '../test-support/menu-editor-env.ts';
import { createMenuEditorStore } from './menu-editor-store.ts';

/**
 * The estimated costs are for the editor screen of roles with report.view and for nothing else:
 * not the entity store the till sells from, and above all not the copy of the menu that is saved
 * on the device. This runs the whole path with the real API client, the real entity store, the
 * real editor store and the real catalogue cache, over a server that LEAKS the costs into its
 * item and option answers (the worst case), and reads what was written to the device.
 */

const CATEGORY = uuid(1);
const ITEM = uuid(2);
const GROUP = uuid(3);
const OPTION = uuid(4);
// Distinctive numbers, so a leak cannot hide inside some other number.
const ITEM_COST = 1_234_567;
const OPTION_COST = 7_654_321;
const NEW_COST = 9_876_543;

const leaky = <T extends object>(row: T, key: string, value: number) => ({ ...row, [key]: value });

function server() {
  return mockFetch((call) => {
    const url = new URL(call.url);
    if (call.method === 'GET' && url.pathname === '/v1/menu/categories') {
      return { status: 200, json: { categories: [categoryDto(CATEGORY, 10)] } };
    }
    if (call.method === 'GET' && url.pathname === '/v1/menu/items') {
      return {
        status: 200,
        json: {
          items: [leaky(itemDto(ITEM, 11, { categoryId: CATEGORY }), 'estCostSatang', ITEM_COST)],
        },
      };
    }
    if (call.method === 'GET' && url.pathname === '/v1/menu/modifier-groups') {
      return {
        status: 200,
        json: {
          groups: [
            groupDto(GROUP, 12, {
              options: [{ id: OPTION, rev: 13 }],
            }),
          ].map((g) => ({
            ...g,
            options: g.options.map((o) => leaky(o, 'costDeltaSatang', OPTION_COST)),
          })),
        },
      };
    }
    if (call.method === 'GET' && url.pathname === '/v1/menu/costs') {
      return {
        status: 200,
        json: {
          items: [{ id: ITEM, estCostSatang: ITEM_COST }],
          options: [{ id: OPTION, costDeltaSatang: OPTION_COST }],
        },
      };
    }
    if (call.method === 'PATCH' && url.pathname === `/v1/menu/items/${ITEM}`) {
      return {
        status: 200,
        json: leaky(
          itemDto(ITEM, 20, { categoryId: CATEGORY, version: 2, nameTh: 'ชื่อใหม่' }),
          'estCostSatang',
          NEW_COST,
        ),
      };
    }
    return { status: 404, json: { code: 'NOT_FOUND' } };
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('costs never reach the saved copy of the menu', () => {
  test('after loading the editor with costs and saving a cost, the device holds no cost', async () => {
    const net = server();
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: net.fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    const entities = createEntityStore();
    const device: LocalStore = { ...createMemoryLocalStore(), persistent: true };
    const life = createFakeLifecycle();
    const cache = createCatalogueCache({
      entities,
      auth: createStore({
        phase: 'signedIn' as const,
        session: { staff: { id: uuid(9) } },
      }),
      connection: createStore({ synced: true }),
      localStore: async () => device,
      lifecycle: life.lifecycle,
      debounceMs: 1000,
    });
    cache.bind();
    const editor = createMenuEditorStore({
      api,
      entities,
      lifecycle: { isOnline: () => true },
      canSeeCosts: () => true,
      photoEngine: cleanEngine(),
    });
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);

    await editor.load();
    await editor.patchItem(ITEM, {
      expectedVersion: 1,
      nameTh: 'ชื่อใหม่',
      estCostSatang: satang(NEW_COST),
    });
    // The costs are really there in the editor...
    expect(editor.getState().costs?.items[ITEM]).toBe(NEW_COST);
    expect(editor.getState().costs?.options[OPTION]).toBe(OPTION_COST);
    // ...and the item was really saved, so the cache has something to write.
    expect(entities.getState().items.get(ITEM)?.nameTh).toBe('ชื่อใหม่');

    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);

    const blob = await device.kv.get(CATALOGUE_KEY);
    expect(blob).toBeDefined();
    const text = JSON.stringify(blob);
    expect(text).toContain('ชื่อใหม่');
    expect(text).not.toMatch(/est[_]?cost/i);
    expect(text).not.toMatch(/cost[_]?delta/i);
    for (const value of [ITEM_COST, OPTION_COST, NEW_COST]) {
      expect(text).not.toContain(String(value));
    }
    // Nor does the entity store the till reads from hold one.
    const live = JSON.stringify([
      ...entities.getState().items.values(),
      ...entities.getState().options.values(),
      ...entities.getState().groups.values(),
    ]);
    expect(live).not.toMatch(/cost/i);
  });

  test('a role without report.view never asks for costs and holds none', async () => {
    const net = server();
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: net.fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    const editor = createMenuEditorStore({
      api,
      entities: createEntityStore(),
      lifecycle: { isOnline: () => true },
      canSeeCosts: () => false,
      photoEngine: cleanEngine(),
    });
    await editor.load();
    expect(net.calls.some((c) => c.url.includes('/v1/menu/costs'))).toBe(false);
    expect(editor.getState().costs).toBeNull();
  });
});
