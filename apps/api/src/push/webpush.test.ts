import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { newBrowser } from '../test-support/fake-push.ts';
import {
  buildPushRequest,
  encryptPayload,
  generateVapidKeys,
  isValidSubscriberKey,
  vapidAuthorization,
  vapidPublicKeyOf,
} from './webpush.ts';

const b = (text: string) => Buffer.from(text, 'base64url');

// RFC 8291 appendix A: the worked example every implementation is checked against.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  subscriberPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPayload (RFC 8291)', () => {
  test('reproduces the RFC example byte for byte', () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.subscriberPublic, auth: RFC.auth },
      { salt: b(RFC.salt), senderKey: { privateKey: b(RFC.senderPrivate) } },
    );
    expect(body.toString('base64url')).toBe(RFC.body);
    // Header: salt(16) | record size 4096 (4) | key id length 65 (1) | sender public key (65).
    expect(body.subarray(0, 16).toString('base64url')).toBe(RFC.salt);
    expect([...body.subarray(16, 21)]).toEqual([0, 0, 0x10, 0, 65]);
    expect(body.subarray(21, 86).toString('base64url')).toBe(RFC.senderPublic);
  });

  test('a browser decrypts it, and each message uses a new key and salt', () => {
    const browser = newBrowser();
    const request = () =>
      buildPushRequest(browser, JSON.stringify({ title: 'a' }), vapid(), {
        now: new Date('2026-10-22T00:00:00Z'),
        ttlSeconds: 120,
      });
    const first = request();
    const second = request();
    expect(browser.decrypt(first)).toEqual({ title: 'a' });
    expect(Buffer.from(first.body).equals(Buffer.from(second.body))).toBe(false);
    expect(
      Buffer.from(first.body).subarray(0, 16).equals(Buffer.from(second.body).subarray(0, 16)),
    ).toBe(false);
  });

  test('refuses a payload that does not fit one record', () => {
    const browser = newBrowser();
    expect(() => encryptPayload(Buffer.alloc(4079), browser)).not.toThrow();
    expect(() => encryptPayload(Buffer.alloc(4080), browser)).toThrow('payload too large');
  });
});

function vapid() {
  return { ...generateVapidKeys(), subject: 'mailto:owner@example.test' };
}

describe('VAPID (RFC 8292)', () => {
  const now = new Date('2026-10-22T00:00:00Z');

  test('the token is ES256 with a raw (r||s) signature that the public key verifies', () => {
    const keys = vapid();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match as RegExpExecArray;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(h ?? '').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(b(c ?? '').toString()) as { aud: string; exp: number; sub: string };
    // The audience is the push service's origin, not the full endpoint.
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:owner@example.test');
    const nowSeconds = now.getTime() / 1000;
    expect(claims.exp).toBeGreaterThan(nowSeconds);
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds + 24 * 3600);
    const point = b(keys.publicKey);
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const signature = b(s ?? '');
    expect(signature.length).toBe(64);
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });

  test('the request carries the headers a push service needs', () => {
    const browser = newBrowser('updates.push.services.mozilla.com');
    const request = buildPushRequest(browser, '{}', vapid(), { now, ttlSeconds: 120 });
    expect(request.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '120',
      urgency: 'high',
      'content-length': String(request.body.length),
    });
    expect(request.headers.authorization).toMatch(/^vapid t=/);
    expect(request.endpoint).toBe(browser.endpoint);
  });

  test('a request to an endpoint outside the allow-list is never built', () => {
    expect(() =>
      buildPushRequest(
        { endpoint: 'https://example.com/x', p256dh: 'x', auth: 'y' },
        '{}',
        vapid(),
        {
          now,
          ttlSeconds: 120,
        },
      ),
    ).toThrow('endpoint not allowed');
  });
});

describe('keys', () => {
  test('a generated pair is 65 and 32 bytes in base64url, and the public key follows from the private one', () => {
    const keys = generateVapidKeys();
    expect(b(keys.publicKey).length).toBe(65);
    expect(b(keys.publicKey)[0]).toBe(0x04);
    expect(b(keys.privateKey).length).toBe(32);
    expect(keys.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(vapidPublicKeyOf(keys.privateKey)).toBe(keys.publicKey);
    expect(vapidPublicKeyOf('short')).toBeNull();
    // About 1 key in 256 has a leading zero byte; every pair must still be 32 bytes and match.
    for (let i = 0; i < 600; i += 1) {
      const k = generateVapidKeys();
      expect(b(k.privateKey).length).toBe(32);
      expect(vapidPublicKeyOf(k.privateKey)).toBe(k.publicKey);
    }
  });

  test('a subscriber key must be a point on the curve', () => {
    expect(isValidSubscriberKey(newBrowser().p256dh)).toBe(true);
    expect(isValidSubscriberKey(`B${'A'.repeat(86)}`)).toBe(false);
    expect(isValidSubscriberKey('not-a-key')).toBe(false);
  });
});
