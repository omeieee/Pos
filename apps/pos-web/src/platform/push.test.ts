import { describe, expect, test, vi } from 'vitest';
import {
  type BrowserRegistration,
  type BrowserSubscription,
  base64UrlToBytes,
  bytesToBase64Url,
  createWebPush,
  type PushEnvironment,
  type PushPermission,
  PushPlatformError,
  sameKey,
} from './push.ts';

const KEY = `B${'A'.repeat(86)}`;
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

function browserSub(key: string | null = KEY): BrowserSubscription & { dropped: boolean } {
  const sub = {
    dropped: false,
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: `B${'B'.repeat(86)}`, auth: 'A'.repeat(22) },
    }),
    options: { applicationServerKey: key === null ? null : base64UrlToBytes(key).buffer },
    async unsubscribe() {
      sub.dropped = true;
      return true;
    },
  };
  return sub;
}

function env(over: Partial<PushEnvironment> = {}, start: BrowserSubscription | null = null) {
  let held = start;
  const subscribe = vi.fn(async () => {
    held = browserSub();
    return held;
  });
  const registration: BrowserRegistration = {
    pushManager: { getSubscription: async () => held, subscribe },
  };
  let permission: PushPermission = 'default';
  const requestPermission = vi.fn(async () => {
    permission = 'granted';
    return permission;
  });
  const environment: PushEnvironment = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
    platform: 'Win32',
    maxTouchPoints: 0,
    standalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    notificationPermission: () => permission,
    requestPermission,
    registration: async () => registration,
    ...over,
  };
  return { environment, subscribe, requestPermission, held: () => held };
}

describe('base64url', () => {
  test('round-trips a 65-byte key and ignores padding', () => {
    const bytes = base64UrlToBytes(KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(bytesToBase64Url(bytes)).toBe(KEY);
    expect(sameKey(`${KEY}==`, KEY)).toBe(true);
    expect(sameKey(KEY, `B${'C'.repeat(86)}`)).toBe(false);
  });

  test('a character outside the alphabet is refused', () => {
    expect(() => base64UrlToBytes('ab+/')).toThrow(PushPlatformError);
  });
});

describe('what this browser can do', () => {
  test('a desktop browser with service worker, push and notifications is supported', () => {
    const push = createWebPush(env().environment);
    expect(push.isSupported()).toBe(true);
    expect(push.needsInstall()).toBe(false);
    expect(push.permission()).toBe('default');
  });

  test('an iPhone in a Safari tab needs the Home Screen first, and so does an iPad that calls itself a Mac', () => {
    const iphone = createWebPush(
      env({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
        hasPushManager: false,
      }).environment,
    );
    expect(iphone.needsInstall()).toBe(true);
    expect(iphone.isSupported()).toBe(false);
    const ipad = createWebPush(
      env({
        userAgent: IPAD_AS_MAC,
        platform: 'MacIntel',
        maxTouchPoints: 5,
        hasPushManager: false,
      }).environment,
    );
    expect(ipad.needsInstall()).toBe(true);
  });

  test('a real Mac (no touch screen) is not an iPad', () => {
    const mac = createWebPush(
      env({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 0 }).environment,
    );
    expect(mac.needsInstall()).toBe(false);
    expect(mac.isSupported()).toBe(true);
  });

  test('an iPhone app from the Home Screen is supported; one without PushManager is an iOS before 16.4', () => {
    const base = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      standalone: true,
    };
    expect(createWebPush(env(base).environment).needsInstall()).toBe(false);
    expect(createWebPush(env(base).environment).isSupported()).toBe(true);
    const old = createWebPush(env({ ...base, hasPushManager: false }).environment);
    expect(old.needsInstall()).toBe(false);
    expect(old.isSupported()).toBe(false);
  });

  test('without Notification the permission reads as denied and nothing can subscribe', async () => {
    const push = createWebPush(env({ hasNotification: false }).environment);
    expect(push.permission()).toBe('denied');
    await expect(push.subscribe(KEY)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await push.getSubscription()).toBeNull();
  });
});

describe('subscribing', () => {
  test('asks for the permission first, then subscribes with the key and userVisibleOnly', async () => {
    const e = env();
    const result = await createWebPush(e.environment).subscribe(KEY);
    expect(e.requestPermission).toHaveBeenCalledTimes(1);
    expect(e.subscribe).toHaveBeenCalledTimes(1);
    const call = e.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean }];
    expect(call[0].userVisibleOnly).toBe(true);
    expect(result.endpoint).toBe('https://fcm.googleapis.com/fcm/send/x');
    expect(result.applicationServerKey).toBe(KEY);
  });

  test('the permission prompt starts before anything is awaited (the tap counts)', () => {
    const e = env();
    void createWebPush(e.environment).subscribe(KEY);
    expect(e.requestPermission).toHaveBeenCalledTimes(1);
    expect(e.subscribe).not.toHaveBeenCalled();
  });

  test('a blocked permission is denied without a prompt; a closed prompt is dismissed', async () => {
    const blocked = env({ notificationPermission: () => 'denied' });
    await expect(createWebPush(blocked.environment).subscribe(KEY)).rejects.toMatchObject({
      code: 'denied',
    });
    expect(blocked.requestPermission).not.toHaveBeenCalled();
    const closed = env({ requestPermission: async () => 'default' });
    await expect(createWebPush(closed.environment).subscribe(KEY)).rejects.toMatchObject({
      code: 'dismissed',
    });
  });

  test('a granted permission is not asked again, and a subscription with the same key is reused', async () => {
    const existing = browserSub();
    const e = env({ notificationPermission: () => 'granted' }, existing);
    const result = await createWebPush(e.environment).subscribe(KEY);
    expect(e.requestPermission).not.toHaveBeenCalled();
    expect(e.subscribe).not.toHaveBeenCalled();
    expect(result.applicationServerKey).toBe(KEY);
  });

  test('a subscription made for another key is dropped before the new one is made', async () => {
    const existing = browserSub(`B${'C'.repeat(86)}`);
    const e = env({ notificationPermission: () => 'granted' }, existing);
    await createWebPush(e.environment).subscribe(KEY);
    expect(existing.dropped).toBe(true);
    expect(e.subscribe).toHaveBeenCalledTimes(1);
  });

  test('a browser failure is "failed", never a raw error', async () => {
    const e = env({ notificationPermission: () => 'granted' });
    e.subscribe.mockRejectedValueOnce(new Error('push service unreachable'));
    await expect(createWebPush(e.environment).subscribe(KEY)).rejects.toMatchObject({
      code: 'failed',
    });
  });
});

describe('reading and dropping', () => {
  test('getSubscription gives the endpoint, keys and the key it was made with', async () => {
    const e = env({}, browserSub());
    expect(await createWebPush(e.environment).getSubscription()).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: `B${'B'.repeat(86)}`, auth: 'A'.repeat(22) },
      applicationServerKey: KEY,
    });
  });

  test('an engine that does not say the key gives null', async () => {
    const e = env({}, browserSub(null));
    expect((await createWebPush(e.environment).getSubscription())?.applicationServerKey).toBeNull();
  });

  test('unsubscribe drops it, and is fine when there is none', async () => {
    const existing = browserSub();
    await createWebPush(env({}, existing).environment).unsubscribe();
    expect(existing.dropped).toBe(true);
    await expect(createWebPush(env().environment).unsubscribe()).resolves.toBeUndefined();
  });
});
