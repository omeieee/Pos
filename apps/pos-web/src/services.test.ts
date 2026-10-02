// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockServer, MOCK_STAFF } from './dev/mock-server.ts';
import type { SoundPlayer } from './platform/sound.ts';
import { createMemoryTokenStore } from './platform/tokenStore.ts';
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

async function signedIn(role: 'cashier' | 'kitchen', sound = fakeSound()) {
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
  });
  const unbind = services.bindRealtime();
  await services.auth.boot();
  await services.auth.loadStaff();
  const person = MOCK_STAFF.find((s) => s.role === role);
  await services.auth.signInWithPin(person?.id ?? '', person?.pin ?? '');
  return { services, sound, unbind };
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
