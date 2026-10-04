import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createMockServer, MOCK_OWNER, MOCK_STAFF } from './mock-server.ts';

/** A second device on the same dev server (a person signs in here after the owner changed something). */
async function connect(server: ReturnType<typeof createMockServer>) {
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice(server.issueDeviceToken('iPhone ทดสอบ', 'iphone'));
  const services = createServices({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    tokens,
    createSocket: server.createSocket,
    lifecycle: createFakeLifecycle().lifecycle,
  });
  await services.auth.boot();
  await services.auth.loadStaff();
  return services;
}

async function signedIn(role: 'owner' | 'manager' | 'cashier' | 'kitchen', stepUp = false) {
  const server = createMockServer();
  const services = await connect(server);
  const person = MOCK_STAFF.find((s) => s.role === role);
  await services.auth.signInWithPin(person?.id ?? '', person?.pin ?? '');
  if (stepUp) {
    const result = await services.auth.submitStepUp({
      method: 'owner',
      factors: { password: MOCK_OWNER.password, totp: '111111' },
    });
    if (!result.ok) throw new Error('the step-up failed');
  }
  return { server, services };
}

describe('the mock settings answer like the API', () => {
  test('a never-saved setting reads as its default at version 0; a save bumps the version and a stale one is a conflict', async () => {
    const { services } = await signedIn('manager');
    const read = await services.api.settings.shop.read();
    expect(read.version).toBe(0);
    const saved = await services.api.settings.shop.save({
      expectedVersion: 0,
      phone: '0812345678',
    });
    expect(saved).toMatchObject({ version: 1, value: { phone: '0812345678' } });
    await expect(
      services.api.settings.shop.save({ expectedVersion: 0, phone: '0899999999' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 1 });
  });

  test('a saved setting reaches the feed, so another device sees a newer version', async () => {
    const { services } = await signedIn('manager');
    await services.api.settings.numbering.save({ expectedVersion: 0, cutoffMinutes: 330 });
    // The socket is not open in this test: a catch-up read is what a device does when it connects.
    const sync = await services.api.sync.changes({ since: 0 });
    const frame = sync.changes.find(
      (c) => c.type === 'settings.updated' && c.id === 'business_day',
    );
    expect(frame).toMatchObject({ version: 1, data: { cutoffMinutes: 330 } });
  });

  test('opening hours and the building list can be changed', async () => {
    const { services } = await signedIn('manager');
    const hours = await services.api.settings.openingHours.save({
      expectedVersion: 0,
      overrides: [{ date: '2026-10-13', closed: true }],
    });
    expect(hours.value.overrides).toHaveLength(1);
    const list = await services.api.settings.deliveryList.save({
      expectedVersion: 0,
      buildings: ['A1', 'E5'],
    });
    expect(list.value.buildings).toEqual(['A1', 'E5']);
    expect((await services.api.settings.deliveryList.read()).version).toBe(1);
  });

  test('payment methods: switching one off is saved, and the order screen is told by the feed', async () => {
    const { services } = await signedIn('manager');
    const before = await services.api.settings.payments.read();
    expect(before.value.other).toBe(false);
    const after = await services.api.settings.payments.save({
      expectedVersion: before.version,
      other: true,
    });
    expect(after.value.other).toBe(true);
    expect(after.version).toBe(before.version + 1);
  });

  test('a cashier may read but not change; the kitchen may not read', async () => {
    const cashier = await signedIn('cashier');
    expect((await cashier.services.api.settings.shop.read()).version).toBe(0);
    await expect(
      cashier.services.api.settings.shop.save({ expectedVersion: 0, phone: '0812345678' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const kitchen = await signedIn('kitchen');
    await expect(kitchen.services.api.settings.shop.read()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('the mock PromptPay and co-pay settings', () => {
  test('the PromptPay ID: a manager is refused, the owner needs a step-up, then it is changed and read back masked', async () => {
    const manager = await signedIn('manager');
    await expect(
      manager.services.api.settings.promptpayMasked.save({
        expectedVersion: 1,
        idType: 'phone',
        idValue: '0899990000',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const cold = await signedIn('owner');
    await expect(
      cold.services.api.settings.promptpayMasked.save({
        expectedVersion: 1,
        idType: 'phone',
        idValue: '0899990000',
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const { services } = await signedIn('owner', true);
    const before = await services.api.settings.promptpayMasked.read();
    const saved = await services.api.settings.promptpayMasked.save({
      expectedVersion: before.version,
      idType: 'phone',
      idValue: '0899990000',
    });
    expect(saved.value).toEqual({ idType: 'phone', idMasked: '******0000' });
    expect(saved.version).toBe(before.version + 1);
    await expect(
      services.api.settings.promptpayMasked.save({
        expectedVersion: before.version,
        idType: 'phone',
        idValue: '0811112222',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  test('the co-pay scheme: owner and step-up only; the whole scheme is checked again', async () => {
    const manager = await signedIn('manager');
    await expect(
      manager.services.api.settings.govCopay.save({ expectedVersion: 1, enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const cold = await signedIn('owner');
    await expect(
      cold.services.api.settings.govCopay.save({ expectedVersion: 1, enabled: false }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const { services } = await signedIn('owner', true);
    const { scheme } = await services.api.settings.govCopay.read();
    if (!scheme) throw new Error('the dev shop has a scheme');
    const off = await services.api.settings.govCopay.save({
      expectedVersion: scheme.version,
      enabled: false,
      govDailyCapSatang: satang(15000),
    });
    expect(off.scheme).toMatchObject({ enabled: false, govDailyCapSatang: 15000 });
    // The end date before the start is refused.
    await expect(
      services.api.settings.govCopay.save({
        expectedVersion: off.scheme?.version ?? 0,
        activeTo: '2000-01-01',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Channels are not changed by a save that does not send them.
    expect(off.scheme?.channels).toEqual(scheme.channels);
  });
});

describe('the mock devices and staff', () => {
  test('a manager is refused; the owner needs a fresh step-up even to read the lists', async () => {
    const manager = await signedIn('manager');
    await expect(manager.services.api.admin.devices()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(manager.services.api.admin.staff()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const cold = await signedIn('owner');
    await expect(cold.services.api.admin.devices()).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(cold.services.api.admin.staff()).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  test('the list holds this device and the sample ones; removing one is idempotent and a removed device keeps its row', async () => {
    const { services } = await signedIn('owner', true);
    const { devices } = await services.api.admin.devices();
    expect(devices.length).toBeGreaterThanOrEqual(3);
    const here = services.auth.getState().device;
    expect(devices.some((d) => d.id === here?.id)).toBe(true);
    const sample = devices.find((d) => d.revokedAt === null && d.id !== here?.id);
    if (!sample) throw new Error('a sample device was expected');
    const first = await services.api.admin.revokeDevice(sample.id);
    expect(first.revokedAt).not.toBeNull();
    const second = await services.api.admin.revokeDevice(sample.id);
    expect(second.version).toBe(first.version);
    await expect(
      services.api.admin.revokeDevice('0192f3a0-0000-7000-8000-00000000ffff'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a new person appears on the PIN screen and signs in with their PIN; a manager PIN needs 6 digits; no answer carries a PIN', async () => {
    const { server, services } = await signedIn('owner', true);
    await expect(
      services.api.admin.createStaff({ displayName: 'ผู้จัดการใหม่', role: 'manager', pin: '123456' }),
    ).resolves.toMatchObject({ role: 'manager', hasPin: true });
    const created = await services.api.admin.createStaff({
      displayName: 'น้องใหม่',
      role: 'cashier',
      pin: '2468',
    });
    expect(JSON.stringify(created)).not.toContain('2468');
    const { staff } = await services.api.admin.staff();
    expect(staff.some((p) => p.id === created.id)).toBe(true);

    const counter = await connect(server);
    expect(counter.auth.getState().staffTiles.staff.some((p) => p.id === created.id)).toBe(true);
    const result = await counter.auth.signInWithPin(created.id, '2468');
    expect(result.ok).toBe(true);
  });

  test('deactivating ends their sessions and they leave the PIN screen; reactivating brings them back; nobody deactivates themselves', async () => {
    const { server, services } = await signedIn('owner', true);
    const { staff } = await services.api.admin.staff();
    const cashier = staff.find((p) => p.role === 'cashier');
    const boss = staff.find((p) => p.role === 'owner');
    if (!cashier || !boss) throw new Error('the dev staff were expected');
    await expect(
      services.api.admin.patchStaff(boss.id, { expectedVersion: boss.version, active: false }),
    ).rejects.toMatchObject({ code: 'SELF_CHANGE' });

    const person = MOCK_STAFF.find((s) => s.role === 'cashier');
    const counter = await connect(server);
    expect((await counter.auth.signInWithPin(cashier.id, person?.pin ?? '')).ok).toBe(true);
    await expect(counter.api.auth.me()).resolves.toBeTruthy();

    const off = await services.api.admin.patchStaff(cashier.id, {
      expectedVersion: cashier.version,
      active: false,
    });
    expect(off).toMatchObject({ active: false, version: cashier.version + 1 });
    // Their open session is over, and they are gone from the PIN screen.
    await expect(counter.api.auth.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const again = await connect(server);
    expect(again.auth.getState().staffTiles.staff.some((p) => p.id === cashier.id)).toBe(false);

    await expect(
      services.api.admin.patchStaff(cashier.id, { expectedVersion: cashier.version, active: true }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const on = await services.api.admin.patchStaff(cashier.id, {
      expectedVersion: off.version,
      active: true,
    });
    expect(on.active).toBe(true);
    const back = await connect(server);
    expect(back.auth.getState().staffTiles.staff.some((p) => p.id === cashier.id)).toBe(true);
  });

  test('a new PIN replaces the old one at once', async () => {
    const owner = await signedIn('owner', true);
    const { staff } = await owner.services.api.admin.staff();
    const cashier = staff.find((p) => p.role === 'cashier');
    if (!cashier) throw new Error('a cashier was expected');
    await expect(
      owner.services.api.admin.setStaffPin(cashier.id, { pin: '12' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    const done = await owner.services.api.admin.setStaffPin(cashier.id, { pin: '8642' });
    expect(done.hasPin).toBe(true);
    expect(JSON.stringify(done)).not.toContain('8642');
  });
});
