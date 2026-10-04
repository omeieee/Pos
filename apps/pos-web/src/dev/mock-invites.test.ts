import { describe, expect, test } from 'vitest';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createServices } from '../services.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { MOCK_INVITE_CODE } from './mock-admin.ts';
import { createMockServer, MOCK_OWNER, MOCK_STAFF } from './mock-server.ts';

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

async function ownerSession() {
  const server = createMockServer();
  const services = await connect(server);
  const owner = MOCK_STAFF.find((s) => s.role === 'owner');
  await services.auth.signInWithPin(owner?.id ?? '', owner?.pin ?? '');
  const result = await services.auth.submitStepUp({
    method: 'owner',
    factors: { password: MOCK_OWNER.password, totp: '111111' },
  });
  if (!result.ok) throw new Error('the step-up failed');
  return { server, services, owner };
}

const accept = (token: string, over: Record<string, string> = {}) => ({
  token,
  displayName: 'น้องนก',
  password: 'a long enough made-up password',
  pin: '1234',
  totpCode: MOCK_INVITE_CODE,
  ...over,
});

describe('the mock invites answer like the API', () => {
  test('the whole journey: invite, preview, wrong code, accept, the person exists with their e-mail and PIN', async () => {
    const { server, services } = await ownerSession();
    const made = await services.api.admin.createInvite({
      email: 'nok@example.test',
      role: 'cashier',
    });
    expect(made).toMatchObject({ email: 'nok@example.test', role: 'cashier', status: 'open' });
    expect(made.token).toBeTruthy();
    // The list never carries the token.
    const listed = await services.api.admin.invites();
    expect(listed.invites).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(made.token);

    // The public calls need no session: a fresh client with no tokens makes them.
    const anyone = await connect(server);
    const first = await anyone.api.auth.invitePreview({ token: made.token });
    expect(first).toMatchObject({ email: 'nok@example.test', role: 'cashier' });
    const second = await anyone.api.auth.invitePreview({ token: made.token });
    // Each preview hands out a new secret: only the last one counts.
    expect(second.totp.secretBase32).not.toBe(first.totp.secretBase32);
    expect(second.totp.otpauthUri).toContain(second.totp.secretBase32);

    await expect(
      anyone.api.auth.inviteAccept(accept(made.token, { totpCode: '000000' })),
    ).rejects.toMatchObject({ code: 'INVITE_CODE_INVALID', status: 422 });
    const done = await anyone.api.auth.inviteAccept(accept(made.token));
    expect(done.recoveryCodes).toHaveLength(8);

    // The link is spent.
    await expect(anyone.api.auth.invitePreview({ token: made.token })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
      status: 404,
    });
    await expect(anyone.api.auth.inviteAccept(accept(made.token))).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });

    const { staff } = await services.api.admin.staff();
    const person = staff.find((p) => p.email === 'nok@example.test');
    expect(person).toMatchObject({ displayName: 'น้องนก', role: 'cashier', hasPin: true });
    expect((await services.api.admin.invites()).invites).toHaveLength(0);
    // The new person signs in with their PIN on a counter device.
    const counter = await connect(server);
    expect((await counter.auth.signInWithPin(person?.id ?? '', '1234')).ok).toBe(true);
  });

  test('an e-mail with an account or an open invite is refused; a cancelled link is dead', async () => {
    const { server, services } = await ownerSession();
    await expect(
      services.api.admin.createInvite({ email: MOCK_OWNER.email, role: 'cashier' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
    const made = await services.api.admin.createInvite({
      email: 'a@example.test',
      role: 'kitchen',
    });
    await expect(
      services.api.admin.createInvite({ email: 'a@example.test', role: 'kitchen' }),
    ).rejects.toMatchObject({ code: 'INVITE_EXISTS', status: 409 });
    await services.api.admin.revokeInvite(made.id);
    const anyone = await connect(server);
    await expect(anyone.api.auth.invitePreview({ token: made.token })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
    // Cancelled: a new invite for the same e-mail is allowed again.
    await expect(
      services.api.admin.createInvite({ email: 'a@example.test', role: 'kitchen' }),
    ).resolves.toMatchObject({ status: 'open' });
  });

  test('an invite expires after 72 hours', async () => {
    let now = Date.parse('2026-10-04T03:00:00.000Z');
    const server = createMockServer({ now: () => now });
    const services = await connect(server);
    const owner = MOCK_STAFF.find((s) => s.role === 'owner');
    await services.auth.signInWithPin(owner?.id ?? '', owner?.pin ?? '');
    await services.auth.submitStepUp({
      method: 'owner',
      factors: { password: MOCK_OWNER.password, totp: '111111' },
    });
    const made = await services.api.admin.createInvite({
      email: 'late@example.test',
      role: 'kitchen',
    });
    expect(Date.parse(made.expiresAt) - now).toBe(72 * 3600_000);
    now += 72 * 3600_000 + 1;
    await services.auth.submitStepUp({
      method: 'owner',
      factors: { password: MOCK_OWNER.password, totp: '222222' },
    });
    expect((await services.api.admin.invites()).invites[0]).toMatchObject({ status: 'expired' });
    const anyone = await connect(server);
    await expect(anyone.api.auth.invitePreview({ token: made.token })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
  });

  test('the PIN of an accepted invite must fit the role (an owner needs 6 digits)', async () => {
    const { server, services } = await ownerSession();
    const made = await services.api.admin.createInvite({ email: 'co@example.test', role: 'owner' });
    const anyone = await connect(server);
    await anyone.api.auth.invitePreview({ token: made.token });
    await expect(anyone.api.auth.inviteAccept(accept(made.token))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await anyone.api.auth.inviteAccept(accept(made.token, { pin: '246810' }));
    const { staff } = await services.api.admin.staff();
    expect(staff.find((p) => p.email === 'co@example.test')).toMatchObject({ role: 'owner' });
  });
});

describe('the mock role change and owner guards answer like the API', () => {
  test('nobody changes or deactivates themselves', async () => {
    const { services, owner } = await ownerSession();
    const { staff } = await services.api.admin.staff();
    const me = staff.find((p) => p.id === owner?.id);
    if (!me) throw new Error('the owner was expected');
    await expect(
      services.api.admin.changeStaffRole(me.id, {
        expectedVersion: me.version,
        role: 'manager',
        pin: '123456',
      }),
    ).rejects.toMatchObject({ code: 'SELF_CHANGE', status: 409 });
    await expect(
      services.api.admin.patchStaff(me.id, { expectedVersion: me.version, displayName: 'ชื่อใหม่' }),
    ).rejects.toMatchObject({ code: 'SELF_CHANGE' });
  });

  test('a longer PIN is required to move up; a stale version conflicts; the role change ends their sessions', async () => {
    const { server, services } = await ownerSession();
    const { staff } = await services.api.admin.staff();
    const cashier = staff.find((p) => p.role === 'cashier');
    if (!cashier) throw new Error('the dev cashier was expected');
    // 4 -> 6 digits needs a PIN, and it must fit the new role.
    await expect(
      services.api.admin.changeStaffRole(cashier.id, {
        expectedVersion: cashier.version,
        role: 'manager',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      services.api.admin.changeStaffRole(cashier.id, {
        expectedVersion: cashier.version + 1,
        role: 'manager',
        pin: '123456',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: cashier.version });

    const person = MOCK_STAFF.find((s) => s.role === 'cashier');
    const counter = await connect(server);
    expect((await counter.auth.signInWithPin(cashier.id, person?.pin ?? '')).ok).toBe(true);
    const moved = await services.api.admin.changeStaffRole(cashier.id, {
      expectedVersion: cashier.version,
      role: 'manager',
      pin: '123456',
    });
    expect(moved).toMatchObject({ role: 'manager', version: cashier.version + 1 });
    expect(JSON.stringify(moved)).not.toContain('123456');
    await expect(counter.api.auth.me()).rejects.toBeTruthy();
    // 6 -> 4 digits needs no PIN.
    const down = await services.api.admin.changeStaffRole(cashier.id, {
      expectedVersion: moved.version,
      role: 'kitchen',
    });
    expect(down.role).toBe('kitchen');
  });

  test('a PIN-only person cannot become an owner; a co-owner can be deactivated by another owner', async () => {
    const { server, services } = await ownerSession();
    const { staff } = await services.api.admin.staff();
    const cashier = staff.find((p) => p.role === 'cashier');
    if (!cashier) throw new Error('the dev cashier was expected');
    await expect(
      services.api.admin.changeStaffRole(cashier.id, {
        expectedVersion: cashier.version,
        role: 'owner',
        pin: '123456',
      }),
    ).rejects.toMatchObject({ code: 'OWNER_NEEDS_ACCOUNT', status: 409 });

    const made = await services.api.admin.createInvite({ email: 'co@example.test', role: 'owner' });
    const anyone = await connect(server);
    await anyone.api.auth.invitePreview({ token: made.token });
    await anyone.api.auth.inviteAccept(accept(made.token, { pin: '246810' }));
    const after = (await services.api.admin.staff()).staff;
    const co = after.find((p) => p.email === 'co@example.test');
    if (!co) throw new Error('the co-owner was expected');
    const off = await services.api.admin.patchStaff(co.id, {
      expectedVersion: co.version,
      active: false,
    });
    expect(off).toMatchObject({ role: 'owner', active: false });
  });
});
