// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { createMemoryLocalStore } from '../platform/localStore.ts';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createMockServer, MOCK_STAFF } from './mock-server.ts';

/** ชาเย็น ฿25 in the mock shop (no required choices). */
const TEA = '0192f3a0-0000-7000-8000-000000000208';
const wait = { timeout: 4000 };

/**
 * The whole path, with the real stores and the real client against the made-up server: the network
 * goes away, orders and cash are saved on the device, the network comes back, and everything is sent
 * once. The server's idempotency (by request id and body) is the mock's too, so this is the
 * "unplug the internet" exit criterion as far as software can show it.
 */
async function counter() {
  const server = createMockServer();
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice(server.issueDeviceToken());
  const life = createFakeLifecycle();
  const store = { ...createMemoryLocalStore(), persistent: true };
  const services = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: life.lifecycle,
    localStore: async () => store,
  });
  services.bindRealtime();
  await services.auth.boot();
  await services.auth.loadStaff();
  const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
  await services.auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
  await vi.waitFor(() => expect(services.entities.getState().items.size).toBeGreaterThan(5), wait);
  await vi.waitFor(() => expect(services.outbox.getState().ready).toBe(true), wait);

  const goOffline = async () => {
    server.setOffline(true);
    life.goOffline();
    await vi.waitFor(() => expect(services.outbox.isOffline()).toBe(true), wait);
  };
  const goOnline = () => {
    server.setOffline(false);
    life.goOnline();
  };
  const ringTea = async () => {
    services.cart.setBuilding('B1');
    services.cart.setRecipientName('Fah ตัวอย่าง');
    services.cart.addItem({ itemId: TEA });
    return services.cart.submit();
  };
  return { server, services, goOffline, goOnline, ringTea, store };
}

describe('the counter with the internet unplugged', () => {
  test('orders and cash are saved, then sent exactly once when it returns', async () => {
    const { services, goOffline, goOnline, ringTea, store } = await counter();
    await goOffline();

    const first = await ringTea();
    const second = await ringTea();
    expect(first).toMatchObject({ ok: true, queued: {} });
    expect(second).toMatchObject({ ok: true, queued: {} });
    const [a, b] = services.outbox.getState().items;
    expect(a?.id).toBeTruthy();
    expect(a?.kind === 'order' && a.label).not.toBe(b?.kind === 'order' && b.label);

    // Cash on the first, with the ฿25 estimate on screen.
    const cash = await services.outbox.enqueueCash({
      target: { entryId: a?.id ?? '' },
      tenderedSatang: 10000,
      totalSatang: 2500,
      label: a?.label ?? '',
    });
    expect(cash.ok).toBe(true);
    expect(services.entities.getState().orders.size).toBe(0);
    expect(await store.outbox.count()).toBe(3);

    goOnline();
    await vi.waitFor(() => expect(services.outbox.getState().items).toHaveLength(0), wait);
    const orders = [...services.entities.getState().orders.values()];
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((o) => o.orderNo)).size).toBe(2);
    expect(orders.filter((o) => o.paymentStatus === 'paid')).toHaveLength(1);
    expect(await store.outbox.count()).toBe(0);
  });

  test('a replay of an order the server already has returns that order, never a second one', async () => {
    const { services, goOffline, goOnline, ringTea } = await counter();
    await goOffline();
    await ringTea();
    const entry = services.outbox.getState().items[0];
    goOnline();
    await vi.waitFor(() => expect(services.outbox.getState().items).toHaveLength(0), wait);
    const [order] = [...services.entities.getState().orders.values()];

    // The same request id and body, as a lost answer would make the app send it again.
    const again = await services.api.orders.create(
      {
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah ตัวอย่าง',
        items: [{ menuItemId: TEA, qty: 1, modifierOptionIds: [] }],
      },
      { clientRequestId: entry?.id ?? '' },
    );
    expect(again.replay).toBe(true);
    expect(again.order.id).toBe(order?.id);
  });

  test('an order the server now refuses stays visible as needing attention, and the next one still goes', async () => {
    const { server, services, goOffline, goOnline, ringTea } = await counter();
    await goOffline();
    await ringTea();
    // The owner sells the dish out on the server while this counter is offline.
    server.soldOut(8);
    goOnline();
    await vi.waitFor(
      () => expect(services.outbox.getState().items[0]?.state).toBe('attention'),
      wait,
    );
    expect(services.outbox.getState().items[0]).toMatchObject({
      error: 'ORDER_INVALID',
      canRetry: true,
    });
    expect(services.entities.getState().orders.size).toBe(0);
  });

  test('cash that comes up short against the real total is refused and kept for a person', async () => {
    const { server, services, goOffline, goOnline, ringTea } = await counter();
    await goOffline();
    await ringTea();
    const order = services.outbox.getState().items[0];
    await services.outbox.enqueueCash({
      target: { entryId: order?.id ?? '' },
      tenderedSatang: 2500,
      totalSatang: 2500,
      label: order?.label ?? '',
    });
    // Prices went up by ฿5 on the server while offline: ฿25 exact is no longer enough.
    server.bumpPrices(500);
    goOnline();
    await vi.waitFor(
      () =>
        expect(services.outbox.getState().items.map((i) => [i.kind, i.state])).toEqual([
          ['payment', 'attention'],
        ]),
      wait,
    );
    expect(services.outbox.getState().items[0]).toMatchObject({
      error: 'TENDERED_BELOW_TOTAL',
    });
    // The order itself did sync, at the new price, and is unpaid: cash is redone on its page.
    const [synced] = [...services.entities.getState().orders.values()];
    expect(synced).toMatchObject({ totalSatang: 3000, paymentStatus: 'unpaid' });
  });

  test('a platform order keyed in offline is queued with the platform channel and syncs at the platform price', async () => {
    const { services, goOffline, goOnline } = await counter();
    await goOffline();
    services.platformCart.setChannel('lineman');
    services.platformCart.setPlatformRef('LM-77');
    services.platformCart.addItem({ itemId: TEA });
    expect(await services.platformCart.submit()).toMatchObject({ ok: true, queued: {} });
    goOnline();
    await vi.waitFor(() => expect(services.outbox.getState().items).toHaveLength(0), wait);
    const [order] = [...services.entities.getState().orders.values()];
    expect(order).toMatchObject({
      channel: 'lineman',
      fulfillment: 'platform_delivery',
      note: 'LINE MAN LM-77',
      totalSatang: 3200,
    });
  });
});
