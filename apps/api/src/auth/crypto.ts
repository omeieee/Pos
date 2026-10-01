/**
 * Credential cryptography on node:crypto only (no native dependencies; the VM has 1 GB RAM).
 *
 * - Tokens: 256 random bits, stored as SHA-256 (they are high-entropy, so a fast hash is right).
 * - Passwords and PINs: scrypt with the parameters recorded in the stored string. PINs are
 *   first run through HMAC-SHA-256 with a server-side pepper, because a 4–6 digit PIN can be
 *   brute-forced from a stolen database copy whatever the hash. Online guessing is stopped by
 *   the lockout (policy.ts), offline guessing by the pepper.
 * - Stored TOTP secrets: AES-256-GCM, with the staff id as associated data.
 * - Recovery codes: plain SHA-256 with NO key, so they still work when the master key is lost.
 *
 * One master key (AUTH_SECRET_KEY) feeds HKDF to give the TOTP encryption, the PIN pepper and
 * the QR link signing their own keys.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

// ---------- Tokens ----------

export type TokenPrefix = 'sds_dev' | 'sds_ses';

/** A new opaque bearer token. The prefix only helps people and secret scanners recognise it. */
export function newToken(prefix: TokenPrefix): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------- Keys ----------

export interface AuthKeys {
  /** AES-256-GCM key for stored TOTP secrets. */
  totpKey: Buffer;
  /** HMAC key mixed into PIN hashes. */
  pinPepper: Buffer;
  /** HMAC key that signs the short-lived PromptPay QR image links. */
  qrUrlKey: Buffer;
}

const HKDF_SALT = Buffer.from('sds-auth-v1');

function derive(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, HKDF_SALT, purpose, 32));
}

export function deriveAuthKeys(master: Buffer): AuthKeys {
  if (master.length !== 32) throw new RangeError('the auth master key must be 32 bytes');
  return {
    totpKey: derive(master, 'totp-encryption'),
    pinPepper: derive(master, 'pin-pepper'),
    qrUrlKey: derive(master, 'payment-qr-url'),
  };
}

// ---------- scrypt (passwords and PINs) ----------

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP-listed equivalent of N=2^17: 32 MiB of memory, three lanes. Used for owner passwords. */
const PASSWORD_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };
/** 16 MiB. PINs are peppered and rate-limited, so they use the cheaper setting. */
const PIN_PARAMS: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Upper bounds for parameters read back from the database, so a damaged row cannot ask for gigabytes.
const MAX_N = 2 ** 17;
const MAX_R = 8;
const MAX_P = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

function scryptAsync(secret: string, salt: Buffer, keyLength: number, params: ScryptParams) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      secret,
      salt,
      keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

async function hashWith(secret: string, params: ScryptParams): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(secret, salt, KEY_LENGTH, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [parts[1], parts[2], parts[3]].map((v) => Number(v));
  if (!N || !r || !p || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  const isPowerOfTwo = N > 1 && (N & (N - 1)) === 0;
  if (!isPowerOfTwo || N > MAX_N || r > MAX_R || p > MAX_P) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const key = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;
  return { params: { N, r, p }, salt, key };
}

async function verifyWith(stored: string, secret: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const derived = await scryptAsync(secret, parsed.salt, parsed.key.length, parsed.params);
  return timingSafeEqual(derived, parsed.key);
}

export function hashPassword(password: string): Promise<string> {
  return hashWith(password.normalize('NFKC'), PASSWORD_PARAMS);
}

export function verifyPassword(stored: string, password: string): Promise<boolean> {
  return verifyWith(stored, password.normalize('NFKC'));
}

const pepperPin = (pin: string, keys: AuthKeys) =>
  createHmac('sha256', keys.pinPepper).update(pin).digest('hex');

export function hashPin(pin: string, keys: AuthKeys): Promise<string> {
  return hashWith(pepperPin(pin, keys), PIN_PARAMS);
}

export function verifyPin(stored: string, pin: string, keys: AuthKeys): Promise<boolean> {
  return verifyWith(stored, pepperPin(pin, keys));
}

// Unknown accounts still pay for one hash, so response time does not reveal which ids exist.
let dummyPassword: Promise<string> | undefined;
const dummyPins = new WeakMap<AuthKeys, Promise<string>>();

export async function burnPasswordCheck(password: string): Promise<false> {
  dummyPassword ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyPassword, password);
  return false;
}

export async function burnPinCheck(pin: string, keys: AuthKeys): Promise<false> {
  let dummy = dummyPins.get(keys);
  if (!dummy) {
    dummy = hashPin(randomBytes(4).toString('hex'), keys);
    dummyPins.set(keys, dummy);
  }
  await verifyPin(await dummy, pin, keys);
  return false;
}

// ---------- AES-256-GCM for stored secrets ----------

const VERSION = 'v1';

/** `v1.<iv>.<ciphertext>.<tag>` (base64url). The version leaves room for key rotation. */
export function encryptSecret(plain: Buffer, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): Buffer {
  const [version, iv, ciphertext, tag, ...rest] = blob.split('.');
  if (version !== VERSION || !iv || !ciphertext || !tag || rest.length > 0) {
    throw new Error('unrecognised secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
}

// ---------- Recovery codes ----------

// 32 symbols without 0/1/I/O, so five random bits map to one symbol with no bias.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `count` codes of 80 random bits each, written as XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCodes(count: number): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(16);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31]).join('');
    return chars.match(/.{4}/g)?.join('-') ?? chars;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
}

/**
 * A plain SHA-256 on purpose, with no key. A code has 80 random bits, so a fast hash cannot be
 * brute-forced, and recovery must keep working when AUTH_SECRET_KEY is lost or changed: that is
 * exactly when the owner needs it.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}
