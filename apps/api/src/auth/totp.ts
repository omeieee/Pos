/**
 * TOTP (RFC 6238) on node:crypto: HMAC-SHA1, 30 s steps, 6 digits, accepting one step either
 * side. HOTP is RFC 4226 section 5.3 (dynamic truncation). Tested against the RFC vectors.
 *
 * Replay protection (a code works once) is not here: the caller stores the matched step and
 * refuses any step that is not newer (authRepo.claimTotpStep).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted before and after the current one (clock drift). */
export const TOTP_WINDOW = 1;

export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = (hmac[19] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(unixMs: number): number {
  return Math.floor(unixMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for a Unix time in seconds (used by tests and the CLI's enrolment check). */
export function totpAt(secret: Buffer, unixSeconds: number, digits: number = TOTP_DIGITS): string {
  return hotp(secret, Math.floor(unixSeconds / TOTP_PERIOD_SECONDS), digits);
}

export type TotpResult = { ok: true; step: number } | { ok: false };

export function verifyTotp(secret: Buffer, code: string, nowMs: number): TotpResult {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = timeStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | undefined;
  // No early exit: every candidate step is compared.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given)) matched = step;
  }
  return matched === undefined ? { ok: false } : { ok: true, step: matched };
}

// ---------- Secret and enrolment URI ----------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError('not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** The otpauth:// URI that authenticator apps read from a QR code or accept pasted. */
export function otpauthUri(o: { secret: Buffer; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(o.secret),
    issuer: o.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
