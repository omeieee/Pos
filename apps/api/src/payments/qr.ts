/**
 * The PromptPay QR picture and the short-lived link that lets an `<img>` fetch it.
 *
 * An `<img>` cannot send an Authorization header, so the link carries its own proof: an HMAC over
 * the payment id and an expiry, keyed from AUTH_SECRET_KEY (HKDF, `qrUrlKey`). The link says
 * nothing about the amount or the PromptPay ID, and the picture is rebuilt from the CURRENT
 * setting every time it is served (never from a stored payload), so a changed ID shows at once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

/** A link lives five minutes; the staff app asks for a new one whenever it shows the QR. */
export const QR_URL_TTL_SECONDS = 300;

/** Quiet zone of 4 modules (the QR specification), 8 px per module, medium error correction. */
export const QR_PNG_OPTIONS = {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 4,
  scale: 8,
} as const;

const mac = (key: Buffer, paymentId: string, expiresAt: number) =>
  createHmac('sha256', key).update(`payment-qr:${paymentId}:${expiresAt}`).digest();

/** Signature as base64url (43 characters). `expiresAt` is whole seconds since the epoch. */
export function signQrLink(key: Buffer, paymentId: string, expiresAt: number): string {
  return mac(key, paymentId, expiresAt).toString('base64url');
}

export type QrLinkCheck = 'ok' | 'invalid' | 'expired';

/** The signature is checked first (in constant time); only a genuine link can be called expired. */
export function checkQrLink(
  key: Buffer,
  paymentId: string,
  expiresAt: number,
  signature: string,
  nowSeconds: number,
): QrLinkCheck {
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, paymentId, expiresAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  return nowSeconds > expiresAt ? 'expired' : 'ok';
}

export function qrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, { ...QR_PNG_OPTIONS });
}
