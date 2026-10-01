import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type AuthKeys,
  burnPasswordCheck,
  burnPinCheck,
  decryptSecret,
  deriveAuthKeys,
  encryptSecret,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  hashToken,
  newRecoveryCodes,
  newToken,
  normalizeRecoveryCode,
  verifyPassword,
  verifyPin,
} from './crypto.ts';

// Test-only keys, not secrets.
const keys: AuthKeys = deriveAuthKeys(Buffer.alloc(32, 7));
const otherKeys: AuthKeys = deriveAuthKeys(Buffer.alloc(32, 8));

describe('tokens', () => {
  test('are unguessable, prefixed and unique', () => {
    const a = newToken('sds_ses');
    const b = newToken('sds_ses');
    expect(a).toMatch(/^sds_ses_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(newToken('sds_dev')).toMatch(/^sds_dev_/);
  });

  test('are stored as a SHA-256 hash that is stable and does not contain the token', () => {
    const token = newToken('sds_dev');
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(8));
    expect(hashToken(`${token}x`)).not.toBe(hash);
  });
});

describe('key derivation', () => {
  test('is deterministic and gives separate keys per purpose', () => {
    const again = deriveAuthKeys(Buffer.alloc(32, 7));
    expect(again.totpKey.equals(keys.totpKey)).toBe(true);
    expect(keys.totpKey).toHaveLength(32);
    expect(keys.totpKey.equals(keys.pinPepper)).toBe(false);
    expect(otherKeys.totpKey.equals(keys.totpKey)).toBe(false);
  });

  test('rejects a master key that is not 32 bytes', () => {
    expect(() => deriveAuthKeys(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('password hashing (scrypt)', () => {
  test('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  test('uses a random salt and records its parameters, never the password', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password 123'),
      hashPassword('same password 123'),
    ]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$\d+\$8\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('same password');
  });

  test('refuses malformed or hostile stored hashes instead of throwing', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$x$8$1$aa$bb',
      'scrypt$16384$8$1$$',
      // Parameters far above the allowed bound would exhaust memory.
      'scrypt$1073741824$8$1$c2FsdA$aGFzaA',
      'bcrypt$16384$8$1$c2FsdA$aGFzaA',
    ]) {
      expect(await verifyPassword(bad, 'whatever')).toBe(false);
    }
  });
});

describe('PIN hashing (scrypt with a server-side pepper)', () => {
  test('verifies the right PIN and refuses wrong ones', async () => {
    const hash = await hashPin('4821', keys);
    expect(await verifyPin(hash, '4821', keys)).toBe(true);
    expect(await verifyPin(hash, '4822', keys)).toBe(false);
    expect(await verifyPin(hash, '482', keys)).toBe(false);
  });

  test('a database copy alone is not enough: the hash does not verify under another key', async () => {
    const hash = await hashPin('4821', keys);
    expect(await verifyPin(hash, '4821', otherKeys)).toBe(false);
  });

  test('the same PIN hashes differently each time (random salt)', async () => {
    expect(await hashPin('4821', keys)).not.toBe(await hashPin('4821', keys));
  });

  test('burn checks run a full hash and never succeed', async () => {
    expect(await burnPinCheck('1234', keys)).toBe(false);
    expect(await burnPasswordCheck('anything')).toBe(false);
  });
});

describe('secret encryption (AES-256-GCM)', () => {
  const secret = Buffer.from('12345678901234567890');

  test('round-trips and does not contain the plaintext', () => {
    const blob = encryptSecret(secret, keys.totpKey, 'staff-1');
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain(secret.toString('base64url'));
    expect(decryptSecret(blob, keys.totpKey, 'staff-1').equals(secret)).toBe(true);
  });

  test('uses a fresh IV every time', () => {
    expect(encryptSecret(secret, keys.totpKey, 'a')).not.toBe(
      encryptSecret(secret, keys.totpKey, 'a'),
    );
  });

  test('fails for the wrong key, a different row (associated data) or tampering', () => {
    const blob = encryptSecret(secret, keys.totpKey, 'staff-1');
    expect(() => decryptSecret(blob, otherKeys.totpKey, 'staff-1')).toThrow();
    expect(() => decryptSecret(blob, keys.totpKey, 'staff-2')).toThrow();
    const [v, iv, ct, tag] = blob.split('.');
    const flipped = Buffer.from(ct ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      decryptSecret([v, iv, flipped.toString('base64url'), tag].join('.'), keys.totpKey, 'staff-1'),
    ).toThrow();
  });

  test('rejects an unknown version or a malformed blob', () => {
    expect(() => decryptSecret('v9.a.b.c', keys.totpKey, 'x')).toThrow(/format/);
    expect(() => decryptSecret('nonsense', keys.totpKey, 'x')).toThrow(/format/);
  });
});

describe('recovery codes', () => {
  test('are grouped, unique and drawn from an unambiguous alphabet', () => {
    const codes = newRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  });

  test('are compared after normalising case, spaces and dashes', () => {
    expect(normalizeRecoveryCode(' abcd-efgh jklm-npqr ')).toBe('ABCDEFGHJKLMNPQR');
    expect(hashRecoveryCode('abcd-efgh-jklm-npqr')).toBe(hashRecoveryCode('ABCDEFGHJKLMNPQR'));
  });

  test('carry 80 bits: 16 symbols from an alphabet of 32', () => {
    const symbols = newRecoveryCodes(1)[0]?.replaceAll('-', '') ?? '';
    expect(symbols).toHaveLength(16);
    expect(16 * Math.log2(32)).toBe(80);
  });

  test('are stored as a plain SHA-256, so recovery still works when AUTH_SECRET_KEY is lost', () => {
    const code = 'ABCD-EFGH-JKLM-NPQR';
    const stored = hashRecoveryCode(code);
    expect(stored).toBe(createHash('sha256').update('ABCDEFGHJKLMNPQR').digest('hex'));
    // The function takes no key at all: nothing here can depend on AUTH_SECRET_KEY.
    expect(hashRecoveryCode.length).toBe(1);
  });
});
