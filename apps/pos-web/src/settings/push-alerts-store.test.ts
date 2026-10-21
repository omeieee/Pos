import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createFakePush, type FakePushOptions, fakeSubscription } from '../dev/fake-push.ts';
import { MOCK_VAPID_PUBLIC_KEY } from '../dev/mock-push.ts';
import { createPushAlertsStore } from './push-alerts-store.ts';

const OTHER_KEY = `B${'C'.repeat(86)}`;

function setup(
  options: {
    browser?: FakePushOptions;
    config?: { enabled: boolean; publicKey: string | null } | ApiClientError;
    server?: boolean | ApiClientError;
    save?: ApiClientError;
    remove?: ApiClientError;
  } = {},
) {
  const browser = createFakePush(options.browser);
  const answer = <T>(value: T | ApiClientError) =>
    value instanceof ApiClientError ? Promise.reject(value) : Promise.resolve(value);
  const api = {
    push: {
      config: vi.fn(() =>
        answer(options.config ?? { enabled: true, publicKey: MOCK_VAPID_PUBLIC_KEY }),
      ),
      subscribed: vi.fn(() =>
        answer(
          options.server instanceof ApiClientError
            ? options.server
            : { subscribed: options.server ?? false },
        ),
      ),
      subscribe: vi.fn(() =>
        options.save ? Promise.reject(options.save) : Promise.resolve({ subscribed: true }),
      ),
      unsubscribe: vi.fn(() =>
        options.remove ? Promise.reject(options.remove) : Promise.resolve({ subscribed: false }),
      ),
    },
  };
  const store = createPushAlertsStore({ api, push: browser.platform });
  return { store, api, browser };
}

const status = (store: ReturnType<typeof setup>['store']) => store.getState().status;
const apiError = (code: string, httpStatus: number) =>
  new ApiClientError(code, { status: httpStatus });

describe('opening the page: what is shown', () => {
  test('reads the server, then shows off for a device with no subscription anywhere', async () => {
    const { store, api } = setup();
    expect(status(store)).toBe('idle');
    const loading = store.load();
    expect(store.getState()).toMatchObject({ status: 'loading', busy: true });
    await loading;
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: null });
    expect(api.push.config).toHaveBeenCalledTimes(1);
  });

  test('the server has no keys: not configured, and the browser is never asked', async () => {
    const { store, browser, api } = setup({ config: { enabled: false, publicKey: null } });
    await store.load();
    expect(status(store)).toBe('not-configured');
    expect(browser.calls).toEqual([]);
    expect(api.push.subscribed).not.toHaveBeenCalled();
  });

  test('a 503 from the config or the subscription read also means not configured', async () => {
    const a = setup({ config: apiError('PUSH_NOT_CONFIGURED', 503) });
    await a.store.load();
    expect(status(a.store)).toBe('not-configured');
    const b = setup({ server: apiError('PUSH_NOT_CONFIGURED', 503) });
    await b.store.load();
    expect(status(b.store)).toBe('not-configured');
  });

  test('an iPhone or iPad in a Safari tab is told to add the app to the Home Screen', async () => {
    const { store } = setup({ browser: { availability: 'needs-install' } });
    await store.load();
    expect(status(store)).toBe('needs-install');
  });

  test('a browser without push is unsupported', async () => {
    const { store } = setup({ browser: { availability: 'unsupported' } });
    await store.load();
    expect(status(store)).toBe('unsupported');
  });

  test('a blocked permission is denied, with nothing asked of the server', async () => {
    const { store, api } = setup({ browser: { permission: 'denied' } });
    await store.load();
    expect(status(store)).toBe('denied');
    expect(api.push.subscribed).not.toHaveBeenCalled();
  });

  test('a session with no registered device says so', async () => {
    const { store } = setup({ server: apiError('DEVICE_REQUIRED', 403) });
    await store.load();
    expect(status(store)).toBe('no-device');
  });

  test('a failed read is an error that can be retried', async () => {
    const { store, api } = setup({ config: new ApiClientError('NETWORK') });
    await store.load();
    expect(status(store)).toBe('error');
    api.push.config.mockImplementationOnce(() =>
      Promise.resolve({ enabled: true, publicKey: MOCK_VAPID_PUBLIC_KEY }),
    );
    await store.load();
    expect(status(store)).toBe('off');
  });

  test('two reads at once share one', async () => {
    const { store, api } = setup();
    await Promise.all([store.load(), store.load()]);
    expect(api.push.config).toHaveBeenCalledTimes(1);
  });
});

describe('reconciling the browser and the server', () => {
  const held = (key: string | null = MOCK_VAPID_PUBLIC_KEY) => fakeSubscription(key);

  test('both have it: on, and the subscription is saved again in case the browser rotated it', async () => {
    const local = held();
    const { store, api } = setup({
      server: true,
      browser: { permission: 'granted', subscription: local },
    });
    await store.load();
    expect(status(store)).toBe('on');
    expect(api.push.subscribe).toHaveBeenCalledWith(local);
  });

  test('on stays on when that refresh fails', async () => {
    const { store } = setup({
      server: true,
      save: new ApiClientError('NETWORK'),
      browser: { permission: 'granted', subscription: held() },
    });
    await store.load();
    expect(status(store)).toBe('on');
  });

  test('the browser has one the server does not know: off, and the browser one is dropped', async () => {
    const { store, browser, api } = setup({
      server: false,
      browser: { permission: 'granted', subscription: held() },
    });
    await store.load();
    expect(status(store)).toBe('off');
    expect(browser.held()).toBeNull();
    expect(api.push.subscribe).not.toHaveBeenCalled();
  });

  test('the server has it but the browser lost it, permission granted: subscribed again quietly, no prompt', async () => {
    const { store, browser, api } = setup({ server: true, browser: { permission: 'granted' } });
    await store.load();
    expect(status(store)).toBe('on');
    expect(browser.held()?.applicationServerKey).toBe(MOCK_VAPID_PUBLIC_KEY);
    expect(api.push.subscribe).toHaveBeenCalledTimes(1);
  });

  test('the server has it but the browser lost it and permission is not granted: off, and the server row is removed', async () => {
    const { store, api } = setup({ server: true, browser: { permission: 'default' } });
    await store.load();
    expect(status(store)).toBe('off');
    expect(api.push.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('the server key changed: the old subscription is dropped and a new one made and saved', async () => {
    const { store, browser, api } = setup({
      server: true,
      browser: { permission: 'granted', subscription: held(OTHER_KEY) },
    });
    await store.load();
    expect(status(store)).toBe('on');
    expect(browser.held()?.applicationServerKey).toBe(MOCK_VAPID_PUBLIC_KEY);
    expect(browser.calls.indexOf('unsubscribe')).toBeGreaterThan(-1);
    expect(api.push.subscribe).toHaveBeenCalledWith(browser.held());
  });

  test('the server key changed and the person had it off: off, the old one dropped, nothing saved', async () => {
    const { store, browser, api } = setup({
      server: false,
      browser: { permission: 'granted', subscription: held(OTHER_KEY) },
    });
    await store.load();
    expect(status(store)).toBe('off');
    expect(browser.held()).toBeNull();
    expect(api.push.subscribe).not.toHaveBeenCalled();
  });

  test('a browser that does not say the key is trusted, not re-subscribed on every visit', async () => {
    const local = held(null);
    const { store, browser } = setup({
      server: true,
      browser: { permission: 'granted', subscription: local },
    });
    await store.load();
    expect(status(store)).toBe('on');
    expect(browser.held()).toBe(local);
    expect(browser.calls).not.toContain('subscribe');
  });

  test('a quiet re-subscribe the browser refuses ends as off, not as an error', async () => {
    const { store } = setup({
      server: true,
      browser: { permission: 'granted', failSubscribe: true },
    });
    await store.load();
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: null });
  });
});

describe('turning alerts on', () => {
  test('asks the browser in the same tick as the tap, then saves, and shows on only after the save', async () => {
    const { store, browser, api } = setup();
    await store.load();
    let finishSave: (value: { subscribed: boolean }) => void = () => undefined;
    api.push.subscribe.mockImplementationOnce(
      () => new Promise((resolve) => (finishSave = resolve)),
    );
    const tapping = store.enable();
    // Nothing awaited yet: the browser was already asked.
    expect(browser.calls).toEqual(['getSubscription', 'subscribe']);
    expect(store.getState()).toMatchObject({ status: 'off', busy: true });
    await vi.waitFor(() => expect(api.push.subscribe).toHaveBeenCalled());
    // Not optimistic: still off while the server has not answered.
    expect(status(store)).toBe('off');
    finishSave({ subscribed: true });
    await tapping;
    expect(store.getState()).toEqual({ status: 'on', busy: false, problem: null });
    expect(api.push.subscribe).toHaveBeenCalledWith(browser.held());
  });

  test('a second tap while one is on its way does nothing', async () => {
    const { store, browser } = setup();
    await store.load();
    const first = store.enable();
    await store.enable();
    await first;
    expect(browser.calls.filter((c) => c === 'subscribe')).toHaveLength(1);
  });

  test('the person blocks the prompt: denied', async () => {
    const { store, api } = setup({ browser: { prompt: 'denied' } });
    await store.load();
    await store.enable();
    expect(status(store)).toBe('denied');
    expect(api.push.subscribe).not.toHaveBeenCalled();
  });

  test('the person closes the prompt: still off, with a hint to try again', async () => {
    const { store } = setup({ browser: { prompt: 'default' } });
    await store.load();
    await store.enable();
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: 'dismissed' });
  });

  test('the browser cannot subscribe: an error beside the switch, nothing saved', async () => {
    const { store, api } = setup({ browser: { failSubscribe: true } });
    await store.load();
    await store.enable();
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: 'enable' });
    expect(api.push.subscribe).not.toHaveBeenCalled();
  });

  test('the save fails: the browser subscription is dropped again and the switch stays off', async () => {
    const { store, browser } = setup({ save: new ApiClientError('NETWORK') });
    await store.load();
    await store.enable();
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: 'enable' });
    expect(browser.held()).toBeNull();
  });

  test('the server says it is not set up, or the session has no device: that becomes the status', async () => {
    const a = setup({ save: apiError('PUSH_NOT_CONFIGURED', 503) });
    await a.store.load();
    await a.store.enable();
    expect(status(a.store)).toBe('not-configured');
    const b = setup({ save: apiError('DEVICE_REQUIRED', 403) });
    await b.store.load();
    await b.store.enable();
    expect(status(b.store)).toBe('no-device');
    expect(b.browser.held()).toBeNull();
  });

  test('does nothing before the page has been read, or when it is not off', async () => {
    const { store, browser } = setup({ browser: { availability: 'unsupported' } });
    await store.enable();
    await store.load();
    await store.enable();
    expect(browser.calls).not.toContain('subscribe');
  });
});

describe('turning alerts off', () => {
  async function on() {
    const made = setup({
      server: true,
      browser: { permission: 'granted', subscription: fakeSubscription() },
    });
    await made.store.load();
    return made;
  }

  test('removes it on the server, then in the browser, and shows off after the server answered', async () => {
    const { store, browser, api } = await on();
    await store.disable();
    expect(store.getState()).toEqual({ status: 'off', busy: false, problem: null });
    expect(api.push.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.held()).toBeNull();
  });

  test('if the server cannot be reached nothing changes: still on, with an error', async () => {
    const { store, browser, api } = await on();
    api.push.unsubscribe.mockImplementationOnce(() =>
      Promise.reject(new ApiClientError('NETWORK')),
    );
    await store.disable();
    expect(store.getState()).toEqual({ status: 'on', busy: false, problem: 'disable' });
    expect(browser.held()).not.toBeNull();
  });

  test('a browser that will not let go still ends as off: the next read cleans it up', async () => {
    const { store, browser } = await on();
    vi.spyOn(browser.platform, 'unsubscribe').mockRejectedValue(new Error('refused'));
    await store.disable();
    expect(status(store)).toBe('off');
  });

  test('the server losing its keys meanwhile: the browser one is dropped and the status says so', async () => {
    const { store, browser, api } = await on();
    api.push.unsubscribe.mockImplementationOnce(() =>
      Promise.reject(apiError('PUSH_NOT_CONFIGURED', 503)),
    );
    await store.disable();
    expect(status(store)).toBe('not-configured');
    expect(browser.held()).toBeNull();
  });

  test('does nothing when it is not on', async () => {
    const { store, api } = setup();
    await store.load();
    await store.disable();
    expect(api.push.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  test('forgets what was read, keeps the browser subscription, and ignores an answer still on its way', async () => {
    const { store, browser, api } = setup({
      server: true,
      browser: { permission: 'granted', subscription: fakeSubscription() },
    });
    let release: (value: { subscribed: boolean }) => void = () => undefined;
    api.push.subscribed.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const loading = store.load();
    store.reset();
    expect(store.getState()).toEqual({ status: 'idle', busy: false, problem: null });
    release({ subscribed: true });
    await loading;
    expect(status(store)).toBe('idle');
    expect(browser.held()).not.toBeNull();
    expect(browser.calls).not.toContain('unsubscribe');
  });
});
