import type { DeviceDto, StaffDto } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { type AdminDeps, createAdminStore } from './admin-store.ts';

const NOW = '2026-10-03T03:00:00.000Z';
const device = (n: number, over: Partial<DeviceDto> = {}): DeviceDto => ({
  id: `0192f3a0-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  name: `iPad ${n}`,
  kind: 'ipad',
  lastSeenAt: NOW,
  revokedAt: null,
  version: 1,
  ...over,
});
const person = (n: number, over: Partial<StaffDto> = {}): StaffDto => ({
  id: `0192f3a0-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  displayName: `คนที่ ${n}`,
  role: 'cashier',
  active: true,
  hasPin: true,
  pinLockedUntil: null,
  version: 1,
  ...over,
});

/** Like `auth.runSensitive` with a fresh step-up: the call's own failure comes back as a result. */
const passThrough: AdminDeps['auth']['runSensitive'] = async (call) => {
  try {
    return { ok: true as const, value: await call() };
  } catch (error) {
    return { ok: false as const, error: error as ApiClientError };
  }
};

function env(
  options: {
    admin?: Partial<ApiClient['admin']>;
    runSensitive?: AdminDeps['auth']['runSensitive'];
    online?: boolean;
  } = {},
) {
  const admin = {
    devices: vi.fn(options.admin?.devices ?? (async () => ({ devices: [device(1), device(2)] }))),
    revokeDevice: vi.fn(
      options.admin?.revokeDevice ??
        (async (id: string) => device(1, { id, revokedAt: NOW, version: 2 })),
    ),
    staff: vi.fn(options.admin?.staff ?? (async () => ({ staff: [person(1), person(2)] }))),
    createStaff: vi.fn(options.admin?.createStaff ?? (async () => person(3))),
    patchStaff: vi.fn(
      options.admin?.patchStaff ??
        (async (id: string) => person(1, { id, active: false, version: 2 })),
    ),
    setStaffPin: vi.fn(options.admin?.setStaffPin ?? (async (id: string) => person(1, { id }))),
  };
  const store = createAdminStore({
    api: { admin: admin as unknown as ApiClient['admin'] },
    lifecycle: { isOnline: () => options.online ?? true },
    auth: { runSensitive: options.runSensitive ?? passThrough },
  });
  return { store, admin };
}

describe('reading the lists (a step-up first)', () => {
  test('devices and staff are read inside the step-up and held', async () => {
    let asked = 0;
    const { store, admin } = env({
      runSensitive: async (call) => {
        asked += 1;
        return passThrough(call);
      },
    });
    await store.loadDevices();
    await store.loadStaff();
    expect(asked).toBe(2);
    expect(admin.devices).toHaveBeenCalledTimes(1);
    expect(store.getState().devices).toMatchObject({ status: 'ready' });
    expect(store.getState().devices.items).toHaveLength(2);
    expect(store.getState().staff.items).toHaveLength(2);
  });

  test('a step-up the person closes leaves the list "locked": nothing was asked of the server and no error is shown', async () => {
    const { store, admin } = env({
      runSensitive: async () => ({ ok: false as const, error: null }),
    });
    await store.loadStaff();
    expect(admin.staff).not.toHaveBeenCalled();
    expect(store.getState().staff).toMatchObject({ status: 'locked', error: null, items: [] });
  });

  test('a failed first read is an error with its code; a failed later read keeps the rows', async () => {
    let fail = false;
    const { store } = env({
      admin: {
        staff: async () => {
          if (fail) throw new ApiClientError('NETWORK');
          return { staff: [person(1)] };
        },
      },
    });
    await store.loadStaff();
    fail = true;
    await store.loadStaff();
    expect(store.getState().staff.status).toBe('ready');
    expect(store.getState().staff.items).toHaveLength(1);

    const first = env({
      admin: {
        devices: async () => {
          throw new ApiClientError('FORBIDDEN', { status: 403 });
        },
      },
    });
    await first.store.loadDevices();
    expect(first.store.getState().devices.status).toBe('error');
    expect(first.store.getState().devices.error?.code).toBe('FORBIDDEN');
  });

  test('offline: nothing is asked', async () => {
    const { store, admin } = env({ online: false });
    await store.loadStaff();
    expect(admin.staff).not.toHaveBeenCalled();
  });
});

describe('devices', () => {
  test('revoking replaces the row with the one the server answered', async () => {
    const { store, admin } = env();
    await store.loadDevices();
    const target = store.getState().devices.items[0] as DeviceDto;
    const outcome = await store.revokeDevice(target.id);
    expect(outcome).toMatchObject({ ok: true });
    expect(admin.revokeDevice).toHaveBeenCalledWith(target.id);
    expect(store.getState().devices.items[0]?.revokedAt).toBe(NOW);
    expect(store.getState().devices.items).toHaveLength(2);
  });

  test('a second tap while one is on its way sends nothing; offline sends nothing', async () => {
    let release: () => void = () => undefined;
    const { store, admin } = env({
      admin: {
        revokeDevice: () =>
          new Promise((resolve) => {
            release = () => resolve(device(1, { revokedAt: NOW }));
          }),
      },
    });
    await store.loadDevices();
    const id = (store.getState().devices.items[0] as DeviceDto).id;
    const first = store.revokeDevice(id);
    expect(await store.revokeDevice(id)).toEqual({ ok: false, reason: 'busy' });
    release();
    await first;
    expect(admin.revokeDevice).toHaveBeenCalledTimes(1);

    const off = env({ online: false });
    expect(await off.store.revokeDevice(id)).toEqual({ ok: false, reason: 'offline' });
    expect(off.admin.revokeDevice).not.toHaveBeenCalled();
  });
});

describe('staff', () => {
  const input = { displayName: 'น้องใหม่', role: 'cashier' as const, pin: '1234' };

  test('a new person is sent once, exactly as typed, and appears in the list; the PIN is held nowhere', async () => {
    const { store, admin } = env();
    await store.loadStaff();
    const outcome = await store.createStaff(input);
    expect(outcome).toMatchObject({ ok: true });
    expect(admin.createStaff).toHaveBeenCalledTimes(1);
    expect(admin.createStaff).toHaveBeenCalledWith(input);
    expect(store.getState().staff.items).toHaveLength(3);
    expect(JSON.stringify(store.getState())).not.toContain('1234');
  });

  test('a double tap creates one person', async () => {
    let release: () => void = () => undefined;
    const { store, admin } = env({
      admin: {
        createStaff: () =>
          new Promise((resolve) => {
            release = () => resolve(person(3));
          }),
      },
    });
    const first = store.createStaff(input);
    const second = await store.createStaff(input);
    expect(second).toEqual({ ok: false, reason: 'busy' });
    release();
    await first;
    expect(admin.createStaff).toHaveBeenCalledTimes(1);
  });

  test('a lost answer to a create is "uncertain": the list is read again so the person can see whether it happened, and nothing is retried', async () => {
    let creates = 0;
    const { store, admin } = env({
      admin: {
        createStaff: async () => {
          creates += 1;
          throw new ApiClientError('TIMEOUT');
        },
        staff: async () => ({ staff: [person(1), person(9, { displayName: 'น้องใหม่' })] }),
      },
    });
    const outcome = await store.createStaff(input);
    expect(outcome).toMatchObject({ ok: false, reason: 'error', uncertain: true });
    expect(creates).toBe(1);
    expect(admin.staff).toHaveBeenCalledTimes(1);
    expect(store.getState().staff.items.map((p) => p.displayName)).toContain('น้องใหม่');
  });

  test('a refusal the server gave is not uncertain and the list is not read again', async () => {
    const { store, admin } = env({
      admin: {
        createStaff: async () => {
          throw new ApiClientError('VALIDATION_ERROR', { status: 400 });
        },
      },
    });
    const outcome = await store.createStaff(input);
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'error',
      uncertain: false,
      refreshed: false,
    });
    expect(admin.staff).not.toHaveBeenCalled();
  });

  test('deactivating sends the version the row had, then holds the new row', async () => {
    const { store, admin } = env();
    await store.loadStaff();
    const target = store.getState().staff.items[0] as StaffDto;
    await store.patchStaff(target, { active: false });
    expect(admin.patchStaff).toHaveBeenCalledWith(target.id, {
      expectedVersion: 1,
      active: false,
    });
    expect(store.getState().staff.items[0]).toMatchObject({ active: false, version: 2 });
  });

  test('VERSION_CONFLICT reads the list again and says so; no retry', async () => {
    const { store, admin } = env({
      admin: {
        patchStaff: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 4 });
        },
      },
    });
    await store.loadStaff();
    const outcome = await store.patchStaff(store.getState().staff.items[0] as StaffDto, {
      displayName: 'ชื่อใหม่',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: true });
    expect(admin.patchStaff).toHaveBeenCalledTimes(1);
    expect(admin.staff).toHaveBeenCalledTimes(2);
  });

  test('a new PIN is sent for that person only and not kept', async () => {
    const { store, admin } = env();
    await store.loadStaff();
    const target = store.getState().staff.items[1] as StaffDto;
    expect(await store.setStaffPin(target.id, '654321')).toMatchObject({ ok: true });
    expect(admin.setStaffPin).toHaveBeenCalledWith(target.id, { pin: '654321' });
    expect(JSON.stringify(store.getState())).not.toContain('654321');
  });

  test('a step-up the person closes cancels the change without an error', async () => {
    const { store, admin } = env({
      runSensitive: async () => ({ ok: false as const, error: null }),
    });
    expect(await store.createStaff(input)).toEqual({ ok: false, reason: 'cancelled' });
    expect(admin.createStaff).not.toHaveBeenCalled();
  });

  test('an answer that arrives after sign-out changes nothing', async () => {
    let release: () => void = () => undefined;
    const { store } = env({
      admin: {
        createStaff: () =>
          new Promise((resolve) => {
            release = () => resolve(person(3));
          }),
      },
    });
    const pending = store.createStaff(input);
    store.reset();
    release();
    expect(await pending).toEqual({ ok: false, reason: 'stale' });
    expect(store.getState().staff.items).toEqual([]);
  });
});
