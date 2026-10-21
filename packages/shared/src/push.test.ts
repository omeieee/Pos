import { describe, expect, test } from 'vitest';
import {
  isAllowedPushEndpoint,
  PUSH_ENDPOINT_HOST_SUFFIXES,
  PUSH_ENDPOINT_HOSTS,
  pushPayloadSchema,
  pushSubscriptionInputSchema,
} from './push.ts';

const P256DH = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);
const good = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: P256DH, auth: AUTH },
};

describe('the push host allow-list', () => {
  test('is exactly the known push services', () => {
    expect([...PUSH_ENDPOINT_HOSTS].sort()).toEqual([
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
    ]);
    expect([...PUSH_ENDPOINT_HOST_SUFFIXES].sort()).toEqual([
      '.notify.windows.com',
      '.push.apple.com',
    ]);
  });

  test.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QWxs',
    'https://api.push.apple.com/3/device/abc',
    'https://sg2p.notify.windows.com/w/?token=abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  test.each([
    ['http, not https', 'http://fcm.googleapis.com/x'],
    ['another host', 'https://example.com/x'],
    ['a look-alike suffix', 'https://evilpush.apple.com/x'],
    ['the allowed host inside another domain', 'https://fcm.googleapis.com.evil.com/x'],
    ['the allowed host as a path', 'https://evil.com/fcm.googleapis.com'],
    ['the bare suffix', 'https://push.apple.com/x'],
    ['a trailing dot host', 'https://fcm.googleapis.com./x'],
    ['user info', 'https://user:pw@fcm.googleapis.com/x'],
    ['another port', 'https://fcm.googleapis.com:8443/x'],
    ['an IPv4 literal', 'https://127.0.0.1/x'],
    ['an IPv6 literal', 'https://[::1]/x'],
    ['localhost', 'https://localhost/x'],
    ['not a URL', 'fcm.googleapis.com'],
    ['a too long URL', `https://fcm.googleapis.com/${'a'.repeat(2100)}`],
  ])('refuses %s', (_name, url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });
});

describe('pushSubscriptionInputSchema', () => {
  test('accepts what PushSubscription.toJSON() sends, ignoring expirationTime and unknown fields', () => {
    const parsed = pushSubscriptionInputSchema.parse({ ...good, expirationTime: null, extra: 1 });
    expect(parsed).toEqual(good);
    expect(
      pushSubscriptionInputSchema.safeParse({ ...good, expirationTime: 1767225600000 }).success,
    ).toBe(true);
  });

  test('refuses a bad endpoint, bad keys or a missing part', () => {
    const bad = [
      { ...good, endpoint: 'https://example.com/x' },
      { ...good, keys: { ...good.keys, p256dh: `C${'A'.repeat(86)}` } },
      { ...good, keys: { ...good.keys, p256dh: `B${'A'.repeat(85)}` } },
      { ...good, keys: { ...good.keys, auth: 'A'.repeat(21) } },
      { ...good, keys: { ...good.keys, auth: `${'A'.repeat(21)}+` } },
      { endpoint: good.endpoint },
      { keys: good.keys },
    ];
    for (const input of bad)
      expect(pushSubscriptionInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('pushPayloadSchema', () => {
  const base = { title: 'ออเดอร์ใหม่ #L-012 (LINE)', body: '3 รายการ', tag: 'order-1' };

  test('accepts a path inside the POS', () => {
    expect(pushPayloadSchema.safeParse({ ...base, url: '/#/orders/abc' }).success).toBe(true);
    expect(pushPayloadSchema.safeParse({ ...base, body: '', url: '/' }).success).toBe(true);
  });

  test.each([
    '//evil.example/x',
    '/\\evil.example/x',
    'https://evil.example/x',
    'orders/1',
    '/a b',
  ])('refuses %s', (url) => {
    expect(pushPayloadSchema.safeParse({ ...base, url }).success).toBe(false);
  });
});
