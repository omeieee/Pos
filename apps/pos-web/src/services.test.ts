// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockServer, MOCK_STAFF } from './dev/mock-server.ts';
import { createMemoryLocalStore, type LocalStore } from './platform/localStore.ts';
import type { SoundPlayer } from './platform/sound.ts';
import {
  createMemoryTokenStore,
  createTokenStore,
  type KeyValue,
  memoryKeyValue,
} from './platform/tokenStore.ts';
import { createServices } from './services.ts';
import { createFakeLifecycle } from './test-support/fake-realtime.ts';
import { alertFrame, uuid } from './test-support/frames.ts';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const fakeSound = () => {
  const sound: SoundPlayer = {
    getState: () => ({ enabled: true, running: true, supported: true, loaded: true, state: 'on' }),
    subscribe: () => () => undefined,
    init: vi.fn(async () => undefined),
    turnOn: vi.fn(async () => undefined),
    turnOff: vi.fn(async () => undefined),
    play: vi.fn(() => true),
  };
  return sound;
};

async function signedIn(
  role: 'cashier' | 'kitchen',
  sound = fakeSound(),
  localStore?: () => Promise<LocalStore>,
) {
  const server = createMockServer();
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice(server.issueDeviceToken());
  const services = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: createFakeLifecycle().lifecycle,
    sound,
    ...(localStore ? { localStore } : {}),
  });
  const unbind = services.bindRealtime();
  await services.auth.boot();
  await services.auth.loadStaff();
  const person = MOCK_STAFF.find((s) => s.role === role);
  await services.auth.signInWithPin(person?.id ?? '', person?.pin ?? '');
  return { services, sound, unbind, server };
}

describe('signing out', () => {
  test('forgets the page, so the next person lands on their own first page', async () => {
    const { services } = await signedIn('kitchen');
    window.location.hash = '#/orders';
    await services.auth.signOut();
    expect(window.location.hash).toBe('');
  });
});

describe('the new-order sound', () => {
  test('starts with the realtime binding: the remembered choice is read and an alert chimes', async () => {
    const { services, sound, unbind } = await signedIn('kitchen');
    expect(sound.init).toHaveBeenCalledTimes(1);
    services.entities.apply(alertFrame(uuid(1)));
    expect(sound.play).toHaveBeenCalledWith('newOrder');
    unbind();
  });

  test('stops with the binding', async () => {
    const { services, sound, unbind } = await signedIn('kitchen');
    unbind();
    services.entities.apply(alertFrame(uuid(2)));
    expect(sound.play).not.toHaveBeenCalled();
  });

  test('an order that this very device rang up is silent here', async () => {
    const { services, sound } = await signedIn('cashier');
    const deviceId = services.auth.getState().device?.id;
    expect(deviceId).toBeTruthy();
    const frame = alertFrame(uuid(3));
    services.entities.apply({
      ...frame,
      data: { ...frame.data, createdOnDeviceId: deviceId ?? null },
    });
    expect(sound.play).not.toHaveBeenCalled();
  });
});

describe('the PromptPay ID saved for the offline QR', () => {
  const persistent = () => ({ ...createMemoryLocalStore(), persistent: true });

  test('a cashier gets it after sign-in, in its own record, and a kitchen device never does', async () => {
    const store = persistent();
    const { services } = await signedIn('cashier', fakeSound(), async () => store);
    await vi.waitFor(() => expect(services.promptpay.idStatus()).toBe('ok'));
    expect(await store.kv.get('promptpay.id')).toMatchObject({ target: { idValue: '0800001234' } });
    // Not in the saved menu, whatever else is there.
    expect(String(JSON.stringify(await store.kv.get('catalogue')))).not.toContain('0800001234');

    const kitchenStore = persistent();
    const { services: kitchen } = await signedIn('kitchen', fakeSound(), async () => kitchenStore);
    await vi.waitFor(() => expect(kitchen.auth.getState().phase).toBe('signedIn'));
    expect(kitchen.promptpay.idStatus()).toBe('forbidden');
    expect(await kitchenStore.kv.get('promptpay.id')).toBeUndefined();
  });

  test('when the owner changes the ID the saved one is replaced by the new one', async () => {
    const store = persistent();
    const { services, server } = await signedIn('cashier', fakeSound(), async () => store);
    await vi.waitFor(() => expect(services.promptpay.idStatus()).toBe('ok'));
    expect(services.promptpay.getState().last4).toBe('1234');
    server.setPromptpayId('0899990000');
    await vi.waitFor(() => expect(services.promptpay.getState().last4).toBe('0000'));
    expect(services.promptpay.idStatus()).toBe('ok');
    expect(services.promptpay.qr(7500)).toMatchObject({ ok: true, last4: '0000' });
  });

  test('scan: the clear ID is in ONE record only, never in the saved menu, the tokens, the outbox, the console or the page address', async () => {
    const ID = '0800001234';
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const base = persistent();
    const kvWrites: string[] = [];
    const outboxWrites: string[] = [];
    const store: LocalStore = {
      ...base,
      kv: {
        ...base.kv,
        set: async (key, value) => {
          kvWrites.push(`${key}=${JSON.stringify(value)}`);
          return base.kv.set(key, value);
        },
      },
      outbox: {
        ...base.outbox,
        put: async (entry) => {
          outboxWrites.push(JSON.stringify(entry));
          return base.outbox.put(entry);
        },
      },
    };
    const tokenWrites: string[] = [];
    const memory = memoryKeyValue();
    const spy: KeyValue = {
      ...memory,
      set: (key, value) => {
        tokenWrites.push(value);
        memory.set(key, value);
      },
    };
    const server = createMockServer();
    const tokens = createTokenStore({ durable: spy, tab: spy });
    await tokens.saveDevice(server.issueDeviceToken());
    const services = createServices({
      baseUrl: 'https://api.example.test',
      fetch: server.fetch,
      tokens,
      createSocket: server.createSocket,
      lifecycle: createFakeLifecycle().lifecycle,
      sound: fakeSound(),
      localStore: async () => store,
      catalogueDebounceMs: 5,
    });
    const unbind = services.bindRealtime();
    await services.auth.boot();
    await services.auth.loadStaff();
    const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
    await services.auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
    await vi.waitFor(() => expect(services.promptpay.idStatus()).toBe('ok'));
    await vi.waitFor(() => expect(kvWrites.some((w) => w.startsWith('catalogue='))).toBe(true));
    await services.outbox.enqueueOrder({
      clientRequestId: uuid(60),
      body: {
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah',
        items: [{ menuItemId: uuid(41), qty: 1, modifierOptionIds: [] }],
      },
      lines: [],
      estimateSatang: null,
    });
    // The ID IS saved, in its own record...
    const holders = kvWrites.filter((w) => w.includes(ID));
    expect(holders.length).toBeGreaterThan(0);
    for (const row of holders) expect(row.startsWith('promptpay.id=')).toBe(true);
    // ...and nowhere else.
    expect(kvWrites.filter((w) => w.startsWith('catalogue=')).join('')).not.toContain(ID);
    expect(outboxWrites.join('')).not.toContain(ID);
    expect(tokenWrites.join('')).not.toContain(ID);
    expect(window.location.href).not.toContain(ID);
    for (const spyOnConsole of logs) {
      for (const call of spyOnConsole.mock.calls) expect(JSON.stringify(call)).not.toContain(ID);
    }
    unbind();
  });

  test('another person signing in on the device removes the first person’s saved ID', async () => {
    const store = persistent();
    const { services } = await signedIn('cashier', fakeSound(), async () => store);
    await vi.waitFor(() => expect(services.promptpay.idStatus()).toBe('ok'));
    await services.auth.signOut();
    const manager = MOCK_STAFF.find((s) => s.role === 'manager');
    await services.auth.signInWithPin(manager?.id ?? '', manager?.pin ?? '');
    await vi.waitFor(async () =>
      expect(await store.kv.get<{ staffId: string }>('promptpay.id')).toMatchObject({
        staffId: manager?.id,
      }),
    );
  });
});

describe('the offline outbox', () => {
  const persistent = () => ({ ...createMemoryLocalStore(), persistent: true });

  test('the local store is opened once for the outbox and anything else that needs it', async () => {
    const store = persistent();
    let opened = 0;
    const { services } = await signedIn('cashier', fakeSound(), async () => {
      opened += 1;
      return store;
    });
    await vi.waitFor(() => expect(services.outbox.getState().ready).toBe(true));
    expect(opened).toBe(1);
  });

  test('sign-out keeps what is waiting on the device and forgets it on screen', async () => {
    const store = persistent();
    const { services } = await signedIn('cashier', fakeSound(), async () => store);
    await vi.waitFor(() => expect(services.outbox.getState().ready).toBe(true));
    const saved = await services.outbox.enqueueOrder({
      clientRequestId: uuid(40),
      body: {
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah',
        items: [{ menuItemId: uuid(41), qty: 1, modifierOptionIds: [] }],
      },
      lines: [],
      estimateSatang: null,
    });
    expect(saved.ok).toBe(true);
    await services.auth.signOut();
    expect(await store.outbox.count()).toBe(1);
    expect(services.outbox.getState().items).toHaveLength(0);
  });

  test('sign-out empties both carts', async () => {
    const { services } = await signedIn('cashier', fakeSound(), async () => persistent());
    services.cart.addItem({ itemId: uuid(41) });
    services.platformCart.setPlatformRef('GF-1');
    await services.auth.signOut();
    expect(services.cart.getState().lines).toHaveLength(0);
    expect(services.platformCart.getState().platformRef).toBe('');
  });
});
