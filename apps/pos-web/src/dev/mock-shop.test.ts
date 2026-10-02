import {
  orderDtoSchema,
  publicMenuResponseSchema,
  syncResponseSchema,
  wsServerMessageSchema,
} from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiClient } from '../api/client.ts';
import { buildMenu } from '../pos/menu-model.ts';
import { createConnection } from '../realtime/connection.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { FAKE_DEVICE_TOKEN, FAKE_SESSION_TOKEN } from '../test-support/fixtures.ts';
import { createMockShop } from './mock-shop.ts';

const BASE = 'https://api.example.test';

function setup() {
  const shop = createMockShop({ now: () => Date.UTC(2030, 0, 1, 5, 0, 0) });
  const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const handled = shop.handle(
      (init?.method ?? 'GET').toUpperCase(),
      url.pathname,
      url.searchParams,
      body,
    );
    if (!handled) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(handled.body), { status: handled.status });
  }) as typeof fetch;
  const api = createApiClient({
    baseUrl: BASE,
    fetch: fetchLike,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
  });
  return { shop, api };
}

describe('the dev shop (a made-up menu, orders and sync, in the shapes the API sends)', () => {
  test('sync from 0 carries the whole menu, and every frame matches the shared schema', async () => {
    const { api } = setup();
    const page = await api.sync.changes({ since: 0, limit: 500 });
    expect(syncResponseSchema.safeParse(page).success).toBe(true);
    expect(page.hasMore).toBe(false);
    expect(page.serverRev).toBeGreaterThan(0);
    const store = createEntityStore();
    store.applyMany(page.changes);
    const menu = buildMenu(store.getState());
    const dishes = menu.flatMap((c) => c.items);
    expect(dishes.length).toBeGreaterThan(5);
    expect(dishes.some((d) => d.soldOut)).toBe(true);
    expect(dishes.some((d) => d.groups.some((g) => g.required))).toBe(true);
  });

  test('sync pages follow nextSince', async () => {
    const { api } = setup();
    const first = await api.sync.changes({ since: 0, limit: 3 });
    expect(first.hasMore).toBe(true);
    const second = await api.sync.changes({ since: first.nextSince, limit: 500 });
    expect(second.changes[0]?.rev).toBeGreaterThan(first.nextSince);
  });

  test('the public menu answers too', async () => {
    const { api } = setup();
    const menu = await api.menu.publicMenu('storefront');
    expect(publicMenuResponseSchema.safeParse(menu).success).toBe(true);
    expect(menu.categories.length).toBeGreaterThan(0);
  });

  test('creates an order priced by the shared rules, and numbers it', async () => {
    const { api } = setup();
    const store = createEntityStore();
    store.applyMany((await api.sync.changes({ since: 0, limit: 500 })).changes);
    const tea = buildMenu(store.getState())
      .flatMap((c) => c.items)
      .find((i) => i.nameEn === 'Thai iced tea');
    expect(tea).toBeTruthy();
    const { order, replay } = await api.orders.create({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Tester',
      items: [{ menuItemId: tea?.id ?? '', qty: 2, modifierOptionIds: [] }],
    });
    expect(replay).toBe(false);
    expect(orderDtoSchema.safeParse(order).success).toBe(true);
    expect(order.orderNo).toBe('S-001');
    expect(order.totalSatang).toBe(2 * (tea?.priceSatang ?? 0));
  });

  test('the same request id returns the same order (idempotent)', async () => {
    const { api } = setup();
    const store = createEntityStore();
    store.applyMany((await api.sync.changes({ since: 0, limit: 500 })).changes);
    const item = buildMenu(store.getState())
      .flatMap((c) => c.items)
      .find((i) => i.orderable && i.groups.length === 0);
    const input = {
      channel: 'storefront' as const,
      fulfillment: 'entrance_delivery' as const,
      deliveryBuilding: 'B1',
      recipientName: 'Tester',
      items: [{ menuItemId: item?.id ?? '', qty: 1, modifierOptionIds: [] }],
    };
    const first = await api.orders.create(input, {
      clientRequestId: '0192f3a0-0000-7000-8000-00000000aaaa',
    });
    const second = await api.orders.create(input, {
      clientRequestId: '0192f3a0-0000-7000-8000-00000000aaaa',
    });
    expect(second.replay).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    const next = await api.orders.create(input);
    expect(next.order.orderNo).toBe('S-002');
  });

  test('a sold-out dish is refused like the server does: ORDER_INVALID with the line error', async () => {
    const { api } = setup();
    const store = createEntityStore();
    store.applyMany((await api.sync.changes({ since: 0, limit: 500 })).changes);
    const soldOut = buildMenu(store.getState())
      .flatMap((c) => c.items)
      .find((i) => i.soldOut);
    const error = await api.orders
      .create({
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Tester',
        items: [{ menuItemId: soldOut?.id ?? '', qty: 1, modifierOptionIds: [] }],
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'ORDER_INVALID',
      status: 422,
      lineErrors: [{ lineIndex: 0 }],
    });
  });

  test('an order can be read back, and a stranger id is NOT_FOUND', async () => {
    const { api } = setup();
    const store = createEntityStore();
    store.applyMany((await api.sync.changes({ since: 0, limit: 500 })).changes);
    const item = buildMenu(store.getState())
      .flatMap((c) => c.items)
      .find((i) => i.orderable && i.groups.length === 0);
    const { order } = await api.orders.create({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'A1',
      recipientName: 'Tester',
      items: [{ menuItemId: item?.id ?? '', qty: 1, modifierOptionIds: [] }],
    });
    expect((await api.orders.get(order.id)).orderNo).toBe(order.orderNo);
    await expect(api.orders.get('0192f3a0-0000-7000-8000-00000000bbbb')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the dev shop: entrance deliveries and remembered recipients', () => {
  async function tea(api: ReturnType<typeof setup>['api']) {
    const store = createEntityStore();
    store.applyMany((await api.sync.changes({ since: 0, limit: 500 })).changes);
    const found = buildMenu(store.getState())
      .flatMap((c) => c.items)
      .find((i) => i.nameEn === 'Thai iced tea');
    return { menuItemId: found?.id ?? '', qty: 1, modifierOptionIds: [] as string[] };
  }
  const base = { channel: 'storefront' as const, fulfillment: 'entrance_delivery' as const };

  test('the delivery setting is the default building list, never saved (version 0)', async () => {
    const { api } = setup();
    const setting = await api.settings.delivery();
    expect(setting.value.buildings).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2']);
    expect(setting.version).toBe(0);
  });

  test('a few made-up recipients are remembered, the most recent first, at most the limit', async () => {
    const { api } = setup();
    const all = (await api.recipients.list({})).recipients;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const times = all.map((r) => Date.parse(r.lastOrderAt ?? ''));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await api.recipients.list({ limit: 2 })).recipients).toHaveLength(2);
  });

  test('a search matches the name as "contains", ignoring case and spacing; a building narrows', async () => {
    const { api } = setup();
    const first = (await api.recipients.list({})).recipients[0];
    const fragment = (first?.recipientName ?? '').slice(0, 2).toUpperCase();
    const found = (await api.recipients.list({ q: fragment })).recipients;
    expect(found.map((r) => r.id)).toContain(first?.id);
    const inBuilding = (await api.recipients.list({ building: first?.building ?? '' })).recipients;
    expect(inBuilding.every((r) => r.building === first?.building)).toBe(true);
    expect((await api.recipients.list({ q: 'zzzz-nobody' })).recipients).toEqual([]);
  });

  test('an entrance order carries building, name and details, and remembers the recipient', async () => {
    const { api } = setup();
    const item = await tea(api);
    const { order } = await api.orders.create({
      ...base,
      deliveryBuilding: 'D2',
      recipientName: 'Newcomer ตัวอย่าง',
      deliveryNote: 'ชั้น 9',
      items: [item],
    });
    expect(order).toMatchObject({
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'D2',
      recipientName: 'Newcomer ตัวอย่าง',
      deliveryNote: 'ชั้น 9',
    });
    expect(order.customerId).toBeTruthy();
    const latest = (await api.recipients.list({ limit: 1 })).recipients[0];
    expect(latest).toMatchObject({
      id: order.customerId,
      building: 'D2',
      recipientName: 'Newcomer ตัวอย่าง',
      deliveryNote: 'ชั้น 9',
    });
  });

  test('the same building and name, typed another way, is the same recipient and the details follow', async () => {
    const { api } = setup();
    const item = await tea(api);
    const first = await api.orders.create({
      ...base,
      deliveryBuilding: 'C2',
      recipientName: 'Tala Example',
      items: [item],
    });
    const second = await api.orders.create({
      ...base,
      deliveryBuilding: 'C2',
      recipientName: '  tala   example ',
      deliveryNote: 'ใหม่',
      items: [item],
    });
    expect(second.order.customerId).toBe(first.order.customerId);
    const mine = (await api.recipients.list({ q: 'tala example' })).recipients;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.deliveryNote).toBe('ใหม่');
  });

  test('refuses a building the shop does not deliver to, and way of serving it does not offer', async () => {
    const { api } = setup();
    const item = await tea(api);
    await expect(
      api.orders.create({ ...base, deliveryBuilding: 'Z9', recipientName: 'X', items: [item] }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_BUILDING', status: 422 });
    await expect(
      api.orders.create({
        channel: 'storefront',
        fulfillment: 'dine_in',
        items: [item],
      }),
    ).rejects.toMatchObject({ code: 'FULFILLMENT_NOT_OFFERED', status: 422 });
  });

  test('a LINE order that arrives by itself is an entrance delivery to a made-up recipient', async () => {
    const { shop } = setup();
    const a = shop.simulateIncomingOrder();
    const b = shop.simulateIncomingOrder();
    for (const order of [a, b]) {
      expect(orderDtoSchema.safeParse(order).success).toBe(true);
      expect(order.fulfillment).toBe('entrance_delivery');
      expect(order.deliveryBuilding).toBeTruthy();
      expect(order.recipientName).toBeTruthy();
    }
  });
});

describe('the dev shop socket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('the realtime client connects to it, catches up and then receives pushed orders', async () => {
    const { shop, api } = setup();
    const entities = createEntityStore();
    const connection = createConnection({
      entities,
      fetchSync: (q) => api.sync.changes(q),
      credentials: () => ({ sessionToken: FAKE_SESSION_TOKEN, deviceToken: FAKE_DEVICE_TOKEN }),
      createSocket: shop.createSocket,
      lifecycle: createFakeLifecycle().lifecycle,
      url: 'wss://api.example.test/v1/ws',
      onAuthLost: () => undefined,
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(connection.getState()).toMatchObject({ status: 'online', synced: true });
    expect(entities.getState().items.size).toBeGreaterThan(5);

    const item = buildMenu(entities.getState())
      .flatMap((c) => c.items)
      .find((i) => i.orderable && i.groups.length === 0);
    const { order } = await api.orders.create({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Tester',
      items: [{ menuItemId: item?.id ?? '', qty: 1, modifierOptionIds: [] }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(entities.getState().orders.get(order.id)?.orderNo).toBe('S-001');
    connection.stop();
  });

  test('a LINE order can arrive by itself: a new order frame and an alert, as the API sends them', async () => {
    const { shop } = setup();
    const seen: unknown[] = [];
    const handle = shop.createSocket('wss://x/v1/ws', {
      open: () => undefined,
      message: (text) => seen.push(JSON.parse(text)),
      close: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.send(JSON.stringify({ type: 'auth', sessionToken: FAKE_SESSION_TOKEN }));
    const order = shop.simulateIncomingOrder();
    expect(orderDtoSchema.safeParse(order).success).toBe(true);
    expect(order).toMatchObject({ channel: 'line', status: 'new', orderNo: 'S-001' });
    expect(order.items.length).toBeGreaterThan(0);
    const types = seen.slice(1).map((m) => (m as { type: string }).type);
    expect(types).toEqual(['order.upserted', 'alert.new_order']);
    // The next one is a different order.
    expect(shop.simulateIncomingOrder().id).not.toBe(order.id);
  });

  test('it pings, so a quiet dev session is not dropped as dead', async () => {
    const { shop } = setup();
    const seen: unknown[] = [];
    const handle = shop.createSocket('wss://x/v1/ws', {
      open: () => undefined,
      message: (text) => seen.push(JSON.parse(text)),
      close: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.send(JSON.stringify({ type: 'auth', sessionToken: FAKE_SESSION_TOKEN }));
    await vi.advanceTimersByTimeAsync(26_000);
    const messages = seen.map((m) => wsServerMessageSchema.parse(m));
    expect(messages.map((m) => m.type)).toEqual(['ready', 'ping']);
  });

  test('it closes a socket whose first message is not an auth message', async () => {
    const { shop } = setup();
    const closes: number[] = [];
    const handle = shop.createSocket('wss://x/v1/ws', {
      open: () => undefined,
      message: () => undefined,
      close: (code) => closes.push(code),
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.send(JSON.stringify({ type: 'pong' }));
    expect(closes).toEqual([4400]);
  });
});
