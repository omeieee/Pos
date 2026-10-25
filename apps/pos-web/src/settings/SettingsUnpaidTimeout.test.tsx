// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

async function open(role: StaffRole, settingsApi?: SettingsOverrides) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({ auth, ...(settingsApi ? { settingsApi } : {}) });
  renderScreen(<SettingsSectionScreen section="unpaid-timeout" />, env.services);
  return env;
}

const minutes = async () =>
  (await screen.findByLabelText(tr('settings.unpaidTimeout.minutes'))) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));

describe('cancelling unpaid LINE orders', () => {
  test('is on at 60 minutes by default and says plainly that the customer is not messaged', async () => {
    await open('manager');
    expect((await minutes()).value).toBe('60');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(tr('settings.unpaidTimeout.stateOn', { minutes: 60 }))).toBeTruthy();
    expect(screen.getByText(tr('settings.unpaidTimeout.explainAuto'))).toBeTruthy();
    expect(screen.getByText(tr('settings.unpaidTimeout.explainClaimed'))).toBeTruthy();
  });

  test('a new number saves with the version the screen was built on', async () => {
    const env = await open('manager', {
      unpaidTimeout: {
        read: async () => settingAnswer({ enabled: true, minutes: 60 }, 4),
        save: async () => settingAnswer({ enabled: true, minutes: 90 }, 5),
      },
    });
    fireEvent.change(await minutes(), { target: { value: '90' } });
    save();
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
    expect(env.settingsApi.unpaidTimeout.save).toHaveBeenCalledWith({
      expectedVersion: 4,
      enabled: true,
      minutes: 90,
    });
  });

  test('turning it off saves enabled false', async () => {
    const env = await open('owner', {
      unpaidTimeout: {
        read: async () => settingAnswer({ enabled: true, minutes: 60 }, 1),
        save: async () => settingAnswer({ enabled: false, minutes: 60 }, 2),
      },
    });
    await minutes();
    fireEvent.click(screen.getByRole('checkbox'));
    save();
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
    expect(env.settingsApi.unpaidTimeout.save).toHaveBeenCalledWith({
      expectedVersion: 1,
      enabled: false,
      minutes: 60,
    });
    expect(await screen.findByText(tr('settings.unpaidTimeout.stateOff'))).toBeTruthy();
  });

  test('minutes outside 15 to 240 are refused on the screen and never sent', async () => {
    const env = await open('manager');
    for (const bad of ['14', '241', '', 'abc']) {
      fireEvent.change(await minutes(), { target: { value: bad } });
      save();
      expect(
        await screen.findByText(tr('settings.unpaidTimeout.error', { min: 15, max: 240 })),
      ).toBeTruthy();
    }
    expect(env.settingsApi.unpaidTimeout.save).not.toHaveBeenCalled();
  });

  test('saving with no change sends nothing', async () => {
    const env = await open('manager');
    await minutes();
    save();
    expect(await screen.findByText(tr('settings.noChange'))).toBeTruthy();
    expect(env.settingsApi.unpaidTimeout.save).not.toHaveBeenCalled();
  });

  test('a cashier cannot open the section', async () => {
    await open('cashier');
    expect(screen.getByText(tr('settings.notFound'))).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
