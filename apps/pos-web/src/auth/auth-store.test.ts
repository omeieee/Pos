import { describe, expect, test } from 'vitest';
import { createApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import {
  createMockServer,
  MOCK_OWNER,
  MOCK_STAFF,
  type MockServer,
  type MockServerOptions,
  type MockStaff,
} from '../dev/mock-server.ts';
import { createMemoryTokenStore, type TokenStore } from '../platform/tokenStore.ts';
import { type AuthStore, can, createAuthStore } from './auth-store.ts';

const BASE = 'https://api.example.test';

function staffWithRole(role: MockStaff['role']): MockStaff {
  const found = MOCK_STAFF.find((s) => s.role === role);
  if (!found) throw new Error(`no mock ${role}`);
  return found;
}
const cashier = staffWithRole('cashier');

const ownerCredentials = (totp: string) => ({
  email: MOCK_OWNER.email,
  password: MOCK_OWNER.password,
  totp,
});
const ownerStepUp = (totp: string) =>
  ({ method: 'owner', factors: { password: MOCK_OWNER.password, totp } }) as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Env {
  store: AuthStore;
  api: ReturnType<typeof createApiClient>;
  server: MockServer;
  tokens: TokenStore;
  clock: { now: () => number; advance: (ms: number) => void };
  registration: ReturnType<MockServer['issueDeviceToken']>;
}

/** A store wired to a server and storage exactly like the app wires it. */
function wire(
  server: MockServer,
  tokens: TokenStore,
  clock: Env['clock'],
  fetchImpl: typeof fetch = server.fetch,
) {
  let store!: AuthStore;
  const api = createApiClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getSessionToken: () => store.sessionToken(),
    getDeviceToken: () => store.deviceToken(),
    onAuthFailure: (error) => store.handleAuthFailure(error),
  });
  store = createAuthStore({ api, tokens, now: clock.now });
  return { store, api };
}

function setup(serverOptions: Omit<MockServerOptions, 'now'> = {}): Env {
  let time = Date.parse('2030-01-01T05:00:00.000Z');
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const server = createMockServer({ ...serverOptions, now: clock.now });
  const tokens = createMemoryTokenStore();
  const { store, api } = wire(server, tokens, clock);
  return {
    store,
    api,
    server,
    tokens,
    clock,
    registration: server.issueDeviceToken('iPad ตัวอย่าง', 'ipad'),
  };
}

/** The page is reloaded: a new store over the same storage and server. */
const restart = (env: Env, fetchImpl?: typeof fetch) =>
  wire(env.server, env.tokens, env.clock, fetchImpl);

async function registeredAndLocked(serverOptions: Omit<MockServerOptions, 'now'> = {}) {
  const env = setup(serverOptions);
  await env.tokens.saveDevice(env.registration);
  await env.store.boot();
  await env.store.loadStaff(); // joins the request boot started
  return env;
}

async function signedInAsCashier() {
  const env = await registeredAndLocked();
  expect((await env.store.signInWithPin(cashier.id, cashier.pin)).ok).toBe(true);
  return env;
}

/** Opens the step-up dialog through registerDevice and answers it. Returns the register result. */
async function registerWithStepUp(store: AuthStore, secondCode: string) {
  const pending = store.registerDevice({ name: 'iPad เคาน์เตอร์', kind: 'ipad' });
  await tick();
  expect(store.getState().stepUpOpen).toBe(true);
  expect((await store.submitStepUp(ownerStepUp(secondCode))).ok).toBe(true);
  return pending;
}

describe('start-up', () => {
  test('an unregistered device asks to be registered and makes no call', async () => {
    const { store, server } = setup();
    expect(store.getState().phase).toBe('booting');
    await store.boot();
    expect(store.getState().phase).toBe('unregistered');
    expect(server.calls).toHaveLength(0);
  });

  test('a registered device shows the PIN screen with the staff tiles', async () => {
    const { store, registration } = await registeredAndLocked();
    const state = store.getState();
    expect(state.phase).toBe('locked');
    expect(state.device).toEqual(registration.device);
    expect(state.staffTiles.status).toBe('ready');
    expect(state.staffTiles.staff.map((s) => s.role).sort()).toEqual([
      'cashier',
      'kitchen',
      'manager',
      'owner',
    ]);
    // The tiles carry names and roles only.
    expect(Object.keys(state.staffTiles.staff[0] ?? {}).sort()).toEqual([
      'displayName',
      'id',
      'role',
    ]);
  });

  test('a saved PIN session is checked with the server and restored', async () => {
    const env = await signedInAsCashier();
    const { store } = restart(env);
    expect(store.getState().phase).toBe('booting');
    await store.boot();
    expect(store.getState().phase).toBe('signedIn');
    expect(store.getState().session?.staff.role).toBe('cashier');
    expect(store.getState().session?.method).toBe('pin');
  });

  test('a saved session the server no longer knows sends the person to the PIN screen', async () => {
    const env = await signedInAsCashier();
    env.server.revokeAllSessions();
    const { store } = restart(env);
    await store.boot();
    expect(store.getState().phase).toBe('locked');
    expect(store.getState().notice).toBeNull();
    expect(await env.tokens.loadSession()).toBeNull();
    expect(await env.tokens.loadDevice()).not.toBeNull();
  });

  test('an expired saved session is dropped without asking the server about it', async () => {
    const env = await signedInAsCashier();
    env.clock.advance(13 * 3600_000);
    const before = env.server.calls.length;
    const { store } = restart(env);
    await store.boot();
    expect(store.getState().phase).toBe('locked');
    expect(await env.tokens.loadSession()).toBeNull();
    // Only the staff list was fetched; there was no /me call.
    expect(env.server.calls.slice(before).map((c) => c.path)).toEqual(['/v1/auth/staff']);
  });

  test('offline at start-up keeps a saved session instead of locking the counter', async () => {
    const env = await signedInAsCashier();
    const { store } = restart(env, (() =>
      Promise.reject(new TypeError('offline'))) as typeof fetch);
    await store.boot();
    expect(store.getState().phase).toBe('signedIn');
  });

  test('a device the owner removed is forgotten, with an explanation', async () => {
    const env = await signedInAsCashier();
    env.server.revoke(env.registration.deviceToken);
    const { store } = restart(env);
    await store.boot();
    // /me says the session is gone, then the staff list says the device is gone.
    await tick();
    expect(store.getState().phase).toBe('unregistered');
    expect(store.getState().notice).toBe('deviceRemoved');
    expect(await env.tokens.loadDevice()).toBeNull();
    expect(await env.tokens.loadSession()).toBeNull();
  });

  test('a stored session without a stored device is discarded', async () => {
    const env = setup();
    await env.tokens.saveSession({
      sessionToken: 'sds_ses_ORPHANORPHANORPHAN0001',
      expiresAt: '2031-01-01T00:00:00.000Z',
      idleTimeoutSeconds: 60,
      staff: { id: cashier.id, displayName: cashier.displayName, role: 'cashier' },
      permissions: [],
    });
    await env.store.boot();
    expect(env.store.getState().phase).toBe('unregistered');
    expect(await env.tokens.loadSession()).toBeNull();
  });
});

describe('PIN sign-in', () => {
  test('signs in, keeps the PIN session for the tab, and holds no token in state', async () => {
    const { store, tokens, registration } = await registeredAndLocked();
    const result = await store.signInWithPin(cashier.id, cashier.pin);
    expect(result.ok).toBe(true);
    const state = store.getState();
    expect(state.phase).toBe('signedIn');
    expect(state.session?.staff).toMatchObject({ id: cashier.id, role: 'cashier' });
    expect(state.session?.method).toBe('pin');
    expect((await tokens.loadSession())?.staff.id).toBe(cashier.id);

    const printed = JSON.stringify(state);
    expect(printed).not.toContain(store.sessionToken() ?? 'missing');
    expect(printed).not.toContain(registration.deviceToken);
  });

  test('a wrong PIN stays on the PIN screen and stores nothing', async () => {
    const { store, tokens } = await registeredAndLocked();
    const result = await store.signInWithPin(cashier.id, '0000');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(store.getState().phase).toBe('locked');
    expect(await tokens.loadSession()).toBeNull();
  });

  test('five wrong PINs lock the tile for the time the server says', async () => {
    const { store, clock } = await registeredAndLocked();
    let last: Awaited<ReturnType<AuthStore['signInWithPin']>> | undefined;
    for (let i = 0; i < 5; i += 1) last = await store.signInWithPin(cashier.id, '0000');
    expect(last).toMatchObject({
      ok: false,
      error: { code: 'ACCOUNT_LOCKED', retryAfterSeconds: 300 },
    });
    expect(store.getState().pinLockedUntil[cashier.id]).toBe(clock.now() + 300_000);
    // Even the right PIN is refused while locked.
    expect(await store.signInWithPin(cashier.id, cashier.pin)).toMatchObject({
      ok: false,
      error: { code: 'ACCOUNT_LOCKED' },
    });
    expect(store.getState().phase).toBe('locked');
  });

  test('a double tap sends one attempt, so it cannot burn two tries toward a lock', async () => {
    const { store, server } = await registeredAndLocked();
    const pinCalls = () => server.calls.filter((c) => c.path === '/v1/auth/pin').length;
    const before = pinCalls();
    const [first, second] = await Promise.all([
      store.signInWithPin(cashier.id, '0000'),
      store.signInWithPin(cashier.id, '0000'),
    ]);
    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: false, error: null, duplicate: true });
    expect(pinCalls() - before).toBe(1);
  });
});

describe('owner sign-in and device registration', () => {
  test('owner password sign-in works on a registered device and is not stored', async () => {
    const { store, tokens } = await registeredAndLocked();
    expect((await store.signInOwner(ownerCredentials('111111'))).ok).toBe(true);
    expect(store.getState().session?.method).toBe('owner');
    expect(can(store.getState(), 'device.manage')).toBe(true);
    expect(await tokens.loadSession()).toBeNull();
  });

  test('a wrong code and a wrong password are refused with the same error', async () => {
    const { store } = setup();
    await store.boot();
    const wrongCode = await store.signInOwner(ownerCredentials('999999'));
    const wrongPassword = await store.signInOwner({ ...ownerCredentials('111111'), password: 'x' });
    expect(wrongCode).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(wrongPassword).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(store.getState().session).toBeNull();
  });

  test('a first-run device registers after owner sign-in and a second code', async () => {
    const { store, tokens, server } = setup();
    await store.boot();
    expect((await store.signInOwner(ownerCredentials('111111'))).ok).toBe(true);
    // Signed in as owner, but there is no device yet: still the registration screen.
    expect(store.getState().phase).toBe('unregistered');
    expect(store.getState().session).not.toBeNull();

    const pending = store.registerDevice({ name: 'iPad เคาน์เตอร์', kind: 'ipad' });
    await tick();
    // Signing in does not count as step-up, so the dialog opens before the call.
    expect(store.getState().stepUpOpen).toBe(true);
    expect(server.calls.some((c) => c.path === '/v1/auth/device')).toBe(false);

    // The code that signed in is already used: the server refuses it, the dialog stays open.
    const reused = await store.submitStepUp(ownerStepUp('111111'));
    expect(reused).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(store.getState().stepUpOpen).toBe(true);

    expect((await store.submitStepUp(ownerStepUp('222222'))).ok).toBe(true);
    expect((await pending).ok).toBe(true);

    const state = store.getState();
    expect(state.phase).toBe('signedIn');
    expect(state.device).toMatchObject({ name: 'iPad เคาน์เตอร์', kind: 'ipad' });
    const saved = await tokens.loadDevice();
    expect(saved?.device.name).toBe('iPad เคาน์เตอร์');
    expect(store.deviceToken()).toBe(saved?.deviceToken);
    expect(server.calls.filter((c) => c.path === '/v1/auth/device')).toHaveLength(1);
  });

  test('a second tap on Register while the first is waiting registers once', async () => {
    const { store, server } = setup();
    await store.boot();
    await store.signInOwner(ownerCredentials('111111'));
    const first = store.registerDevice({ name: 'iPad', kind: 'ipad' });
    await tick();
    const second = await store.registerDevice({ name: 'iPad', kind: 'ipad' });
    expect(second).toEqual({ ok: false, error: null, duplicate: true });
    await store.submitStepUp(ownerStepUp('222222'));
    expect((await first).ok).toBe(true);
    expect(server.calls.filter((c) => c.path === '/v1/auth/device')).toHaveLength(1);
  });

  test('cancelling the step-up registers nothing', async () => {
    const { store, server, tokens } = setup();
    await store.boot();
    await store.signInOwner(ownerCredentials('111111'));
    const pending = store.registerDevice({ name: 'iPad', kind: 'ipad' });
    await tick();
    store.cancelStepUp();
    expect(await pending).toEqual({ ok: false, error: null });
    expect(store.getState().stepUpOpen).toBe(false);
    expect(server.calls.some((c) => c.path === '/v1/auth/device')).toBe(false);
    expect(await tokens.loadDevice()).toBeNull();
    expect(store.getState().device).toBeNull();
  });

  test('a recovery code can stand in for the second app code', async () => {
    const { store } = setup();
    await store.boot();
    await store.signInOwner(ownerCredentials('111111'));
    const pending = store.registerDevice({ name: 'iPad', kind: 'ipad' });
    await tick();
    const accepted = await store.submitStepUp({
      method: 'owner',
      factors: { password: MOCK_OWNER.password, recoveryCode: MOCK_OWNER.recoveryCode },
    });
    expect(accepted.ok).toBe(true);
    expect((await pending).ok).toBe(true);
  });

  test('if the server still wants a step-up, the dialog opens again and the call is retried once', async () => {
    let refused = false;
    const { store, server } = setup({
      intercept: (call) => {
        if (call.path !== '/v1/auth/device' || refused) return undefined;
        refused = true;
        return new Response(
          JSON.stringify({ code: 'STEP_UP_REQUIRED', message: 'x', details: {} }),
          {
            status: 403,
          },
        );
      },
    });
    await store.boot();
    await store.signInOwner(ownerCredentials('111111'));

    const pending = store.registerDevice({ name: 'iPad', kind: 'ipad' });
    await tick();
    expect((await store.submitStepUp(ownerStepUp('222222'))).ok).toBe(true);
    // The server said "step up" anyway: the dialog is back, asking for a new code.
    await tick();
    expect(store.getState().stepUpOpen).toBe(true);
    expect(store.getState().stepUpUntil).toBeNull();
    expect((await store.submitStepUp(ownerStepUp('333333'))).ok).toBe(true);
    expect((await pending).ok).toBe(true);
    expect(server.calls.filter((c) => c.path === '/v1/auth/device')).toHaveLength(2);
  });

  test('a device token the server forgot does not block owner sign-in: it is dropped and retried', async () => {
    const env = await registeredAndLocked();
    env.server.revoke(env.registration.deviceToken);
    const result = await env.store.signInOwner(ownerCredentials('111111'));
    expect(result.ok).toBe(true);
    expect(env.store.getState().device).toBeNull();
    expect(env.store.getState().phase).toBe('unregistered');
    expect(await env.tokens.loadDevice()).toBeNull();
    expect(env.store.getState().session?.staff.role).toBe('owner');
  });
});

describe('step-up', () => {
  test('a cashier steps up with the PIN, and it lapses after five minutes', async () => {
    const { store, clock } = await signedInAsCashier();
    expect(store.hasFreshStepUp()).toBe(false);

    const asked = store.ensureStepUp();
    expect(store.getState().stepUpOpen).toBe(true);
    expect((await store.submitStepUp({ method: 'pin', pin: cashier.pin })).ok).toBe(true);
    expect(await asked).toBe(true);
    expect(store.getState().stepUpOpen).toBe(false);
    expect(store.hasFreshStepUp()).toBe(true);
    expect(await store.ensureStepUp()).toBe(true);

    clock.advance(5 * 60_000);
    expect(store.hasFreshStepUp()).toBe(false);
  });

  test('the factor follows the role: a cashier cannot step up with a password', async () => {
    const { store, server } = await signedInAsCashier();
    store.ensureStepUp();
    const before = server.calls.length;
    const result = await store.submitStepUp(ownerStepUp('111111'));
    expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_INVALID' } });
    expect(server.calls.length).toBe(before);
  });

  test('a wrong step-up PIN keeps the dialog open; cancelling resolves the waiting caller', async () => {
    const { store } = await signedInAsCashier();
    const asked = store.ensureStepUp();
    const wrong = await store.submitStepUp({ method: 'pin', pin: '0000' });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    expect(store.getState().stepUpOpen).toBe(true);
    store.cancelStepUp();
    expect(await asked).toBe(false);
  });

  test('a sensitive call within the window runs without asking', async () => {
    const { store } = await signedInAsCashier();
    const asked = store.ensureStepUp();
    await store.submitStepUp({ method: 'pin', pin: cashier.pin });
    await asked;
    let runs = 0;
    const outcome = await store.runSensitive(async () => {
      runs += 1;
      return 'done';
    });
    expect(outcome).toEqual({ ok: true, value: 'done' });
    expect(runs).toBe(1);
    expect(store.getState().stepUpOpen).toBe(false);
  });

  test('a failure that is not about step-up is returned, not retried', async () => {
    const { store } = await signedInAsCashier();
    const asked = store.ensureStepUp();
    await store.submitStepUp({ method: 'pin', pin: cashier.pin });
    await asked;
    let runs = 0;
    const outcome = await store.runSensitive(async () => {
      runs += 1;
      throw new ApiClientError('FORBIDDEN', { status: 403 });
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(runs).toBe(1);
  });
});

describe('sign-out', () => {
  test('clears the session, role, step-up and stored session, but keeps the device', async () => {
    const { store, tokens, server } = await signedInAsCashier();
    const asked = store.ensureStepUp();
    await store.submitStepUp({ method: 'pin', pin: cashier.pin });
    await asked;
    expect(store.sessionToken()).not.toBeNull();

    await store.signOut();
    const state = store.getState();
    expect(state.phase).toBe('locked');
    expect(state.session).toBeNull();
    expect(state.stepUpUntil).toBeNull();
    expect(store.sessionToken()).toBeNull();
    expect(can(state, 'order.create')).toBe(false);
    expect(store.hasFreshStepUp()).toBe(false);
    expect(await tokens.loadSession()).toBeNull();
    expect((await tokens.loadDevice())?.device.name).toBe('iPad ตัวอย่าง');
    expect(store.deviceToken()).not.toBeNull();
    expect(server.calls.some((c) => c.path === '/v1/auth/logout')).toBe(true);
  });

  test('revokes the session on the server, even though the local copy is cleared first', async () => {
    const env = await signedInAsCashier();
    const token = env.store.sessionToken();
    await env.store.signOut();
    // The same token no longer works.
    const probe = createApiClient({
      baseUrl: BASE,
      fetch: env.server.fetch,
      getSessionToken: () => token,
      getDeviceToken: () => env.store.deviceToken(),
    });
    await expect(probe.auth.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  test('works offline: the local state is cleared even though logout cannot reach the server', async () => {
    const env = await signedInAsCashier();
    const offline = restart(env, (() => Promise.reject(new TypeError('offline'))) as typeof fetch);
    await offline.store.boot(); // saved session is kept while offline
    expect(offline.store.getState().phase).toBe('signedIn');
    await expect(offline.store.signOut()).resolves.toBeUndefined();
    expect(offline.store.getState().session).toBeNull();
    expect(await env.tokens.loadSession()).toBeNull();
  });

  test('closes an open step-up dialog and tells other stores to empty', async () => {
    const { store } = await signedInAsCashier();
    let emptied = 0;
    store.onSignOut(() => {
      emptied += 1;
    });
    const asked = store.ensureStepUp();
    await store.signOut();
    expect(await asked).toBe(false);
    expect(store.getState().stepUpOpen).toBe(false);
    expect(emptied).toBe(1);
  });

  test('an owner who has just registered the device signs out to the PIN screen', async () => {
    const { store, tokens } = setup();
    await store.boot();
    await store.signInOwner(ownerCredentials('111111'));
    expect((await registerWithStepUp(store, '222222')).ok).toBe(true);
    await store.signOut();
    expect(store.getState().phase).toBe('locked');
    expect(await tokens.loadDevice()).not.toBeNull();
  });
});

describe('the server ends the session or the device', () => {
  test('an expired session found by any call returns to the PIN screen with a notice', async () => {
    const { store, server, api, tokens } = await signedInAsCashier();
    server.revokeAllSessions();
    await expect(api.orders.list()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(store.getState().phase).toBe('locked');
    expect(store.getState().notice).toBe('sessionExpired');
    expect(await tokens.loadSession()).toBeNull();
  });

  test('a removed device is forgotten everywhere', async () => {
    const { store, server, tokens, registration } = await signedInAsCashier();
    server.revoke(registration.deviceToken);
    await store.loadStaff();
    await tick();
    expect(store.getState().phase).toBe('unregistered');
    expect(store.getState().notice).toBe('deviceRemoved');
    expect(store.deviceToken()).toBeNull();
    expect(store.sessionToken()).toBeNull();
    expect(await tokens.loadDevice()).toBeNull();
    expect(await tokens.loadSession()).toBeNull();
  });

  test('a PIN session used without its device token is dropped with a notice', async () => {
    const { store, server } = await signedInAsCashier();
    const withoutDevice = createApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      getSessionToken: () => store.sessionToken(),
      getDeviceToken: () => null,
      onAuthFailure: (error) => store.handleAuthFailure(error),
    });
    await expect(withoutDevice.auth.me()).rejects.toMatchObject({ code: 'DEVICE_MISMATCH' });
    await tick();
    expect(store.getState().phase).toBe('locked');
    expect(store.getState().notice).toBe('deviceMismatch');
  });
});

describe('permissions', () => {
  test('come from the session the server issued', async () => {
    const { store } = await signedInAsCashier();
    const state = store.getState();
    expect(can(state, 'order.create')).toBe(true);
    expect(can(state, 'menu.edit')).toBe(false);
    expect(can(state, 'settings.edit')).toBe(false);
  });
});
