// @vitest-environment jsdom
import { formatDate, th, translator } from '@sds/i18n';
import type { DeviceDto, InviteDto, StaffDto, StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { IDS } from '../test-support/fixtures.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

const NOW = '2026-10-03T03:00:00.000Z';
const device = (id: string, name: string, over: Partial<DeviceDto> = {}): DeviceDto => ({
  id,
  name,
  kind: 'ipad',
  lastSeenAt: NOW,
  revokedAt: null,
  version: 1,
  ...over,
});
const OTHER_DEVICE = '0192f3a0-0000-7000-8000-000000000333';
const person = (n: number, over: Partial<StaffDto> = {}): StaffDto => ({
  id: `0192f3a0-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`,
  displayName: `พนักงาน ${n}`,
  role: 'cashier',
  active: true,
  email: null,
  hasPin: true,
  pinLockedUntil: null,
  version: 1,
  ...over,
});

async function open(
  section: 'devices' | 'staff',
  options: {
    role?: StaffRole;
    adminApi?: Partial<ApiClient['admin']>;
    freshStepUp?: boolean;
    offline?: boolean;
    /** The auth state does not know this device's id. */
    unknownDevice?: boolean;
  } = {},
) {
  const { auth: signedIn } = await createTestAuth(options.role ?? 'owner');
  // A snapshot per underlying state, so the store hook sees a stable value.
  let seen: ReturnType<typeof signedIn.getState> | null = null;
  let hidden: ReturnType<typeof signedIn.getState> | null = null;
  const auth = options.unknownDevice
    ? {
        ...signedIn,
        getState: () => {
          const now = signedIn.getState();
          if (now !== seen) {
            seen = now;
            hidden = { ...now, device: null };
          }
          return hidden as typeof now;
        },
      }
    : signedIn;
  if (options.freshStepUp !== false) {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({
    auth,
    ...(options.adminApi ? { adminApi: options.adminApi } : {}),
    ...(options.offline ? { offline: true } : {}),
  });
  renderScreen(<SettingsSectionScreen section={section} />, env.services);
  return env;
}

const devices = (): Partial<ApiClient['admin']> => ({
  devices: async () => ({
    devices: [
      device(IDS.device, 'iPad เคาน์เตอร์'),
      device(OTHER_DEVICE, 'iPhone ครัว', { kind: 'iphone', lastSeenAt: null }),
      device('0192f3a0-0000-7000-8000-000000000334', 'iPad เก่า', { revokedAt: NOW }),
    ],
  }),
});

describe('devices', () => {
  test('lists each device with its kind and last use, marks this one, and says new devices are registered on the device itself', async () => {
    await open('devices', { adminApi: devices() });
    expect(await screen.findByText('iPad เคาน์เตอร์')).toBeTruthy();
    expect(screen.getByText(tr('settings.devices.thisDevice'))).toBeTruthy();
    expect(screen.getByText(tr('settings.devices.neverSeen'))).toBeTruthy();
    expect(
      screen.getAllByText(
        tr('settings.devices.lastSeen', { time: formatDate(NOW, 'th', 'dateTime') }),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(tr('settings.devices.registerHint'))).toBeTruthy();
    // The one that was removed is shown as such and has no button.
    expect(
      screen.getByText(
        tr('settings.devices.revokedAt', { time: formatDate(NOW, 'th', 'dateTime') }),
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: tr('settings.devices.revoke', { name: 'iPad เก่า' }) }),
    ).toBeNull();
  });

  test('the device in use has no remove button, with the reason', async () => {
    await open('devices', { adminApi: devices() });
    await screen.findByText('iPad เคาน์เตอร์');
    expect(
      screen.queryByRole('button', {
        name: tr('settings.devices.revoke', { name: 'iPad เคาน์เตอร์' }),
      }),
    ).toBeNull();
    expect(screen.getByText(tr('settings.devices.revokeCurrent'))).toBeTruthy();
  });

  test('when this device is not known, no device can be removed and the page says why', async () => {
    await open('devices', { adminApi: devices(), unknownDevice: true });
    await screen.findByText('iPad เคาน์เตอร์');
    for (const name of ['iPad เคาน์เตอร์', 'iPhone ครัว']) {
      expect(
        screen.queryByRole('button', { name: tr('settings.devices.revoke', { name }) }),
      ).toBeNull();
    }
    expect(screen.getByText(tr('settings.devices.unknownSelf'))).toBeTruthy();
  });

  test('removing another device asks first, then sends the revoke once and marks the row', async () => {
    const env = await open('devices', {
      adminApi: {
        ...devices(),
        revokeDevice: async (id) =>
          device(id, 'iPhone ครัว', { kind: 'iphone', revokedAt: NOW, version: 2 }),
      },
    });
    await screen.findByText('iPhone ครัว');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.devices.revoke', { name: 'iPhone ครัว' }) }),
    );
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(tr('settings.devices.revokeBody', { name: 'iPhone ครัว' })),
    ).toBeTruthy();
    expect(env.adminApi.revokeDevice).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.devices.revokeConfirm') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.adminApi.revokeDevice).toHaveBeenCalledTimes(1);
    expect(env.adminApi.revokeDevice).toHaveBeenCalledWith(OTHER_DEVICE);
    expect(await screen.findByText(tr('settings.devices.removed'))).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: tr('settings.devices.revoke', { name: 'iPhone ครัว' }) }),
    ).toBeNull();
  });

  test('closing the question changes nothing', async () => {
    const env = await open('devices', { adminApi: devices() });
    await screen.findByText('iPhone ครัว');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.devices.revoke', { name: 'iPhone ครัว' }) }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: th['common.cancel'] }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(env.adminApi.revokeDevice).not.toHaveBeenCalled();
  });

  test('without a fresh step-up the list is not shown until the owner confirms; closing the question leaves a way to ask again', async () => {
    const env = await open('devices', { adminApi: devices(), freshStepUp: false });
    expect(await screen.findByText(th['auth.stepUp.title'])).toBeTruthy();
    expect(env.adminApi.devices).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: th['common.cancel'] }),
    );
    expect(await screen.findByText(tr('settings.admin.locked'))).toBeTruthy();
    expect(screen.queryByText('iPad เคาน์เตอร์')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: tr('settings.admin.unlock') }));
    expect(await screen.findByText(th['auth.stepUp.title'])).toBeTruthy();
  });

  test('a manager cannot open it', async () => {
    const env = await open('devices', { role: 'manager', adminApi: devices() });
    expect(await screen.findByText(tr('settings.notFound'))).toBeTruthy();
    expect(env.adminApi.devices).not.toHaveBeenCalled();
  });

  test('offline: says so and asks nothing', async () => {
    const env = await open('devices', { adminApi: devices(), offline: true });
    expect(await screen.findByText(tr('settings.offline'))).toBeTruthy();
    expect(env.adminApi.devices).not.toHaveBeenCalled();
  });

  test('a failed read offers a retry', async () => {
    let fail = true;
    await open('devices', {
      adminApi: {
        devices: async () => {
          if (fail) throw new ApiClientError('NETWORK');
          return { devices: [device(IDS.device, 'iPad เคาน์เตอร์')] };
        },
      },
    });
    expect(await screen.findByText(tr('settings.admin.loadFailed'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: tr('common.retry') }));
    expect(await screen.findByText('iPad เคาน์เตอร์')).toBeTruthy();
  });
});

const staffList = (): Partial<ApiClient['admin']> => ({
  staff: async () => ({
    staff: [
      person(0, {
        id: IDS.owner,
        displayName: 'เจ้าของร้าน',
        role: 'owner',
        email: 'owner@example.test',
      }),
      person(1),
      person(2, { role: 'kitchen', active: false }),
      person(3, { pinLockedUntil: new Date(Date.now() + 5 * 60_000).toISOString() }),
    ],
  }),
});

const fill = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

describe('staff', () => {
  test('lists people with their role and state; your own row has no actions', async () => {
    await open('staff', { adminApi: staffList() });
    expect(await screen.findByText('พนักงาน 1')).toBeTruthy();
    expect(screen.getByText(tr('settings.staff.selfNote'))).toBeTruthy();
    expect(screen.getByText('owner@example.test')).toBeTruthy();
    expect(screen.getAllByText(tr('settings.staff.noEmail')).length).toBeGreaterThan(0);
    expect(screen.getByText(tr('settings.staff.you'))).toBeTruthy();
    // The role change is there but disabled for yourself.
    const own = screen.getAllByRole('button', { name: tr('settings.staff.changeRole') });
    expect((own[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(tr('settings.staff.inactive'))).toBeTruthy();
    expect(screen.getByText(tr('settings.staff.locked'))).toBeTruthy();
    for (const label of ['rename', 'setPin', 'deactivate'] as const) {
      expect(
        screen.queryByRole('button', {
          name: tr(`settings.staff.${label}`, { name: 'เจ้าของร้าน' }),
        }),
      ).toBeNull();
    }
    expect(
      screen.getByRole('button', { name: tr('settings.staff.activate', { name: 'พนักงาน 2' }) }),
    ).toBeTruthy();
  });

  test('adding someone: a short PIN and two different PINs are refused on the screen', async () => {
    const env = await open('staff', { adminApi: staffList() });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.add') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.name'), 'น้องใหม่');
    fill(dialog, tr('settings.staff.pin'), '12');
    fill(dialog, tr('settings.staff.pin2'), '12');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.error.pin'))).toBeTruthy();
    fill(dialog, tr('settings.staff.pin'), '1234');
    fill(dialog, tr('settings.staff.pin2'), '1235');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.error.pin2'))).toBeTruthy();
    expect(env.adminApi.createStaff).not.toHaveBeenCalled();
  });

  test('a manager needs all 6 digits', async () => {
    const env = await open('staff', { adminApi: staffList() });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.add') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.name'), 'ผู้จัดการใหม่');
    fireEvent.click(within(dialog).getByLabelText(th['role.manager']));
    fill(dialog, tr('settings.staff.pin'), '1234');
    fill(dialog, tr('settings.staff.pin2'), '1234');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.error.pin'))).toBeTruthy();
    expect(env.adminApi.createStaff).not.toHaveBeenCalled();
  });

  test('a good form is sent once, exactly, and the person appears; the PIN is not left on the page', async () => {
    const env = await open('staff', {
      adminApi: {
        ...staffList(),
        createStaff: async () => person(9, { displayName: 'น้องใหม่' }),
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.add') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.name'), ' น้องใหม่ ');
    fill(dialog, tr('settings.staff.pin'), '4321');
    fill(dialog, tr('settings.staff.pin2'), '4321');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.adminApi.createStaff).toHaveBeenCalledTimes(1);
    expect(env.adminApi.createStaff).toHaveBeenCalledWith({
      displayName: 'น้องใหม่',
      role: 'cashier',
      pin: '4321',
    });
    expect(await screen.findByText('น้องใหม่')).toBeTruthy();
    expect(screen.getByText(tr('settings.staff.added'))).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('4321');
  });

  test('a lost answer is explained inside the dialog and nothing is sent again by itself', async () => {
    let creates = 0;
    const env = await open('staff', {
      adminApi: {
        ...staffList(),
        createStaff: async () => {
          creates += 1;
          throw new ApiClientError('TIMEOUT');
        },
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.add') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.name'), 'น้องใหม่');
    fill(dialog, tr('settings.staff.pin'), '4321');
    fill(dialog, tr('settings.staff.pin2'), '4321');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    // The dialog closes (the typed PIN goes with it) and the page says to look at the list first.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(tr('settings.admin.uncertain'))).toBeTruthy();
    expect(creates).toBe(1);
    expect(document.body.innerHTML).not.toContain('4321');
    // The list was read again so the person can see whether it happened.
    expect(env.adminApi.staff).toHaveBeenCalledTimes(2);
    // Saving again is not possible with what was typed: the next dialog is empty and sends nothing.
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.add') }));
    const again = screen.getByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: th['common.save'] }));
    expect(creates).toBe(1);
  });

  test('deactivating asks first, then sends the version the row had', async () => {
    const env = await open('staff', {
      adminApi: {
        ...staffList(),
        patchStaff: async (id) => person(1, { id, active: false, version: 2 }),
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.staff.deactivate', { name: 'พนักงาน 1' }) }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(tr('settings.staff.deactivateBody'))).toBeTruthy();
    expect(env.adminApi.patchStaff).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.deactivateConfirm') }),
    );
    await waitFor(() => expect(env.adminApi.patchStaff).toHaveBeenCalledTimes(1));
    expect(env.adminApi.patchStaff).toHaveBeenCalledWith(person(1).id, {
      expectedVersion: 1,
      active: false,
    });
    expect(
      await screen.findByRole('button', {
        name: tr('settings.staff.activate', { name: 'พนักงาน 1' }),
      }),
    ).toBeTruthy();
  });

  test('switching someone back on needs no question', async () => {
    const env = await open('staff', {
      adminApi: {
        ...staffList(),
        patchStaff: async (id) => person(2, { id, active: true, version: 2 }),
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.staff.activate', { name: 'พนักงาน 2' }) }),
    );
    await waitFor(() => expect(env.adminApi.patchStaff).toHaveBeenCalledTimes(1));
    expect(env.adminApi.patchStaff).toHaveBeenCalledWith(person(2).id, {
      expectedVersion: 1,
      active: true,
    });
  });

  test('renaming sends only the name', async () => {
    const env = await open('staff', {
      adminApi: {
        ...staffList(),
        patchStaff: async (id) => person(1, { id, displayName: 'ชื่อใหม่', version: 2 }),
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.staff.rename', { name: 'พนักงาน 1' }) }),
    );
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.name'), 'ชื่อใหม่');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(env.adminApi.patchStaff).toHaveBeenCalledTimes(1));
    expect(env.adminApi.patchStaff).toHaveBeenCalledWith(person(1).id, {
      expectedVersion: 1,
      displayName: 'ชื่อใหม่',
    });
    expect(await screen.findByText('ชื่อใหม่')).toBeTruthy();
  });

  test('a new PIN follows the person’s role, is typed twice, and is not left on the page', async () => {
    const env = await open('staff', {
      adminApi: {
        staff: async () => ({
          staff: [person(5, { displayName: 'ผู้จัดการ 5', role: 'manager' })],
        }),
        setStaffPin: async (id) => person(5, { id, role: 'manager' }),
      },
    });
    await screen.findByText('ผู้จัดการ 5');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.staff.setPin', { name: 'ผู้จัดการ 5' }) }),
    );
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.pin'), '1234');
    fill(dialog, tr('settings.staff.pin2'), '1234');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.error.pin'))).toBeTruthy();
    fill(dialog, tr('settings.staff.pin'), '654321');
    fill(dialog, tr('settings.staff.pin2'), '654321');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(env.adminApi.setStaffPin).toHaveBeenCalledTimes(1));
    expect(env.adminApi.setStaffPin).toHaveBeenCalledWith(person(5).id, { pin: '654321' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain('654321');
  });

  test('a change another device made first is read again and the person is told', async () => {
    let reads = 0;
    await open('staff', {
      adminApi: {
        staff: async () => {
          reads += 1;
          return { staff: [person(1, { displayName: reads === 1 ? 'พนักงาน 1' : 'ชื่อจากเครื่องอื่น' })] };
        },
        patchStaff: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 3 });
        },
      },
    });
    await screen.findByText('พนักงาน 1');
    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.staff.deactivate', { name: 'พนักงาน 1' }) }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: tr('settings.staff.deactivateConfirm'),
      }),
    );
    expect(await screen.findByText(new RegExp(tr('settings.refreshed')))).toBeTruthy();
    expect(await screen.findByText('ชื่อจากเครื่องอื่น')).toBeTruthy();
  });

  test('a manager cannot open it, and offline asks nothing', async () => {
    const manager = await open('staff', { role: 'manager', adminApi: staffList() });
    expect(await screen.findByText(tr('settings.notFound'))).toBeTruthy();
    expect(manager.adminApi.staff).not.toHaveBeenCalled();
    cleanup();
    const off = await open('staff', { adminApi: staffList(), offline: true });
    expect(await screen.findByText(tr('settings.offline'))).toBeTruthy();
    expect(off.adminApi.staff).not.toHaveBeenCalled();
  });
});

describe('invites and roles (D-23)', () => {
  const CO_OWNER = person(7, {
    displayName: 'เจ้าของร่วม',
    role: 'owner',
    email: 'co@example.test',
  });
  const SELF = person(0, {
    id: IDS.owner,
    displayName: 'เจ้าของร้าน',
    role: 'owner',
    email: 'owner@example.test',
  });
  const people = (...rest: StaffDto[]): Partial<ApiClient['admin']> => ({
    staff: async () => ({ staff: [SELF, ...rest] }),
  });
  const invite = (over: Partial<InviteDto> = {}): InviteDto => ({
    id: '0192f3a0-0000-7000-8000-000000000501',
    email: 'new@example.test',
    role: 'cashier',
    displayName: null,
    createdAt: NOW,
    expiresAt: '2026-10-06T03:00:00.000Z',
    status: 'open',
    ...over,
  });
  const TOKEN = 'tok_MADEUP_invite_token_0001';

  test('another owner can be renamed, changed and deactivated; the role of every person shows', async () => {
    await open('staff', { adminApi: people(CO_OWNER) });
    expect(await screen.findByText('เจ้าของร่วม')).toBeTruthy();
    expect(screen.getByText('co@example.test')).toBeTruthy();
    for (const label of ['rename', 'setPin', 'deactivate'] as const) {
      expect(
        screen.getByRole('button', { name: tr(`settings.staff.${label}`, { name: 'เจ้าของร่วม' }) }),
      ).toBeTruthy();
    }
    expect(
      screen.getByRole('button', {
        name: tr('settings.staff.changeRoleLabel', { name: 'เจ้าของร่วม' }),
      }),
    ).toBeTruthy();
  });

  test('inviting: the link is shown once with the token in the fragment, and is not kept after closing', async () => {
    const env = await open('staff', {
      adminApi: {
        ...people(),
        createInvite: async (input) => ({
          ...invite({ email: input.email, role: input.role }),
          token: TOKEN,
        }),
      },
    });
    await screen.findByText('owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.invite') }));
    const dialog = screen.getByRole('dialog');
    // A bad e-mail is refused on the screen.
    fill(dialog, tr('settings.staff.inviteEmail'), 'not-an-email');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    expect(within(dialog).getByText(tr('settings.staff.error.email'))).toBeTruthy();
    expect(env.adminApi.createInvite).not.toHaveBeenCalled();
    // The owner role carries a clear warning; a plain role explains itself.
    expect(within(dialog).getByText(tr('settings.staff.roleDesc.cashier'))).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(tr('role.owner')));
    expect(within(dialog).getByText(tr('settings.staff.ownerWarn'))).toBeTruthy();
    expect(within(dialog).getByText(tr('settings.staff.roleDesc.owner'))).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(tr('role.manager')));
    fill(dialog, tr('settings.staff.inviteEmail'), ' New@Example.test ');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    await waitFor(() => expect(env.adminApi.createInvite).toHaveBeenCalledTimes(1));
    expect(env.adminApi.createInvite).toHaveBeenCalledWith({
      email: 'new@example.test',
      role: 'manager',
    });
    const link = `${window.location.origin}/invite#${TOKEN}`;
    // The whole link is on the page as text (wrapped, selectable), named by its label.
    const shown = await within(screen.getByRole('dialog')).findByTestId('invite-link');
    expect(shown.textContent).toBe(link);
    expect(screen.getByRole('group', { name: tr('settings.staff.linkLabel') })).toBeTruthy();
    expect(screen.getByText(tr('settings.staff.linkNote'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.linkCopy') }));
    await waitFor(() => expect(env.clipboard.copyText).toHaveBeenCalledWith(link));
    expect(await screen.findByText(tr('settings.staff.linkCopied'))).toBeTruthy();
    // Closing drops the link for good: the list shows the invite, never the token.
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.linkDone') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(screen.getByText('new@example.test')).toBeTruthy();
  });

  test('a refused copy says so and leaves the link to select by hand', async () => {
    const env = await open('staff', {
      adminApi: {
        ...people(),
        createInvite: async (input) => ({ ...invite({ email: input.email }), token: TOKEN }),
      },
    });
    env.clipboard.copyText.mockResolvedValue(false);
    await screen.findByText('owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.invite') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.inviteEmail'), 'new@example.test');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: tr('settings.staff.linkCopy') }));
    expect(await screen.findByText(tr('settings.staff.linkCopyFailed'))).toBeTruthy();
  });

  test('an e-mail that has an account or an open invite is explained in the dialog', async () => {
    let code = 'EMAIL_TAKEN';
    await open('staff', {
      adminApi: {
        ...people(),
        createInvite: async () => {
          throw new ApiClientError(code, { status: 409 });
        },
      },
    });
    await screen.findByText('owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.invite') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.inviteEmail'), 'taken@example.test');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    expect(await within(dialog).findByText(tr('error.emailTaken'))).toBeTruthy();
    code = 'INVITE_EXISTS';
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    expect(await within(dialog).findByText(tr('error.inviteExists'))).toBeTruthy();
  });

  test('a lost answer to an invite closes the dialog and points at the invites list, read again', async () => {
    let reads = 0;
    const env = await open('staff', {
      adminApi: {
        ...people(),
        invites: async () => {
          reads += 1;
          return { invites: reads === 1 ? [] : [invite()] };
        },
        createInvite: async () => {
          throw new ApiClientError('TIMEOUT');
        },
      },
    });
    await screen.findByText('owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.staff.invite') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog, tr('settings.staff.inviteEmail'), 'new@example.test');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.inviteCreate') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(tr('settings.staff.inviteUncertain'))).toBeTruthy();
    expect(env.adminApi.createInvite).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('new@example.test')).toBeTruthy();
  });

  test('open invites show their expiry; an expired one says so; cancelling asks first', async () => {
    const env = await open('staff', {
      adminApi: {
        ...people(),
        invites: async () => ({
          invites: [
            invite(),
            invite({
              id: '0192f3a0-0000-7000-8000-000000000502',
              email: 'old@example.test',
              status: 'expired',
              expiresAt: '2026-10-01T03:00:00.000Z',
            }),
          ],
        }),
        revokeInvite: async () => undefined,
      },
    });
    expect(await screen.findByText('new@example.test')).toBeTruthy();
    expect(screen.getByText(tr('settings.staff.invites.expiredBadge'))).toBeTruthy();
    const open1 = formatDate('2026-10-06T03:00:00.000Z', 'th', 'dateTime');
    expect(screen.getByText(tr('settings.staff.invites.expires', { when: open1 }))).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.staff.invites.revokeLabel', { email: 'new@example.test' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(env.adminApi.revokeInvite).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.staff.invites.revoke') }),
    );
    await waitFor(() => expect(env.adminApi.revokeInvite).toHaveBeenCalledTimes(1));
    expect(env.adminApi.revokeInvite).toHaveBeenCalledWith('0192f3a0-0000-7000-8000-000000000501');
    await waitFor(() => expect(screen.queryByText('new@example.test')).toBeNull());
    expect(screen.getByText(tr('settings.staff.invites.revoked'))).toBeTruthy();
  });

  test('a role change that needs a longer PIN asks for one; one that does not, does not', async () => {
    const cashier = person(5, { displayName: 'แคชเชียร์ 5', email: 'c5@example.test' });
    const env = await open('staff', {
      adminApi: {
        ...people(cashier),
        changeStaffRole: async (id, input) =>
          person(5, { id, role: input.role, version: 2, displayName: 'แคชเชียร์ 5' }),
      },
    });
    await screen.findByText('แคชเชียร์ 5');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.staff.changeRoleLabel', { name: 'แคชเชียร์ 5' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    // Same role: nothing is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.changeRoleSame'))).toBeTruthy();
    // Kitchen keeps a 4-digit PIN: no PIN field.
    fireEvent.click(within(dialog).getByLabelText(tr('role.kitchen')));
    expect(within(dialog).queryByLabelText(tr('settings.staff.changeRolePin'))).toBeNull();
    // Manager needs 6 digits: the field appears and a short PIN is refused.
    fireEvent.click(within(dialog).getByLabelText(tr('role.manager')));
    fill(dialog, tr('settings.staff.changeRolePin'), '1234');
    fill(dialog, tr('settings.staff.pin2'), '1234');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(within(dialog).getByText(tr('settings.staff.error.pin'))).toBeTruthy();
    expect(env.adminApi.changeStaffRole).not.toHaveBeenCalled();
    fill(dialog, tr('settings.staff.changeRolePin'), '654321');
    fill(dialog, tr('settings.staff.pin2'), '654321');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(env.adminApi.changeStaffRole).toHaveBeenCalledTimes(1));
    expect(env.adminApi.changeStaffRole).toHaveBeenCalledWith(cashier.id, {
      expectedVersion: 1,
      role: 'manager',
      pin: '654321',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(tr('settings.staff.changeRoleDone'))).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('654321');
  });

  test('a person with no PIN needs one for any role but owner; a PIN-only person cannot become an owner', async () => {
    const noPin = person(6, { displayName: 'ไม่มี PIN', hasPin: false, email: null });
    const env = await open('staff', {
      adminApi: {
        ...people(noPin),
        changeStaffRole: async (id, input) => person(6, { id, role: input.role, version: 2 }),
      },
    });
    await screen.findByText('ไม่มี PIN');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.staff.changeRoleLabel', { name: 'ไม่มี PIN' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(tr('role.owner')) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(within(dialog).getByText(tr('settings.staff.changeRoleNoAccount'))).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(tr('role.kitchen')));
    // No PIN yet: even a role with a 4-digit PIN asks for one.
    expect(within(dialog).getByLabelText(tr('settings.staff.changeRolePin'))).toBeTruthy();
    fill(dialog, tr('settings.staff.changeRolePin'), '4321');
    fill(dialog, tr('settings.staff.pin2'), '4321');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(env.adminApi.changeStaffRole).toHaveBeenCalledTimes(1));
    expect(env.adminApi.changeStaffRole).toHaveBeenCalledWith(noPin.id, {
      expectedVersion: 1,
      role: 'kitchen',
      pin: '4321',
    });
  });

  test.each([
    ['LAST_OWNER', 'error.lastOwner'],
    ['SELF_CHANGE', 'error.selfChange'],
    ['OWNER_NEEDS_ACCOUNT', 'error.ownerNeedsAccount'],
  ] as const)('a refused role change (%s) is explained in the dialog', async (code, key) => {
    const cashier = person(5, { displayName: 'แคชเชียร์ 5', email: 'c5@example.test' });
    await open('staff', {
      adminApi: {
        ...people(cashier),
        changeStaffRole: async () => {
          throw new ApiClientError(code, { status: 409 });
        },
      },
    });
    await screen.findByText('แคชเชียร์ 5');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.staff.changeRoleLabel', { name: 'แคชเชียร์ 5' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(tr('role.kitchen')));
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(await within(dialog).findByText(tr(key))).toBeTruthy();
  });

  test('a change another device made first is read again and the person is told', async () => {
    let reads = 0;
    const cashier = (name: string) => person(5, { displayName: name, email: 'c5@example.test' });
    await open('staff', {
      adminApi: {
        staff: async () => {
          reads += 1;
          return { staff: [SELF, cashier(reads === 1 ? 'แคชเชียร์ 5' : 'ชื่อจากเครื่องอื่น')] };
        },
        changeStaffRole: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 3 });
        },
      },
    });
    await screen.findByText('แคชเชียร์ 5');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.staff.changeRoleLabel', { name: 'แคชเชียร์ 5' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(tr('role.kitchen')));
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(await within(dialog).findByText(new RegExp(tr('settings.refreshed')))).toBeTruthy();
    expect(await screen.findByText('ชื่อจากเครื่องอื่น')).toBeTruthy();
  });
});
