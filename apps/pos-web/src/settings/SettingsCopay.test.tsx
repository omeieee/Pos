// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import { type GovCopayDto, type StaffRole, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import type { SettingsOverrides } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

const scheme = (over: Partial<GovCopayDto> = {}): GovCopayDto => ({
  id: '0192f3a0-0000-7000-8000-000000000077',
  code: 'thai_chuay_thai_plus_2',
  nameTh: 'ไทยช่วยไทย พลัส',
  nameEn: null,
  settlementNote: null,
  version: 3,
  rev: 30,
  govShareBp: 6000,
  govDailyCapSatang: satang(20000),
  govTotalCapSatang: null,
  activeFrom: '2030-10-01',
  activeTo: '2030-11-30',
  activeFromMinute: 360,
  activeToMinute: 1380,
  channels: ['storefront'],
  enabled: false,
  ...over,
});

async function open(options: { role?: StaffRole; settingsApi?: SettingsOverrides } = {}) {
  const { auth } = await createTestAuth(options.role ?? 'owner');
  await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  const env = createTestServices({
    auth,
    ...(options.settingsApi ? { settingsApi: options.settingsApi } : {}),
  });
  renderScreen(<SettingsSectionScreen section="gov-copay" />, env.services);
  return env;
}

const existing = (over: Partial<GovCopayDto> = {}): SettingsOverrides => ({
  govCopay: { read: async () => ({ scheme: scheme(over) }) },
});
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));

describe('what the page always says', () => {
  test('the face-to-face rules, the unconfirmed-terms risk, and the channels it is set for, read only', async () => {
    await open({ settingsApi: existing() });
    await screen.findByLabelText(tr('settings.copay.nameTh'));
    expect(screen.getByText(tr('settings.copay.rules'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.risk'))).toBeTruthy();
    expect(
      screen.getByText(
        tr('settings.copay.channels', { channels: tr('orders.channel.storefront') }),
      ),
    ).toBeTruthy();
    // The only switch on the page is "switched on": no channel can be added here.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});

describe('an existing scheme', () => {
  test('shows its values as the owner would type them', async () => {
    await open({ settingsApi: existing() });
    const value = async (label: string) =>
      ((await screen.findByLabelText(label)) as HTMLInputElement).value;
    expect(await value(tr('settings.copay.share'))).toBe('60');
    expect(await value(tr('settings.copay.dailyCap'))).toBe('200');
    expect(await value(tr('settings.copay.totalCap'))).toBe('');
    expect(await value(tr('settings.copay.from'))).toBe('2030-10-01');
    expect(await value(tr('settings.copay.fromTime'))).toBe('06:00');
    expect(await value(tr('settings.copay.toTime'))).toBe('23:00');
    expect(
      ((await screen.findByLabelText(tr('settings.copay.enabled'))) as HTMLInputElement).checked,
    ).toBe(false);
  });

  test('switching it on sends the switch alone, with the version', async () => {
    const env = await open({
      settingsApi: {
        govCopay: {
          read: async () => ({ scheme: scheme() }),
          save: async () => ({ scheme: scheme({ enabled: true, version: 4 }) }),
        },
      },
    });
    fireEvent.click(await screen.findByLabelText(tr('settings.copay.enabled')));
    save();
    await waitFor(() => expect(env.settingsApi.govCopay.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.govCopay.save).toHaveBeenCalledWith({
      expectedVersion: 3,
      enabled: true,
    });
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
  });

  test('a changed share and hour are sent as basis points and minutes', async () => {
    const env = await open({
      settingsApi: {
        govCopay: {
          read: async () => ({ scheme: scheme() }),
          save: async () => ({ scheme: scheme({ version: 4 }) }),
        },
      },
    });
    await screen.findByLabelText(tr('settings.copay.share'));
    type(tr('settings.copay.share'), '55.5');
    type(tr('settings.copay.toTime'), '24:00');
    save();
    await waitFor(() => expect(env.settingsApi.govCopay.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.govCopay.save).toHaveBeenCalledWith({
      expectedVersion: 3,
      govShareBp: 5550,
      activeToMinute: 1440,
    });
  });

  test('a bad share, an end date before the start, or an end time before the start is refused on the screen', async () => {
    const env = await open({ settingsApi: existing() });
    await screen.findByLabelText(tr('settings.copay.share'));
    type(tr('settings.copay.share'), '101');
    type(tr('settings.copay.to'), '2030-09-01');
    type(tr('settings.copay.toTime'), '05:00');
    save();
    expect(await screen.findByText(tr('settings.copay.error.share'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.error.activeTo'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.error.toTime'))).toBeTruthy();
    expect(env.settingsApi.govCopay.save).not.toHaveBeenCalled();
  });

  test('a refusal from the server (it checks the scheme again) is shown in plain words', async () => {
    await open({
      settingsApi: {
        govCopay: {
          read: async () => ({ scheme: scheme() }),
          save: async () => {
            throw new ApiClientError('VALIDATION_ERROR', { status: 400 });
          },
        },
      },
    });
    fireEvent.click(await screen.findByLabelText(tr('settings.copay.enabled')));
    save();
    expect(await screen.findByText(tr('error.validation'))).toBeTruthy();
  });
});

describe('no scheme yet', () => {
  test('starts empty and OFF, and a first save carries the whole scheme for the storefront only', async () => {
    const env = await open({
      settingsApi: {
        govCopay: { save: async () => ({ scheme: scheme({ version: 1 }) }) },
      },
    });
    expect(await screen.findByText(tr('settings.copay.new'))).toBeTruthy();
    expect(
      ((await screen.findByLabelText(tr('settings.copay.enabled'))) as HTMLInputElement).checked,
    ).toBe(false);
    type(tr('settings.copay.nameTh'), 'ไทยช่วยไทย พลัส');
    type(tr('settings.copay.share'), '60');
    type(tr('settings.copay.dailyCap'), '200');
    type(tr('settings.copay.from'), '2030-10-01');
    type(tr('settings.copay.to'), '2030-11-30');
    type(tr('settings.copay.fromTime'), '06:00');
    type(tr('settings.copay.toTime'), '23:00');
    save();
    await waitFor(() => expect(env.settingsApi.govCopay.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.govCopay.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      nameTh: 'ไทยช่วยไทย พลัส',
      govShareBp: 6000,
      govDailyCapSatang: 20000,
      govTotalCapSatang: null,
      activeFrom: '2030-10-01',
      activeTo: '2030-11-30',
      activeFromMinute: 360,
      activeToMinute: 1380,
      channels: ['storefront'],
      enabled: false,
    });
  });

  test('a blank form is refused field by field, nothing sent', async () => {
    const env = await open();
    await screen.findByText(tr('settings.copay.new'));
    save();
    expect(await screen.findByText(tr('settings.copay.error.nameTh'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.error.share'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.error.activeFrom'))).toBeTruthy();
    expect(screen.getByText(tr('settings.copay.error.fromTime'))).toBeTruthy();
    expect(env.settingsApi.govCopay.save).not.toHaveBeenCalled();
  });
});

describe('who may change it', () => {
  test('a manager sees the scheme but every field is off and there is no Save', async () => {
    await open({ role: 'manager', settingsApi: existing() });
    const share = (await screen.findByLabelText(tr('settings.copay.share'))) as HTMLInputElement;
    expect(share.disabled).toBe(true);
    expect((screen.getByLabelText(tr('settings.copay.enabled')) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: tr('common.save') })).toBeNull();
    expect(screen.getByText(tr('settings.viewOnly'))).toBeTruthy();
  });
});
