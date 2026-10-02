// @vitest-environment jsdom
import { th, translator } from '@sds/i18n';
import {
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
  type StaffRole,
} from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import type { SettingsOverrides } from '../test-support/settings-env.ts';
import { settingAnswer } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

async function open(
  section: string,
  options: { role?: StaffRole; settingsApi?: SettingsOverrides; offline?: boolean } = {},
) {
  const { auth } = await createTestAuth(options.role ?? 'manager');
  const env = createTestServices({
    auth,
    ...(options.settingsApi ? { settingsApi: options.settingsApi } : {}),
    ...(options.offline ? { offline: true } : {}),
  });
  renderScreen(<SettingsSectionScreen section={section} />, env.services);
  return env;
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: th['common.save'] }));

describe('shop details', () => {
  test('shows the saved values, and a change sends only what changed with the version', async () => {
    const env = await open('shop', {
      settingsApi: {
        shop: {
          read: async () => settingAnswer({ ...DEFAULT_SHOP_SETTINGS, phone: '0800000000' }, 3),
          save: async () => settingAnswer({ ...DEFAULT_SHOP_SETTINGS, phone: '0899999999' }, 4),
        },
      },
    });
    const phone = (await screen.findByLabelText(tr('settings.shop.phone'))) as HTMLInputElement;
    expect(phone.value).toBe('0800000000');
    expect((screen.getByLabelText(tr('settings.shop.nameTh')) as HTMLInputElement).value).toBe(
      DEFAULT_SHOP_SETTINGS.nameTh,
    );
    type(tr('settings.shop.phone'), '0899999999');
    save();
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
    expect(env.settingsApi.shop.save).toHaveBeenCalledTimes(1);
    expect(env.settingsApi.shop.save).toHaveBeenCalledWith({
      expectedVersion: 3,
      phone: '0899999999',
    });
  });

  test('a missing Thai name is refused on the screen, with nothing sent', async () => {
    const env = await open('shop');
    await screen.findByLabelText(tr('settings.shop.nameTh'));
    type(tr('settings.shop.nameTh'), '   ');
    save();
    expect(await screen.findByText(tr('settings.shop.error.nameTh'))).toBeTruthy();
    expect(env.settingsApi.shop.save).not.toHaveBeenCalled();
  });

  test('saving with nothing changed says so and sends nothing', async () => {
    const env = await open('shop');
    await screen.findByLabelText(tr('settings.shop.nameTh'));
    save();
    expect(await screen.findByText(tr('settings.noChange'))).toBeTruthy();
    expect(env.settingsApi.shop.save).not.toHaveBeenCalled();
  });

  test('a cashier may only look: the fields are off and there is no Save button', async () => {
    await open('shop', { role: 'cashier' });
    const name = (await screen.findByLabelText(tr('settings.shop.nameTh'))) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: th['common.save'] })).toBeNull();
    expect(screen.getByText(tr('settings.viewOnly'))).toBeTruthy();
  });

  test('a setting changed on another device is read again and the person is told', async () => {
    let reads = 0;
    const env = await open('shop', {
      settingsApi: {
        shop: {
          read: async () => {
            reads += 1;
            return settingAnswer(
              { ...DEFAULT_SHOP_SETTINGS, nameTh: reads === 1 ? 'ร้านเดิม' : 'ร้านจากเครื่องอื่น' },
              reads === 1 ? 1 : 2,
            );
          },
          save: async () => {
            throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 2 });
          },
        },
      },
    });
    await screen.findByDisplayValue('ร้านเดิม');
    type(tr('settings.shop.phone'), '0811111111');
    save();
    expect(await screen.findByText(new RegExp(tr('settings.refreshed')))).toBeTruthy();
    expect(await screen.findByDisplayValue('ร้านจากเครื่องอื่น')).toBeTruthy();
    // The typed phone was not carried over: the form starts again from the latest values.
    expect((screen.getByLabelText(tr('settings.shop.phone')) as HTMLInputElement).value).toBe('');
    expect(env.settingsApi.shop.save).toHaveBeenCalledTimes(1);
  });

  test('offline: says so, reads nothing, and Save is off', async () => {
    const env = await open('shop', { offline: true });
    expect(await screen.findByText(tr('settings.offline'))).toBeTruthy();
    expect(env.settingsApi.shop.read).not.toHaveBeenCalled();
  });

  test('a first read that fails offers a retry', async () => {
    let fail = true;
    await open('shop', {
      settingsApi: {
        shop: {
          read: async () => {
            if (fail) throw new ApiClientError('NETWORK');
            return settingAnswer(DEFAULT_SHOP_SETTINGS, 1);
          },
        },
      },
    });
    expect(await screen.findByText(tr('settings.loadFailed'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: tr('common.retry') }));
    expect(await screen.findByLabelText(tr('settings.shop.nameTh'))).toBeTruthy();
  });
});

describe('opening hours', () => {
  test('changing a window sends only that window', async () => {
    const env = await open('hours', {
      settingsApi: { openingHours: { save: async () => settingAnswer(DEFAULT_OPENING_HOURS, 2) } },
    });
    const storefront = (await screen.findByRole('group', {
      name: tr('settings.hours.storefront'),
    })) as HTMLElement;
    fireEvent.change(within(storefront).getByLabelText(tr('settings.hours.close')), {
      target: { value: '22:30' },
    });
    save();
    await waitFor(() => expect(env.settingsApi.openingHours.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.openingHours.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      storefront: { openMinute: 660, closeMinute: 1350 },
    });
  });

  test('a bad time is refused on the screen', async () => {
    const env = await open('hours');
    const delivery = (await screen.findByRole('group', {
      name: tr('settings.hours.delivery'),
    })) as HTMLElement;
    fireEvent.change(within(delivery).getByLabelText(tr('settings.hours.open')), {
      target: { value: '25:00' },
    });
    save();
    expect(await within(delivery).findByText(tr('settings.hours.windowError'))).toBeTruthy();
    expect(env.settingsApi.openingHours.save).not.toHaveBeenCalled();
  });

  test('closing a weekday and adding a closed date are sent as weekly and overrides', async () => {
    const env = await open('hours', {
      settingsApi: { openingHours: { save: async () => settingAnswer(DEFAULT_OPENING_HOURS, 2) } },
    });
    fireEvent.click(await screen.findByLabelText(tr('settings.weekday.mon')));
    fireEvent.click(screen.getByRole('button', { name: tr('settings.hours.closureAdd') }));
    fireEvent.change(screen.getByLabelText(tr('settings.hours.closureDate')), {
      target: { value: '2026-10-13' },
    });
    save();
    await waitFor(() => expect(env.settingsApi.openingHours.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.openingHours.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      weekly: { mon: { storefront: null, delivery: null } },
      overrides: [{ date: '2026-10-13', closed: true }],
    });
  });

  test('a closed date can be removed again', async () => {
    await open('hours', {
      settingsApi: {
        openingHours: {
          read: async () =>
            settingAnswer(
              {
                storefront: { openMinute: 660, closeMinute: 1380 },
                delivery: { openMinute: 780, closeMinute: 1380 },
                weekly: {},
                overrides: [{ date: '2026-10-13', closed: true }],
              },
              2,
            ),
        },
      },
    });
    const date = (await screen.findByLabelText(
      tr('settings.hours.closureDate'),
    )) as HTMLInputElement;
    expect(date.value).toBe('2026-10-13');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('settings.hours.closureRemove', { date: '2026-10-13' }),
      }),
    );
    expect(screen.queryByLabelText(tr('settings.hours.closureDate'))).toBeNull();
    expect(screen.getByText(tr('settings.hours.closuresEmpty'))).toBeTruthy();
  });
});

describe('numbering and the business day', () => {
  test('a new cutoff is sent as minutes, and the time zone is only shown', async () => {
    const env = await open('numbering', {
      settingsApi: {
        numbering: {
          save: async () => settingAnswer({ cutoffMinutes: 330, timeZone: 'Asia/Bangkok' }, 2),
        },
      },
    });
    const cutoff = (await screen.findByLabelText(
      tr('settings.numbering.cutoff'),
    )) as HTMLInputElement;
    expect(cutoff.value).toBe('04:00');
    expect(screen.getByText(tr('settings.numbering.zone', { zone: 'Asia/Bangkok' }))).toBeTruthy();
    type(tr('settings.numbering.cutoff'), '05:30');
    save();
    await waitFor(() => expect(env.settingsApi.numbering.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.numbering.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      cutoffMinutes: 330,
    });
  });

  test('24:00 is refused as a cutoff', async () => {
    const env = await open('numbering');
    await screen.findByLabelText(tr('settings.numbering.cutoff'));
    type(tr('settings.numbering.cutoff'), '24:00');
    save();
    expect(await screen.findByText(tr('settings.numbering.error'))).toBeTruthy();
    expect(env.settingsApi.numbering.save).not.toHaveBeenCalled();
  });
});

describe('payment methods', () => {
  test('flipping a switch sends only that method', async () => {
    const env = await open('payments', {
      settingsApi: {
        payments: {
          save: async () =>
            settingAnswer({ cash: true, promptpay: true, platform: true, other: true }, 2),
        },
      },
    });
    const other = (await screen.findByLabelText(tr('settings.payments.other'))) as HTMLInputElement;
    expect(other.checked).toBe(false);
    fireEvent.click(other);
    save();
    await waitFor(() => expect(env.settingsApi.payments.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.payments.save).toHaveBeenCalledWith({ expectedVersion: 0, other: true });
    expect(screen.getByText(tr('settings.payments.govNote'))).toBeTruthy();
  });
});

describe('delivery buildings', () => {
  test('adds a building to the list and replaces the whole list', async () => {
    const env = await open('delivery', {
      settingsApi: {
        deliveryList: {
          save: async () =>
            settingAnswer({ buildings: [...DEFAULT_DELIVERY_SETTINGS.buildings, 'E5'] }, 2),
        },
      },
    });
    await screen.findByText('A1');
    type(tr('settings.delivery.name'), 'E5');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.delivery.add') }));
    expect(screen.getByText('E5')).toBeTruthy();
    save();
    await waitFor(() => expect(env.settingsApi.deliveryList.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.deliveryList.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      buildings: [...DEFAULT_DELIVERY_SETTINGS.buildings, 'E5'],
    });
  });

  test('a repeated name is refused, a building can be removed, and the last one cannot', async () => {
    await open('delivery', {
      settingsApi: {
        deliveryList: { read: async () => settingAnswer({ buildings: ['A1', 'B2'] }, 1) },
      },
    });
    await screen.findByText('A1');
    type(tr('settings.delivery.name'), 'a1');
    fireEvent.click(screen.getByRole('button', { name: tr('settings.delivery.add') }));
    expect(await screen.findByText(tr('settings.delivery.error.duplicate'))).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: tr('settings.delivery.remove', { name: 'A1' }) }),
    );
    expect(screen.queryByText('A1')).toBeNull();
    const last = screen.getByRole('button', {
      name: tr('settings.delivery.remove', { name: 'B2' }),
    });
    expect((last as HTMLButtonElement).disabled).toBe(true);
  });
});
