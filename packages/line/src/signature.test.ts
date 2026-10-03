import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifySignature } from './signature.ts';

// Fake values for tests only.
const SECRET = 'test-channel-secret-not-real';
const BODY = '{"destination":"Utest","events":[]}';
const sign = (body: string | Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64');

describe('verifySignature', () => {
  test('accepts a valid signature over the raw body (string or Buffer)', () => {
    expect(verifySignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifySignature(Buffer.from(BODY), sign(BODY), SECRET)).toBe(true);
  });

  test('accepts a Thai body signed as UTF-8 bytes', () => {
    const body = Buffer.from('{"text":"สั่งก๋วยเตี๋ยว"}', 'utf8');
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const tampered = BODY.replace('Utest', 'Uevil');
    expect(verifySignature(tampered, sign(BODY), SECRET)).toBe(false);
  });

  test('rejects a wrong secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'other-secret'), SECRET)).toBe(false);
  });

  test('re-serialised JSON (different whitespace) fails: the raw body is required', () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifySignature(pretty, sign(BODY), SECRET)).toBe(false);
  });

  test('rejects missing, empty, array, short, long and non-base64 headers without throwing', () => {
    const good = sign(BODY);
    for (const header of [
      undefined,
      '',
      [good, good],
      good.slice(0, 20),
      `${good}AAAA`,
      `${good.slice(0, 42)}!`,
      ' '.repeat(44),
    ]) {
      expect(verifySignature(BODY, header, SECRET)).toBe(false);
    }
  });

  test('rejects everything when the secret is empty', () => {
    expect(verifySignature(BODY, sign(BODY, ''), '')).toBe(false);
  });
});
