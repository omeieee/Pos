import type { InviteDto, StaffDto } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { type AdminDeps, createAdminStore } from './admin-store.ts';

const NOW = '2026-10-04T03:00:00.000Z';
const TOKEN = 'tok_MADEUP_invite_token_0001';
const person = (n: number, over: Partial<StaffDto> = {}): StaffDto => ({
  id: `0192f3a0-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  displayName: `คนที่ ${n}`,
  role: 'cashier',
  active: true,
  email: null,
  hasPin: true,
  pinLockedUntil: null,
  version: 1,
  ...over,
});
const invite = (n: number, over: Partial<InviteDto> = {}): InviteDto => ({
  id: `0192f3a0-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`,
  email: `person${n}@example.test`,
  role: 'cashier',
  displayName: null,
  createdAt: NOW,
  expiresAt: '2026-10-07T03:00:00.000Z',
  status: 'open',
  ...over,
});

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
  } = {},
) {
  const admin = {
    staff: vi.fn(options.admin?.staff ?? (async () => ({ staff: [person(1), person(2)] }))),
    changeStaffRole: vi.fn(
      options.admin?.changeStaffRole ??
        (async (id: string, body: { role: StaffDto['role'] }) =>
          person(1, { id, role: body.role, version: 2 })),
    ),
    invites: vi.fn(options.admin?.invites ?? (async () => ({ invites: [invite(1)] }))),
    createInvite: vi.fn(
      options.admin?.createInvite ??
        (async (input: { email: string }) => ({
          ...invite(2, { email: input.email }),
          token: TOKEN,
        })),
    ),
    revokeInvite: vi.fn(options.admin?.revokeInvite ?? (async () => undefined)),
  };
  const store = createAdminStore({
    api: { admin: admin as unknown as ApiClient['admin'] },
    lifecycle: { isOnline: () => true },
    auth: { runSensitive: options.runSensitive ?? passThrough },
  });
  return { store, admin };
}

describe('role changes', () => {
  test('a role change sends the version the row had and the PIN only when given, then holds the new row', async () => {
    const { store, admin } = env();
    await store.loadStaff();
    const target = store.getState().staff.items[0] as StaffDto;
    expect(await store.changeRole(target, 'manager', '654321')).toMatchObject({ ok: true });
    expect(admin.changeStaffRole).toHaveBeenCalledWith(target.id, {
      expectedVersion: 1,
      role: 'manager',
      pin: '654321',
    });
    expect(store.getState().staff.items[0]).toMatchObject({ role: 'manager', version: 2 });
    expect(JSON.stringify(store.getState())).not.toContain('654321');
    await store.changeRole(store.getState().staff.items[0] as StaffDto, 'kitchen');
    expect(admin.changeStaffRole).toHaveBeenLastCalledWith(target.id, {
      expectedVersion: 2,
      role: 'kitchen',
    });
  });

  test('VERSION_CONFLICT reads the list again and says so', async () => {
    const { store, admin } = env({
      admin: {
        changeStaffRole: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 4 });
        },
      },
    });
    await store.loadStaff();
    const outcome = await store.changeRole(store.getState().staff.items[0] as StaffDto, 'kitchen');
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: true });
    expect(admin.staff).toHaveBeenCalledTimes(2);
  });

  test.each(['LAST_OWNER', 'SELF_CHANGE', 'OWNER_NEEDS_ACCOUNT'])(
    '%s keeps its code and does not read the list again',
    async (code) => {
      const { store, admin } = env({
        admin: {
          changeStaffRole: async () => {
            throw new ApiClientError(code, { status: 409 });
          },
        },
      });
      await store.loadStaff();
      const refused = await store.changeRole(
        store.getState().staff.items[0] as StaffDto,
        'kitchen',
      );
      expect(refused).toMatchObject({ ok: false, reason: 'error', refreshed: false });
      expect(refused.ok === false && refused.reason === 'error' && refused.error.code).toBe(code);
      expect(admin.staff).toHaveBeenCalledTimes(1);
    },
  );
});

describe('invites', () => {
  test('the staff screen reads staff, then the invites, so the owner confirms once', async () => {
    const order: string[] = [];
    const { store } = env({
      admin: {
        staff: async () => {
          order.push('staff');
          return { staff: [person(1)] };
        },
        invites: async () => {
          order.push('invites');
          return { invites: [invite(1)] };
        },
      },
    });
    await store.loadStaffScreen();
    expect(order).toEqual(['staff', 'invites']);
    expect(store.getState().invites).toMatchObject({ status: 'ready' });
    expect(store.getState().invites.items).toHaveLength(1);
  });

  test('if the staff list was not confirmed, the invites are not asked for', async () => {
    const { store, admin } = env({
      runSensitive: async () => ({ ok: false as const, error: null }),
    });
    await store.loadStaffScreen();
    expect(admin.invites).not.toHaveBeenCalled();
    expect(store.getState().invites.status).toBe('idle');
  });

  test('a new invite hands the token to the caller only; the list keeps the row without it', async () => {
    const { store, admin } = env();
    await store.loadInvites();
    const outcome = await store.createInvite({ email: 'nok@example.test', role: 'manager' });
    expect(admin.createInvite).toHaveBeenCalledWith({ email: 'nok@example.test', role: 'manager' });
    expect(outcome.ok && outcome.value.token).toBe(TOKEN);
    const state = store.getState();
    expect(state.invites.items.map((i) => i.email)).toEqual([
      'person1@example.test',
      'nok@example.test',
    ]);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  test('a double tap makes one invite', async () => {
    let release: () => void = () => undefined;
    const { store, admin } = env({
      admin: {
        createInvite: () =>
          new Promise((resolve) => {
            release = () => resolve({ ...invite(2), token: TOKEN });
          }),
      },
    });
    const first = store.createInvite({ email: 'a@example.test', role: 'cashier' });
    expect(await store.createInvite({ email: 'a@example.test', role: 'cashier' })).toEqual({
      ok: false,
      reason: 'busy',
    });
    release();
    await first;
    expect(admin.createInvite).toHaveBeenCalledTimes(1);
  });

  test('a lost answer to a create is "uncertain": the invites are read again, nothing is retried', async () => {
    let reads = 0;
    const { store, admin } = env({
      admin: {
        createInvite: async () => {
          throw new ApiClientError('TIMEOUT');
        },
        invites: async () => {
          reads += 1;
          return { invites: reads === 1 ? [] : [invite(5, { email: 'lost@example.test' })] };
        },
      },
    });
    await store.loadInvites();
    const outcome = await store.createInvite({ email: 'lost@example.test', role: 'cashier' });
    expect(outcome).toMatchObject({ ok: false, reason: 'error', uncertain: true });
    expect(admin.createInvite).toHaveBeenCalledTimes(1);
    expect(store.getState().invites.items.map((i) => i.email)).toEqual(['lost@example.test']);
    expect(admin.staff).not.toHaveBeenCalled();
  });

  test.each(['EMAIL_TAKEN', 'INVITE_EXISTS'])(
    'a refusal (%s) is not uncertain and reads nothing again',
    async (code) => {
      const { store, admin } = env({
        admin: {
          createInvite: async () => {
            throw new ApiClientError(code, { status: 409 });
          },
        },
      });
      const outcome = await store.createInvite({ email: 'a@example.test', role: 'cashier' });
      expect(outcome).toMatchObject({ ok: false, reason: 'error', uncertain: false });
      expect(admin.invites).not.toHaveBeenCalled();
    },
  );

  test('revoking removes the row; an invite accepted meanwhile reads the list again', async () => {
    const { store, admin } = env({
      admin: { invites: async () => ({ invites: [invite(1), invite(2)] }) },
    });
    await store.loadInvites();
    const target = store.getState().invites.items[0] as InviteDto;
    expect(await store.revokeInvite(target.id)).toMatchObject({ ok: true });
    expect(admin.revokeInvite).toHaveBeenCalledWith(target.id);
    expect(store.getState().invites.items.map((i) => i.id)).toEqual([invite(2).id]);

    const late = env({
      admin: {
        revokeInvite: async () => {
          throw new ApiClientError('INVITE_ACCEPTED', { status: 409 });
        },
      },
    });
    await late.store.loadInvites();
    const outcome = await late.store.revokeInvite(invite(1).id);
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: true });
    expect(late.admin.invites).toHaveBeenCalledTimes(2);
  });

  test('sign-out clears the invites', async () => {
    const { store } = env();
    await store.loadInvites();
    store.reset();
    expect(store.getState().invites).toMatchObject({ status: 'idle', items: [] });
  });
});
