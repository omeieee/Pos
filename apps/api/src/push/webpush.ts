/**
 * Web Push over node:crypto, with no library (decision D-37): VAPID (RFC 8292, ES256) to say who
 * is sending, and the `aes128gcm` content encoding (RFC 8291, with RFC 8188 framing) so only the
 * subscribed browser can read the message. One record, one small JSON payload.
 *
 * Everything here is pure except `createFetchTransport`. A subscription's endpoint and keys are
 * credentials-like: nothing in this file logs them or puts them in an error message.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { isAllowedPushEndpoint } from '@sds/shared';

/** The VAPID identity of this server. `privateKey` is a secret. */
export interface VapidConfig {
  /** base64url, 65 bytes (uncompressed P-256 point): the browser's `applicationServerKey`. */
  publicKey: string;
  /** base64url, 32 bytes. */
  privateKey: string;
  /** `mailto:` or `https:` contact the push services may use to reach the sender. */
  subject: string;
}

/** What goes on the wire to a push service. */
export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Sends one request and answers with the HTTP status; throws on a network error or when `signal` aborts. */
export type PushTransport = (
  request: PushRequest,
  signal: AbortSignal,
) => Promise<{ status: number }>;

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const RECORD_SIZE = 4096;
/** One record holds `RECORD_SIZE - 16` bytes of ciphertext, of which 1 is the delimiter. */
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 16 - 1;
const UNCOMPRESSED_POINT_BYTES = 65;
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64 = (text: string): Buffer => Buffer.from(text, 'base64url');

// ---------- Keys ----------

/** A new VAPID key pair, both as base64url (the format browsers and `web-push` use). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes (about 1 key in 256): pad back to the fixed 32.
  const privateKey = Buffer.alloc(32);
  ecdh.getPrivateKey().copy(privateKey, 32 - ecdh.getPrivateKey().length);
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(privateKey) };
}

/** The public key that belongs to a base64url private key, or null when it is not a valid one. */
export function vapidPublicKeyOf(privateKey: string): string | null {
  try {
    const bytes = fromB64(privateKey);
    if (bytes.length !== 32) return null;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(bytes);
    return b64(ecdh.getPublicKey());
  } catch {
    return null;
  }
}

/** True when the browser's public key is a point on the curve (a bad one would fail only at send time). */
export function isValidSubscriberKey(p256dh: string): boolean {
  try {
    const point = fromB64(p256dh);
    if (point.length !== UNCOMPRESSED_POINT_BYTES || point[0] !== 0x04) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

// ---------- VAPID (RFC 8292) ----------

/** The `Authorization` header value: `vapid t=<signed token>, k=<public key>`. */
export function vapidAuthorization(endpoint: string, vapid: VapidConfig, now: Date): string {
  const audience = new URL(endpoint).origin;
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now.getTime() / 1000) + VAPID_JWT_LIFETIME_SECONDS,
        sub: vapid.subject,
      }),
    ),
  );
  const publicPoint = fromB64(vapid.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: b64(publicPoint.subarray(1, 33)),
      y: b64(publicPoint.subarray(33, 65)),
    },
    format: 'jwk',
  });
  // ES256 wants the raw r||s signature, not the DER one node returns by default.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${vapid.publicKey}`;
}

// ---------- Message encryption (RFC 8291) ----------

export interface EncryptOptions {
  /** Tests inject the salt and the sender's one-off key to reproduce the RFC's example. */
  salt?: Buffer;
  senderKey?: { privateKey: Buffer };
}

/**
 * The full `aes128gcm` body for one subscriber: salt(16) | record size(4) | key id length(1) |
 * sender public key(65) | ciphertext. The sender key is new for every message.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  subscriber: { p256dh: string; auth: string },
  options: EncryptOptions = {},
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('payload too large');
  const subscriberPoint = fromB64(subscriber.p256dh);
  const authSecret = fromB64(subscriber.auth);
  const salt = options.salt ?? randomBytes(16);

  const sender = createECDH('prime256v1');
  if (options.senderKey) sender.setPrivateKey(options.senderKey.privateKey);
  else sender.generateKeys();
  const senderPoint = sender.getPublicKey();
  const shared = sender.computeSecret(subscriberPoint);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPoint, senderPoint]);
  // hkdfSync does extract (salt, input) then expand (info, length) in one call.
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (here the only) record.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([senderPoint.length]), senderPoint, sealed]);
}

// ---------- The request ----------

export interface BuildRequestOptions {
  now: Date;
  /** How long the push service may hold the message while the device is offline. */
  ttlSeconds: number;
}

/** Throws when the endpoint is not an allowed push service (the caller then drops the subscription). */
export function buildPushRequest(
  subscription: PushSubscriptionKeys,
  message: string,
  vapid: VapidConfig,
  options: BuildRequestOptions,
): PushRequest {
  if (!isAllowedPushEndpoint(subscription.endpoint)) throw new Error('endpoint not allowed');
  const body = encryptPayload(Buffer.from(message, 'utf8'), subscription);
  return {
    endpoint: subscription.endpoint,
    headers: {
      authorization: vapidAuthorization(subscription.endpoint, vapid, options.now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ttl: String(options.ttlSeconds),
      urgency: 'high',
    },
    body,
  };
}

/**
 * The real transport: one POST, no redirects (a redirect would walk past the host allow-list),
 * aborted by `signal`. The response body is not read.
 */
export function createFetchTransport(): PushTransport {
  return async (request, signal) => {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal,
    });
    void response.body?.cancel().catch(() => {});
    return { status: response.status };
  };
}
