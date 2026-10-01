import { describe, expect, test } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  timeStep,
  totpAt,
  verifyTotp,
} from './totp.ts';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", 8-digit codes.
const RFC_SEED = Buffer.from('12345678901234567890');
const RFC_VECTORS: [seconds: number, code8: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP against the RFC 6238 test vectors (HMAC-SHA1, 30 s)', () => {
  test.each(RFC_VECTORS)('8 digits at %i s is %s', (seconds, code8) => {
    expect(totpAt(RFC_SEED, seconds, 8)).toBe(code8);
  });

  test.each(RFC_VECTORS)('6 digits at %i s is the last six of %s', (seconds, code8) => {
    expect(totpAt(RFC_SEED, seconds, 6)).toBe(code8.slice(2));
  });

  test('the time step is floor(seconds / 30)', () => {
    expect(timeStep(59_000)).toBe(1);
    expect(timeStep(60_000)).toBe(2);
    expect(timeStep(1111111109_000)).toBe(0x23523ec);
  });
});

describe('HOTP against the RFC 4226 test vectors', () => {
  const rfc4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583'];
  test.each(rfc4226.map((code, counter) => [counter, code] as const))(
    'counter %i gives %s',
    (counter, code) => {
      expect(hotp(RFC_SEED, counter, 6)).toBe(code);
    },
  );
});

describe('verifyTotp', () => {
  const secret = RFC_SEED;
  const at = 1111111111_000; // step 0x23523ED
  const stepNow = timeStep(at);
  const codeAt = (step: number) => hotp(secret, step, 6);

  test('accepts the current code and reports its step', () => {
    expect(verifyTotp(secret, codeAt(stepNow), at)).toEqual({ ok: true, step: stepNow });
  });

  test('accepts one step either side (clock drift) and reports the matched step', () => {
    expect(verifyTotp(secret, codeAt(stepNow - 1), at)).toEqual({ ok: true, step: stepNow - 1 });
    expect(verifyTotp(secret, codeAt(stepNow + 1), at)).toEqual({ ok: true, step: stepNow + 1 });
  });

  test('refuses two steps away', () => {
    expect(verifyTotp(secret, codeAt(stepNow - 2), at).ok).toBe(false);
    expect(verifyTotp(secret, codeAt(stepNow + 2), at).ok).toBe(false);
  });

  test('refuses a wrong code and anything that is not six digits', () => {
    const right = codeAt(stepNow);
    const wrong = right === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong, at).ok).toBe(false);
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', right.slice(0, 5)]) {
      expect(verifyTotp(secret, bad, at).ok).toBe(false);
    }
  });

  test('refuses a code made for another secret', () => {
    const other = Buffer.from('another secret!!!!!!');
    expect(verifyTotp(secret, hotp(other, stepNow, 6), at).ok).toBe(false);
  });
});

describe('base32 (RFC 4648, unpadded)', () => {
  test.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %s', (text, encoded) => {
    expect(base32Encode(Buffer.from(text))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(text);
  });

  test('decodes lower case and padding, and refuses other characters', () => {
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW6!')).toThrow();
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('secret and otpauth URI', () => {
  test('a new secret is 160 random bits', () => {
    const a = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(a.equals(generateTotpSecret())).toBe(false);
  });

  test('the URI carries the secret, issuer and the fixed parameters', () => {
    const secret = Buffer.from('12345678901234567890');
    const uri = otpauthUri({ secret, account: 'owner@example.com', issuer: 'Saap Don Sen POS' });
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.hostname).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Saap Don Sen POS:owner@example.com');
    expect(url.searchParams.get('secret')).toBe(base32Encode(secret));
    expect(url.searchParams.get('issuer')).toBe('Saap Don Sen POS');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
