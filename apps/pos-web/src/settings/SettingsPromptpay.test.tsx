// @vitest-environment jsdom
import { th, translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import {
  apiError,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { paymentFrame, uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

// Made-up IDs only (never a real account).
const OLD_ID = '0800001234';
const NEW_ID = '0899990000';
const NEW_ID_TYPED = '089-999-0000';

async function open(
  options: {
    role?: StaffRole;
    settingsApi?: SettingsOverrides;
    freshStepUp?: boolean;
    waiting?: number;
  } = {},
) {
  const { auth, stepUpOwner } = await createTestAuth(options.role ?? 'owner');
  if (options.freshStepUp !== false) {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({
    auth,
    ...(options.settingsApi ? { settingsApi: options.settingsApi } : {}),
  });
  for (let i = 0; i < (options.waiting ?? 0); i += 1) {
    env.entities.apply(
      paymentFrame(uuid(900 + i), uuid(800 + i), 50 + i, {
        method: 'promptpay',
        status: i % 2 === 0 ? 'pending' : 'claimed',
        confirmedAt: null,
      }),
    );
  }
  renderScreen(<SettingsSectionScreen section="promptpay" />, env.services);
  return { ...env, auth, stepUpOwner };
}

const changeButton = () => screen.findByRole('button', { name: tr('settings.promptpay.change') });

async function fillAndReview(typed = NEW_ID_TYPED) {
  fireEvent.click(await changeButton());
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(tr('settings.promptpay.dialog.value')), {
    target: { value: typed },
  });
  fireEvent.click(
    within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.review') }),
  );
  return dialog;
}

describe('what the screen shows', () => {
  test('only the masked account, never the full number', async () => {
    await open();
    expect(
      await screen.findByText(
        tr('settings.promptpay.shown', {
          type: tr('settings.promptpay.type.phone'),
          masked: '******1234',
        }),
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(OLD_ID);
    expect(screen.getByText(tr('settings.promptpay.privacy'))).toBeTruthy();
  });

  test('no account yet says PromptPay cannot be used and offers to set one', async () => {
    await open({ settingsApi: { promptpayMasked: { read: async () => settingAnswer(null, 0) } } });
    expect(await screen.findByText(tr('settings.promptpay.none'))).toBeTruthy();
    expect(screen.getByRole('button', { name: tr('settings.promptpay.set') })).toBeTruthy();
  });

  test('a manager sees the masked account but has no way to change it', async () => {
    await open({ role: 'manager' });
    await screen.findByText(/\*{6}1234/);
    expect(screen.queryByRole('button', { name: tr('settings.promptpay.change') })).toBeNull();
    expect(screen.getByText(tr('settings.viewOnly'))).toBeTruthy();
  });
});

describe('changing the account', () => {
  test('a number of the wrong shape is refused before anything else', async () => {
    const env = await open();
    fireEvent.click(await changeButton());
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(tr('settings.promptpay.dialog.value')), {
      target: { value: '12345' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.review') }),
    );
    expect(within(dialog).getByText(tr('settings.promptpay.dialog.error'))).toBeTruthy();
    expect(env.settingsApi.promptpayMasked.save).not.toHaveBeenCalled();
  });

  test('the review shows the new account masked beside the old one, and a warning with the count of payments still waiting', async () => {
    await open({ waiting: 2 });
    const dialog = await fillAndReview();
    expect(
      within(dialog).getByText(
        tr('settings.promptpay.dialog.newAccount', { masked: '******0000' }),
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        tr('settings.promptpay.dialog.oldAccount', { masked: '******1234' }),
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(tr('settings.promptpay.dialog.warnOpen', { count: 2 })),
    ).toBeTruthy();
    // The full number the person typed is nowhere on the review page.
    expect(document.body.textContent).not.toContain(NEW_ID);
    expect(document.body.textContent).not.toContain(NEW_ID_TYPED);
    expect(document.body.innerHTML).not.toContain(NEW_ID);
    expect(within(dialog).getByText(tr('settings.promptpay.dialog.alert'))).toBeTruthy();
  });

  test('with nothing waiting the warning says what a customer who already scanned will do', async () => {
    await open();
    const dialog = await fillAndReview();
    expect(within(dialog).getByText(tr('settings.promptpay.dialog.warnNone'))).toBeTruthy();
  });

  test('confirming saves the digits with the version, closes the dialog and says it was changed', async () => {
    const env = await open({
      settingsApi: {
        promptpayMasked: {
          read: async () => settingAnswer({ idType: 'phone', idMasked: '******1234' }, 4),
          save: async () => settingAnswer({ idType: 'phone', idMasked: '******0000' }, 5),
        },
      },
    });
    const dialog = await fillAndReview();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.settingsApi.promptpayMasked.save).toHaveBeenCalledTimes(1);
    expect(env.settingsApi.promptpayMasked.save).toHaveBeenCalledWith({
      expectedVersion: 4,
      idType: 'phone',
      idValue: NEW_ID,
    });
    expect(await screen.findByText(/\*{6}0000/)).toBeTruthy();
    expect(env.settingsEditor.getState().slots.promptpay.loaded?.version).toBe(5);
    // Neither number is on the page or in the store afterwards.
    expect(document.body.innerHTML).not.toContain(NEW_ID);
    expect(document.body.innerHTML).not.toContain(OLD_ID);
    expect(JSON.stringify(env.settingsEditor.getState())).not.toContain(NEW_ID);
  });

  test('without a fresh step-up the owner is asked first; closing that asks nothing of the server and leaves the review open', async () => {
    const env = await open({ freshStepUp: false });
    const dialog = await fillAndReview();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    const stepUp = await screen.findByText(th['auth.stepUp.title']);
    expect(stepUp).toBeTruthy();
    fireEvent.click(
      within(screen.getAllByRole('dialog').at(-1) as HTMLElement).getByRole('button', {
        name: th['common.cancel'],
      }),
    );
    await waitFor(() => expect(screen.queryByText(th['auth.stepUp.title'])).toBeNull());
    expect(env.settingsApi.promptpayMasked.save).not.toHaveBeenCalled();
    // Still on the review step, no error shown.
    expect(screen.getByText(tr('settings.promptpay.dialog.confirmTitle'))).toBeTruthy();
    expect(screen.queryByText(th['error.stepUpRequired'])).toBeNull();
  });

  test('a refusal from the server is shown inside the dialog with its own words, and the review stays open', async () => {
    await open({
      settingsApi: {
        promptpayMasked: {
          save: async () => {
            throw new ApiClientError('FORBIDDEN', { status: 403 });
          },
        },
      },
    });
    const dialog = await fillAndReview();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    expect(await within(dialog).findByText(th['error.forbidden'])).toBeTruthy();
  });

  test('a conflict (the account changed on another device) ends the review and shows the latest masked account', async () => {
    let reads = 0;
    await open({
      settingsApi: {
        promptpayMasked: {
          read: async () => {
            reads += 1;
            return settingAnswer(
              { idType: 'phone', idMasked: reads === 1 ? '******1234' : '******7777' },
              reads === 1 ? 4 : 6,
            );
          },
          save: async () => {
            throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 6 });
          },
        },
      },
    });
    const dialog = await fillAndReview();
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/\*{6}7777/)).toBeTruthy();
    expect(await screen.findByText(new RegExp(tr('settings.refreshed')))).toBeTruthy();
  });

  test('offline: the owner cannot start a change, nothing is sent', async () => {
    const { auth } = await createTestAuth('owner');
    const env = createTestServices({ auth, offline: true });
    renderScreen(<SettingsSectionScreen section="promptpay" />, env.services);
    expect(await screen.findByText(tr('settings.offline'))).toBeTruthy();
    expect(env.settingsApi.promptpayMasked.read).not.toHaveBeenCalled();
  });
});

describe('the full number never reaches the screen, even from the real client', () => {
  test('a server that answers with the number in clear: the page and the store hold only the masked form, before and after a change', async () => {
    let held = { idType: 'phone', idValue: OLD_ID };
    let version = 4;
    const net = mockFetch((call) => {
      if (call.method === 'PATCH') {
        const body = call.body as { idType: string; idValue: string };
        held = { idType: body.idType, idValue: body.idValue };
        version += 1;
      }
      return {
        status: 200,
        json: { value: held, version, rev: version * 10, updatedAt: '2026-10-03T03:00:00.000Z' },
      };
    });
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: net.fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    const env = await open({
      settingsApi: { promptpayMasked: client.settings.promptpayMasked },
    });
    await screen.findByText(/\*{6}1234/);
    expect(document.body.innerHTML).not.toContain(OLD_ID);

    const dialog = await fillAndReview('0899990000');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    await screen.findByText(/\*{6}0000/);
    expect(net.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    for (const text of [document.body.innerHTML, JSON.stringify(env.settingsEditor.getState())]) {
      expect(text).not.toContain(OLD_ID);
      expect(text).not.toContain(NEW_ID);
    }
  });

  test('a rejected change from the real client carries only a code', async () => {
    const net = mockFetch((call) =>
      call.method === 'PATCH'
        ? apiError(403, 'FORBIDDEN')
        : {
            status: 200,
            json: {
              value: { idType: 'phone', idValue: OLD_ID },
              version: 4,
              rev: 40,
              updatedAt: '2026-10-03T03:00:00.000Z',
            },
          },
    );
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: net.fetch,
      getSessionToken: () => FAKE_SESSION_TOKEN,
      getDeviceToken: () => FAKE_DEVICE_TOKEN,
    });
    await open({ settingsApi: { promptpayMasked: client.settings.promptpayMasked } });
    await screen.findByText(/\*{6}1234/);
    const dialog = await fillAndReview('0899990000');
    fireEvent.click(
      within(dialog).getByRole('button', { name: tr('settings.promptpay.dialog.confirm') }),
    );
    expect(await within(dialog).findByText(th['error.forbidden'])).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(NEW_ID);
  });
});
