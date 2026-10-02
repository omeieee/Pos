import { describe, expect, test } from 'vitest';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createMockServer, MOCK_STAFF } from './mock-server.ts';

async function signedIn(role: 'cashier' | 'kitchen') {
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
  return services;
}

describe('the mock server serves the order screens', () => {
  test('the public menu needs no session', async () => {
    const server = createMockServer();
    const response = await server.fetch('https://api.example.test/v1/menu?channel=storefront');
    expect(response.status).toBe(200);
  });

  test('sync and orders need a session', async () => {
    const server = createMockServer();
    expect((await server.fetch('https://api.example.test/v1/sync?since=0')).status).toBe(401);
    expect(
      (await server.fetch('https://api.example.test/v1/orders', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(401);
  });

  test('a cashier syncs the menu and creates an order', async () => {
    const services = await signedIn('cashier');
    const page = await services.api.sync.changes({ since: 0, limit: 500 });
    expect(page.changes.length).toBeGreaterThan(10);
    const dish = page.changes.find((c) => c.type === 'menu.upserted' && c.kind === 'item');
    expect(dish).toBeTruthy();
  });

  test('a kitchen role may not create orders', async () => {
    const services = await signedIn('kitchen');
    await expect(
      services.api.orders.create({
        channel: 'storefront',
        fulfillment: 'dine_in',
        items: [{ menuItemId: '0192f3a0-0000-7000-8000-000000000208', qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
