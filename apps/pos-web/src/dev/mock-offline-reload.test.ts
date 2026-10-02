// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { createMemoryLocalStore } from '../platform/localStore.ts';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { CATALOGUE_KEY } from '../pos/catalogue-cache.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createMockServer, MOCK_STAFF } from './mock-server.ts';

/** ชาเย็น ฿25 in the mock shop (no required choices). */
const TEA = '0192f3a0-0000-7000-8000-000000000208';
const wait = { timeout: 4000 };

/**
 * The page is reloaded while the network is down: the new run has the saved PIN session, the same
 * device storage and no connection. It must still have a menu (from the saved copy), take an order,
 * keep it, and send it once when the network returns.
 */
async function reloadedWhileOffline() {
  const server = createMockServer();
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice(server.issueDeviceToken());
  const store = { ...createMemoryLocalStore(), persistent: true };

  // First run: online, signs in, the menu arrives and is saved.
  const firstLife = createFakeLifecycle();
  const first = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: firstLife.lifecycle,
    localStore: async () => store,
    catalogueDebounceMs: 10,
  });
  const stopFirst = first.bindRealtime();
  await first.auth.boot();
  await first.auth.loadStaff();
  const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
  await first.auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
  await vi.waitFor(() => expect(first.entities.getState().items.size).toBeGreaterThan(5), wait);
  await vi.waitFor(async () => expect(await store.kv.get(CATALOGUE_KEY)).toBeDefined(), wait);
  stopFirst();

  // The network goes away and the page is reloaded.
  server.setOffline(true);
  const life = createFakeLifecycle({ online: false });
  const services = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: life.lifecycle,
    localStore: async () => store,
    catalogueDebounceMs: 10,
  });
  services.bindRealtime();
  await services.auth.boot();
  return { server, services, life, store };
}

describe('a reload while the network is down', () => {
  test('the menu comes from the saved copy, an order is taken and queued, and it syncs once when the network returns', async () => {
    const { server, services, life, store } = await reloadedWhileOffline();
    expect(services.auth.getState().phase).toBe('signedIn');

    // The menu is there with no network, and the app says it is the saved one.
    await vi.waitFor(
      () => expect(services.entities.getState().items.size).toBeGreaterThan(5),
      wait,
    );
    expect(services.connection.getState().synced).toBe(false);
    expect(services.catalogue.getState().fromCache).toBe(true);
    expect(services.entities.getState().lastRev).toBe(0);
    await vi.waitFor(() => expect(services.outbox.getState().ready).toBe(true), wait);
    expect(services.outbox.isOffline()).toBe(true);

    // An order on the saved menu is queued on the device.
    services.cart.setBuilding('B1');
    services.cart.setRecipientName('Fah ตัวอย่าง');
    services.cart.addItem({ itemId: TEA });
    expect(await services.cart.submit()).toMatchObject({ ok: true, queued: {} });
    expect(services.outbox.getState().items).toHaveLength(1);
    expect(await store.outbox.count()).toBe(1);
    expect(services.entities.getState().orders.size).toBe(0);

    // The network returns: the order is sent once, the saved notice goes.
    server.setOffline(false);
    life.goOnline();
    await vi.waitFor(() => expect(services.outbox.getState().items).toHaveLength(0), wait);
    await vi.waitFor(() => expect(services.catalogue.getState().fromCache).toBe(false), wait);
    expect(services.entities.getState().orders.size).toBe(1);
    expect(await store.outbox.count()).toBe(0);
  });
});
