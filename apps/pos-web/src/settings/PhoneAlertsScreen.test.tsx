// @vitest-environment jsdom
import { th, translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import type { FakePushOptions } from '../dev/fake-push.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { PhoneAlertsScreen } from './PhoneAlertsScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

async function open(
  options: { role?: StaffRole; browser?: FakePushOptions; push?: Partial<ApiClient['push']> } = {},
) {
  const { auth } = await createTestAuth(options.role ?? 'cashier');
  const env = createTestServices({
    auth,
    ...(options.browser ? { pushBrowser: options.browser } : {}),
    ...(options.push ? { push: options.push } : {}),
  });
  renderScreen(<PhoneAlertsScreen />, env.services);
  return env;
}

// The page also holds the payment pop-up switch (D-42): this is the phone alerts one.
const sw = async () =>
  (await screen.findByRole('checkbox', { name: tr('push.switch') })) as HTMLInputElement;
const heading = () => screen.getByRole('heading', { level: 1, name: tr('push.title') });

describe('phone alerts page', () => {
  test('is for every role: a kitchen role sees it, with the switch labelled and off', async () => {
    await open({ role: 'kitchen' });
    expect(heading()).toBeTruthy();
    const box = await sw();
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: tr('push.switch') })).toBe(box);
    expect(screen.getByText(tr('push.state.off'))).toBeTruthy();
    expect(screen.getByText(tr('push.privacy'))).toBeTruthy();
  });

  test('the way back is Settings for a role that has it, the orders page for one that has not', async () => {
    await open({ role: 'cashier' });
    expect(screen.getByRole('link', { name: tr('settings.back') }).getAttribute('href')).toBe(
      '#/settings',
    );
    cleanup();
    await open({ role: 'kitchen' });
    expect(screen.getByRole('link', { name: tr('push.back') }).getAttribute('href')).toBe(
      '#/orders',
    );
  });

  test('opening the page asks the browser for nothing visible: no permission prompt', async () => {
    const env = await open();
    await sw();
    expect(env.pushBrowser.calls).not.toContain('subscribe');
    expect(env.pushBrowser.platform.permission()).toBe('default');
  });

  test('the tap turns it on: the prompt, the save, then "on"', async () => {
    const env = await open();
    fireEvent.click(await sw());
    expect(await screen.findByText(tr('push.state.on'))).toBeTruthy();
    expect((await sw()).checked).toBe(true);
    expect(env.api.push.subscribe).toHaveBeenCalledTimes(1);
    expect(env.pushBrowser.platform.permission()).toBe('granted');
  });

  test('the tap turns it off again', async () => {
    const env = await open({
      browser: { permission: 'granted' },
      push: { subscribed: async () => ({ subscribed: true }) },
    });
    await waitFor(async () => expect((await sw()).checked).toBe(true));
    fireEvent.click(await sw());
    expect(await screen.findByText(tr('push.state.off'))).toBeTruthy();
    expect(env.api.push.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('the switch is not available while a tap is being worked out', async () => {
    let finish: (value: { subscribed: boolean }) => void = () => undefined;
    await open({ push: { subscribe: () => new Promise((resolve) => (finish = resolve)) } });
    fireEvent.click(await sw());
    await waitFor(async () => expect((await sw()).disabled).toBe(true));
    expect(screen.getByText(tr('push.state.working'))).toBeTruthy();
    finish({ subscribed: true });
    await screen.findByText(tr('push.state.on'));
  });

  test('a failed save says so beside the switch and leaves it off', async () => {
    await open({ push: { subscribe: async () => Promise.reject(new ApiClientError('NETWORK')) } });
    fireEvent.click(await sw());
    expect((await screen.findByRole('alert')).textContent).toContain(th['push.error.enable']);
    expect((await sw()).checked).toBe(false);
  });

  test('a closed prompt says how to try again', async () => {
    await open({ browser: { prompt: 'default' } });
    fireEvent.click(await sw());
    expect((await screen.findByRole('alert')).textContent).toContain(th['push.error.dismissed']);
  });
});

describe('phone alerts page: the payment pop-up switch (D-42)', () => {
  test('is on by default, whatever the browser can do, and the choice is remembered', async () => {
    const env = await open({ browser: { availability: 'unsupported' } });
    const box = (await screen.findByRole('checkbox', {
      name: tr('payPopup.switch'),
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(tr('payPopup.state.on'))).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(screen.getByText(tr('payPopup.state.off'))).toBeTruthy();
    await waitFor(() => expect(env.popupPrefs.value()).toBe(false));
  });
});

describe('phone alerts page: when the switch is not available', () => {
  test('the server is not set up: the owner has to act, and there is no switch', async () => {
    await open({ push: { config: async () => ({ enabled: false, publicKey: null }) } });
    expect(await screen.findByText(th['push.notConfigured'])).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: tr('push.switch') })).toBeNull();
  });

  test('the browser has no push', async () => {
    await open({ browser: { availability: 'unsupported' } });
    expect(await screen.findByText(th['push.unsupported'])).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: tr('push.switch') })).toBeNull();
  });

  test('an iPhone in a Safari tab gets the Home Screen steps', async () => {
    await open({ browser: { availability: 'needs-install' } });
    expect(await screen.findByText(th['push.needsInstall.title'])).toBeTruthy();
    for (const step of [1, 2, 3, 4] as const) {
      expect(screen.getByText(th[`push.needsInstall.step${step}`])).toBeTruthy();
    }
    expect(screen.queryByRole('checkbox', { name: tr('push.switch') })).toBeNull();
  });

  test('a blocked permission explains how to allow it, and can be checked again', async () => {
    const env = await open({ browser: { permission: 'denied' } });
    expect(await screen.findByText(th['push.denied.title'])).toBeTruthy();
    expect(screen.getByText(th['push.denied.body'])).toBeTruthy();
    // The person allows it in the system settings and comes back.
    env.pushBrowser.set({ permission: 'default' });
    fireEvent.click(screen.getByRole('button', { name: tr('push.denied.recheck') }));
    expect(await sw()).toBeTruthy();
  });

  test('a session without a device is told the device must be registered', async () => {
    await open({
      push: {
        subscribed: async () =>
          Promise.reject(new ApiClientError('DEVICE_REQUIRED', { status: 403 })),
      },
    });
    expect(await screen.findByText(th['push.deviceRequired'])).toBeTruthy();
  });

  test('a failed read is an alert with a retry that works', async () => {
    let calls = 0;
    await open({
      push: {
        config: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('NETWORK');
          return { enabled: true, publicKey: `B${'A'.repeat(86)}` };
        },
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain(th['push.error.load']);
    fireEvent.click(screen.getByRole('button', { name: tr('push.retry') }));
    expect(await sw()).toBeTruthy();
  });
});
