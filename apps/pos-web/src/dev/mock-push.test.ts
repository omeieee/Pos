import { describe, expect, test } from 'vitest';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createFakePush } from './fake-push.ts';
import { MOCK_VAPID_PUBLIC_KEY } from './mock-push.ts';
import { createMockServer, MOCK_OWNER, MOCK_STAFF } from './mock-server.ts';

const BASE = 'https://api.example.test';

/** The real app wiring (client, auth, store) over the made-up server and a fake browser push. */
async function app(options: { pushConfigured?: boolean; registered?: boolean } = {}) {
  const server = createMockServer(
    options.pushConfigured === undefined ? {} : { pushConfigured: options.pushConfigured },
  );
  const tokens = createMemoryTokenStore();
  const issued = server.issueDeviceToken();
  if (options.registered !== false) await tokens.saveDevice(issued);
  const browser = createFakePush();
  const services = createServices({
    baseUrl: BASE,
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: createFakeLifecycle().lifecycle,
    push: browser.platform,
  });
  await services.auth.boot();
  await services.auth.loadStaff();
  if (options.registered !== false) {
    const person = MOCK_STAFF.find((s) => s.role === 'kitchen');
    await services.auth.signInWithPin(person?.id ?? '', person?.pin ?? '');
  }
  return { server, services, browser, deviceId: issued.device.id };
}

describe('the mock phone-alert routes behind the real store', () => {
  test('any role on a registered device turns alerts on and off, and the server remembers it per device', async () => {
    const { server, services, deviceId } = await app();
    await services.pushAlerts.load();
    expect(services.pushAlerts.getState().status).toBe('off');
    await services.pushAlerts.enable();
    expect(services.pushAlerts.getState().status).toBe('on');
    expect(server.pushSubscribed(deviceId)).toBe(true);
    await services.pushAlerts.disable();
    expect(services.pushAlerts.getState().status).toBe('off');
    expect(server.pushSubscribed(deviceId)).toBe(false);
  });

  test('the config hands out the key; not set up answers enabled:false and 503 on the subscription', async () => {
    const { server } = await app({ pushConfigured: false });
    const headers = (await signInHeaders(server)) as Record<string, string>;
    const config = await server.fetch(`${BASE}/v1/push/config`, { headers });
    expect(await config.json()).toEqual({ enabled: false, publicKey: null });
    const sub = await server.fetch(`${BASE}/v1/push/subscription`, { headers });
    expect(sub.status).toBe(503);
    expect((await sub.json()).code).toBe('PUSH_NOT_CONFIGURED');
    server.setPushConfigured(true);
    const again = await server.fetch(`${BASE}/v1/push/config`, { headers });
    expect(await again.json()).toEqual({ enabled: true, publicKey: MOCK_VAPID_PUBLIC_KEY });
  });

  test('an owner session on a browser that was never registered gets DEVICE_REQUIRED, and the store says so', async () => {
    const { server, services } = await app({ registered: false });
    const owner = await services.auth.signInOwner({
      email: MOCK_OWNER.email,
      password: MOCK_OWNER.password,
      totp: '111111',
    });
    expect(owner.ok).toBe(true);
    await services.pushAlerts.load();
    expect(services.pushAlerts.getState().status).toBe('no-device');
    expect(server.pushSubscribed('anything')).toBe(false);
  });

  test('a subscription the shared schema refuses is a 400', async () => {
    const { server } = await app();
    const headers = (await signInHeaders(server)) as Record<string, string>;
    const answer = await server.fetch(`${BASE}/v1/push/subscription`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://evil.example/x',
        keys: { p256dh: 'x', auth: 'y' },
      }),
    });
    expect(answer.status).toBe(400);
  });
});

async function signInHeaders(server: ReturnType<typeof createMockServer>) {
  const device = server.issueDeviceToken();
  const person = MOCK_STAFF.find((s) => s.role === 'kitchen');
  const login = await server.fetch(`${BASE}/v1/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': device.deviceToken },
    body: JSON.stringify({ staffId: person?.id, pin: person?.pin }),
  });
  const { sessionToken } = await login.json();
  return { authorization: `Bearer ${sessionToken}`, 'x-device-token': device.deviceToken };
}
