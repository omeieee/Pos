// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';
import { hubEntries } from './sections.ts';

afterEach(cleanup);
const tr = translator('th');

const NONE = { grabRateBp: null, linemanRateBp: null } as const;
const GRAB_ONLY = { grabRateBp: 2500, linemanRateBp: null } as const;

async function open(role: StaffRole = 'owner', settingsApi: SettingsOverrides = {}) {
  const { auth, stepUpOwner } = await createTestAuth(role);
  if (role === 'owner') {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({ auth, settingsApi });
  renderScreen(<SettingsSectionScreen section="platform-commission" />, env.services);
  return { ...env, stepUpOwner };
}

describe('the platform commission section', () => {
  test('only the owner can open it; a manager is told it is not found', async () => {
    expect(hubEntries(['settings.view', 'settings.edit']).map((e) => e.section.id)).not.toContain(
      'platform-commission',
    );
    await open('manager');
    expect(await screen.findByText(tr('settings.notFound'))).toBeTruthy();
  });

  test('a rate that was never set shows blank fields and says "rate not set"', async () => {
    await open('owner', { platformCommission: { read: async () => settingAnswer(NONE, 0) } });
    const grab = (await screen.findByLabelText(tr('settings.commission.grab'))) as HTMLInputElement;
    expect(grab.value).toBe('');
    expect(
      (screen.getByLabelText(tr('settings.commission.lineman')) as HTMLInputElement).value,
    ).toBe('');
    expect(screen.getAllByText(tr('settings.commission.notSet')).length).toBe(2);
  });

  test('a saved rate is shown as a percent, and the other stays "not set"', async () => {
    await open('owner', { platformCommission: { read: async () => settingAnswer(GRAB_ONLY, 2) } });
    const grab = (await screen.findByLabelText(tr('settings.commission.grab'))) as HTMLInputElement;
    expect(grab.value).toBe('25');
    expect(screen.getAllByText(tr('settings.commission.notSet')).length).toBe(1);
  });

  test('typing a percent saves basis points for that platform only, with the version', async () => {
    const env = await open('owner', {
      platformCommission: {
        read: async () => settingAnswer(GRAB_ONLY, 2),
        save: async () => settingAnswer({ grabRateBp: 2500, linemanRateBp: 2050 }, 3),
      },
    });
    fireEvent.change(await screen.findByLabelText(tr('settings.commission.lineman')), {
      target: { value: '20.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    await waitFor(() => expect(env.settingsApi.platformCommission.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.platformCommission.save).toHaveBeenCalledWith({
      expectedVersion: 2,
      linemanRateBp: 2050,
    });
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
  });

  test('clearing a rate sends null (back to "rate not set")', async () => {
    const env = await open('owner', {
      platformCommission: {
        read: async () => settingAnswer(GRAB_ONLY, 2),
        save: async () => settingAnswer(NONE, 3),
      },
    });
    fireEvent.change(await screen.findByLabelText(tr('settings.commission.grab')), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    await waitFor(() => expect(env.settingsApi.platformCommission.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.platformCommission.save).toHaveBeenCalledWith({
      expectedVersion: 2,
      grabRateBp: null,
    });
  });

  test('a value that is not a rate is refused before any save', async () => {
    const env = await open('owner', {
      platformCommission: { read: async () => settingAnswer(NONE, 0) },
    });
    fireEvent.change(await screen.findByLabelText(tr('settings.commission.grab')), {
      target: { value: '101' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.commission.error.rate'))).toBeTruthy();
    expect(env.settingsApi.platformCommission.save).not.toHaveBeenCalled();
  });

  test('saving without a change says so and sends nothing', async () => {
    const env = await open('owner', {
      platformCommission: { read: async () => settingAnswer(GRAB_ONLY, 2) },
    });
    await screen.findByLabelText(tr('settings.commission.grab'));
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.noChange'))).toBeTruthy();
    expect(env.settingsApi.platformCommission.save).not.toHaveBeenCalled();
  });

  test('the save asks for the owner step-up first: without one, it asks and nothing is sent', async () => {
    const { auth } = await createTestAuth('owner');
    const env = createTestServices({
      auth,
      settingsApi: {
        platformCommission: {
          read: async () => settingAnswer(NONE, 0),
          save: async () => settingAnswer(GRAB_ONLY, 1),
        },
      },
    });
    renderScreen(<SettingsSectionScreen section="platform-commission" />, env.services);
    fireEvent.change(await screen.findByLabelText(tr('settings.commission.grab')), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    // The step-up dialog opens; the save has not gone out.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(env.settingsApi.platformCommission.save).not.toHaveBeenCalled();
  });
});
